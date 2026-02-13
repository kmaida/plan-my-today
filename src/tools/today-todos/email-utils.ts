import { getLogger } from "../../observability/logger";
import { AuthenticationError } from "../../utils/error-utils";
import type { DocCommentEmail } from "./drive-comments-utils";
import { calculateRecencyBoost, categorizeScore, type PriorityMetadata } from "./priority-utils";
import type { GmailMessageDetail, MeetingSummaryDetail } from "./types";

// ── Gmail full message type ──────────────────────────────────────────────────
// The Gmail API returns payload.body and payload.parts for the full message
// body. We use this to extract comment URLs from doc comment notification
// emails before reducing messages to the lighter GmailMessageDetail shape.

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

export interface GmailFullMessage {
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
    body?: { data?: string; size?: number };
    parts?: GmailMessagePart[];
    mimeType?: string;
  };
  snippet?: string;
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
}

// ── Shared patterns for email classification ──────────────────────────────────
// Defined once, reused across isFromIndividual, isNewsletter, isLowImportance,
// and filterEmails to avoid duplication and keep detection logic consistent.

const AUTOMATED_FROM_PATTERNS = [
  /noreply/i,
  /no-reply/i,
  /donotreply/i,
  /don't reply/i,
  /do-not-reply/i,
  /notifications?@/i,
  /notify@/i,
  /automated@/i,
  /system@/i,
  /mailer-daemon/i,
  /postmaster@/i,
  /support@/i,
  /billing@/i,
  /accounts?@/i,
  /security@/i,
  /alerts?@/i,
  /updates?@/i,
  /receipts?@/i,
  /orders?@/i,
  /subscriptions?@/i,
  /feedback@/i,
];

const AUTOMATED_DOMAINS = [
  "linear.app",
  "github.com",
  "zoom.us",
  "figma.com",
  "render.com",
  "n8n.cloud",
  "granola.so",
  "instatunnel.my",
  "google.com",
  "googlemail.com",
  "atlassian.net",
  "jira.com",
  "slack.com",
  "notion.so",
  "vercel.com",
  "netlify.com",
  "stripe.com",
  "intercom.io",
  "hubspot.com",
  "mailchimp.com",
  "sendgrid.net",
  "amazonses.com",
  "postmarkapp.com",
];

const AUTOMATED_SUBJECT_PATTERNS = [
  /your (trial|subscription|account|order|payment|invoice|receipt|password|plan)/i,
  /trial (end|expir|cancel)/i,
  /subscription (end|expir|cancel|renew)/i,
  /password (reset|changed|expired)/i,
  /verify your/i,
  /confirm your/i,
  /welcome to/i,
  /thanks for (signing|registering|subscribing|joining|purchasing|ordering)/i,
  /thank you for your (order|purchase|payment)/i,
  /has been (shipped|delivered|processed|approved|declined|canceled|cancelled)/i,
  /security alert/i,
  /login attempt/i,
  /sign.?in (from|attempt|notification)/i,
  /new device/i,
  /two.?factor/i,
  /verification code/i,
  /notification/i,
  /has joined your meeting/i,
  /has invited you/i,
];

const CALENDAR_SUBJECT_PATTERNS = [
  /^accepted:/i,
  /^invitation:/i,
  /^canceled event:/i,
  /^declined:/i,
  /^tentative:/i,
  /google calendar/i,
  /calendar event/i,
];

const NEWSLETTER_SUBJECT_PATTERNS = [
  /newsletter/i,
  /weekly digest/i,
  /monthly digest/i,
  /daily digest/i,
  /roundup/i,
  /round-up/i,
  /unsubscribe/i,
  /view in browser/i,
  /view this email/i,
  /marketing/i,
  /promotion/i,
  /special offer/i,
  /limited time/i,
  /act now/i,
  /don't miss/i,
  /exclusive/i,
  /sale/i,
  /discount/i,
  /coupon/i,
];

const NEWSLETTER_FROM_PATTERNS = [
  /newsletter/i,
  /marketing/i,
  /news@/i,
  /info@/i,
  /team@/i,
  /hello@/i,
  /hi@/i,
];

/**
 * Checks if the from address is from a calendar notification
 */
function isCalendarEmail(fromLower: string, subjectLower: string): boolean {
  if (fromLower.includes("calendar") || fromLower.includes("calendar-notification")) {
    return true;
  }
  if (subjectLower.includes("calendar") && fromLower.includes("google")) {
    return true;
  }
  return CALENDAR_SUBJECT_PATTERNS.some((p) => p.test(subjectLower));
}

/**
 * Extracts the email domain from a "from" string
 */
function extractDomain(fromLower: string): string | undefined {
  return fromLower.match(/@([^\s>]+)/)?.[1];
}

/**
 * Determines if an email is from an individual (not an automated system).
 * Errs on the side of "not individual" to avoid flagging automated messages
 * as needing replies.
 */
export function isFromIndividual(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();

  // Automated sender address patterns
  if (AUTOMATED_FROM_PATTERNS.some((pattern) => pattern.test(fromLower))) {
    return false;
  }

  // Calendar emails are always automated
  if (isCalendarEmail(fromLower, subjectLower)) {
    return false;
  }

  // Known automated service domains
  const emailDomain = extractDomain(fromLower);
  if (emailDomain && AUTOMATED_DOMAINS.some((domain) => emailDomain.includes(domain))) {
    return false;
  }

  // Automated subject patterns
  if (AUTOMATED_SUBJECT_PATTERNS.some((pattern) => pattern.test(subjectLower))) {
    return false;
  }

  // ── Positive signal: looks like a person's name ───────────────────────────
  // Patterns like "first.last@", "first_last@", or display name with spaces
  const namePattern = /^[a-z]+[._][a-z]+@/i;
  if (namePattern.test(fromLower)) {
    return true;
  }

  // Display name present (e.g., "Kim Maida <kim@example.com>")
  const hasDisplayName = /^[A-Z][a-z]+ [A-Z][a-z]+/.test(from.trim());
  if (hasDisplayName) {
    return true;
  }

  // Default: not enough signal to classify as individual
  return false;
}

/**
 * Determines if an email likely needs a reply.
 * Only flags emails from individuals — automated messages never "need a reply".
 */
export function emailNeedsReply(subject: string, from: string, isUnread: boolean): boolean {
  // Gate: automated emails never need a reply
  if (!isFromIndividual(from, subject)) {
    return false;
  }

  const subjectLower = subject.toLowerCase();

  // Direct ask keywords in subject from an individual
  const actionKeywords = [
    "action items",
    "action item",
    "can you",
    "could you",
    "would you",
    "follow up",
    "follow-up",
    "question",
    "?",
  ];

  if (actionKeywords.some((keyword) => subjectLower.includes(keyword))) {
    return true;
  }

  // Unread email from an individual likely needs a reply
  if (isUnread) {
    return true;
  }

  return false;
}

/**
 * Checks if email contains action items
 */
export function emailHasActionItems(subject: string): boolean {
  const subjectLower = subject.toLowerCase();
  const actionItemPatterns = [
    /action items?/i,
    /todo/i,
    /action required/i,
    /please/i,
    /urgent/i,
    /asap/i,
  ];
  return actionItemPatterns.some((pattern) => pattern.test(subjectLower));
}

/**
 * Determines if an email is a newsletter or marketing email.
 * Uses the shared pattern lists defined at the top of this file.
 */
export function isNewsletter(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();

  if (NEWSLETTER_SUBJECT_PATTERNS.some((p) => p.test(subjectLower))) {
    return true;
  }

  // Note: noreply/no-reply/donotreply are already caught by AUTOMATED_FROM_PATTERNS
  // in isFromIndividual. NEWSLETTER_FROM_PATTERNS only adds newsletter-specific senders.
  if (NEWSLETTER_FROM_PATTERNS.some((p) => p.test(fromLower))) {
    return true;
  }

  return false;
}

/**
 * Determines if an email looks unimportant (low priority).
 * Patterns like "automated" and "auto-reply" that also indicate non-individual
 * senders are intentionally duplicated here because this function serves a
 * different purpose: even if an email made it past the individual check,
 * these subject-line signals still indicate low importance.
 */
export function isLowImportance(from: string, subject: string, isImportant: boolean): boolean {
  // If marked as important by Gmail, keep it
  if (isImportant) {
    return false;
  }

  const subjectLower = subject.toLowerCase();

  const lowImportancePatterns = [
    /^re:/i,
    /^fwd:/i,
    /^fw:/i,
    /no action required/i,
    /for your information/i,
    /fyi/i,
    /read receipt/i,
    /delivery receipt/i,
    /out of office/i,
    /vacation notice/i,
    /auto-reply/i,
    /automatic reply/i,
  ];

  if (lowImportancePatterns.some((p) => p.test(subjectLower))) {
    // But allow if it's from an individual and has action items
    if (isFromIndividual(from, subject) && emailHasActionItems(subject)) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Detects if email is a Zoom meeting notes email
 */
export function isZoomMeetingNote(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();

  // Check from address
  if (!fromLower.includes("zoom.us") || !fromLower.includes("no-reply")) {
    return false;
  }

  // Check subject patterns
  const meetingNotePatterns = [
    /meeting (assets|summary|recording) for .+ (are|is) ready/i,
    /meeting notes for .+/i,
  ];

  return meetingNotePatterns.some((pattern) => pattern.test(subjectLower));
}

/**
 * Detects action items in email snippet
 */
export function snippetHasActionItems(snippet: string | undefined): boolean {
  if (!snippet) return false;

  const snippetLower = snippet.toLowerCase();

  // Action item keywords
  const actionKeywords = [
    "action item",
    "todo",
    "to do",
    "follow up",
    "follow-up",
    "assigned to",
    "@", // Mentions often indicate assignments
  ];

  return actionKeywords.some((keyword) => snippetLower.includes(keyword));
}

/**
 * Extracts meeting title from Zoom subject line
 */
export function extractZoomMeetingTitle(subject: string): string | null {
  const match = subject.match(/meeting (?:assets|summary|recording) for (.+?) (?:are|is) ready/i);
  return match ? match[1].trim() : null;
}

/**
 * Extracts recording link from email body
 */
export function extractRecordingLink(body: string): string | null {
  // Common Zoom recording URL patterns
  const zoomPatterns = [
    /https?:\/\/[a-z0-9-]+\.zoom\.us\/rec\/share\/[^\s"<>]+/i,
    /https?:\/\/[a-z0-9-]+\.zoom\.us\/rec\/play\/[^\s"<>]+/i,
    /https?:\/\/zoom\.us\/rec\/[^\s"<>]+/i,
  ];

  for (const pattern of zoomPatterns) {
    const match = body.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

/**
 * Extracts plain text body from Gmail message payload
 */
export function extractEmailBody(payload?: {
  parts?: Array<{
    mimeType?: string;
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
  }>;
  body?: { data?: string };
}): string {
  if (!payload) return "";

  // Check for plain text part
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64").toString("utf-8");
    }

    // Check for HTML part if no plain text
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
    }

    // Check nested parts (multipart/alternative)
    for (const part of payload.parts) {
      if (part.parts) {
        const nestedText = part.parts.find((p) => p.mimeType === "text/plain");
        if (nestedText?.body?.data) {
          return Buffer.from(nestedText.body.data, "base64").toString("utf-8");
        }
        const nestedHtml = part.parts.find((p) => p.mimeType === "text/html");
        if (nestedHtml?.body?.data) {
          return Buffer.from(nestedHtml.body.data, "base64").toString("utf-8");
        }
      }
    }
  }

  // Fall back to body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  return "";
}

/**
 * Fetches meeting summaries from Gmail (Zoom, Google Meet, etc.)
 * Separate from regular email fetching
 */
export async function fetchMeetingSummaries(
  accessToken: string,
  options: {
    daysBack?: number;
    maxResults?: number;
  } = {}
): Promise<MeetingSummaryDetail[]> {
  const { daysBack = 7, maxResults = 10 } = options;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const lookbackDate = new Date(today);
  lookbackDate.setDate(today.getDate() - daysBack);
  const afterDate = Math.floor(lookbackDate.getTime() / 1000);

  // Search specifically for Zoom meeting summaries
  const query = `from:zoom.us subject:"meeting assets" after:${afterDate}`;

  const messagesResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?` +
      new URLSearchParams({
        q: query,
        maxResults: maxResults.toString(),
      }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!messagesResponse.ok) {
    if (messagesResponse.status === 401 || messagesResponse.status === 403) {
      throw new AuthenticationError("Gmail", messagesResponse.status);
    }
    getLogger().withOperation("email_utils").warn("Gmail meeting summaries API error — returning empty results", {
      status: messagesResponse.status,
      statusText: messagesResponse.statusText,
    });
    return [];
  }

  const messagesData = (await messagesResponse.json()) as { messages?: Array<{ id: string }> };
  if (!messagesData.messages || messagesData.messages.length === 0) {
    return [];
  }

  // Fetch message details WITH FULL BODY to extract recording links
  const messagePromises = messagesData.messages.slice(0, maxResults).map((msg) =>
    fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }).then((r) => (r.ok ? r.json() : null))
  );

  const messages = (await Promise.all(messagePromises)).filter(Boolean) as Array<{
    payload?: {
      headers?: Array<{ name?: string; value?: string }>;
      parts?: Array<{
        mimeType?: string;
        body?: { data?: string };
        parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
      }>;
      body?: { data?: string };
    };
    snippet?: string;
    id: string;
    internalDate?: string;
  }>;

  const meetingSummaries: MeetingSummaryDetail[] = [];

  for (const message of messages) {
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

    const subject = getHeader("subject") || "";
    const from = getHeader("from") || "";
    const snippet = message.snippet || "";

    // Check if this is a Zoom meeting note
    if (!isZoomMeetingNote(from, subject)) {
      continue;
    }

    // Check if snippet has action items
    if (!snippetHasActionItems(snippet)) {
      continue; // Skip meeting summaries without action items
    }

    // Extract email body to find recording link
    const emailBody = extractEmailBody(message.payload);
    const recordingLink = extractRecordingLink(emailBody);

    meetingSummaries.push({
      platform: "zoom",
      meetingTitle: extractZoomMeetingTitle(subject),
      subject,
      timestamp: message.internalDate ? parseInt(message.internalDate, 10) : Date.now(),
      hasActionItems: true,
      snippet,
      link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
      recordingLink,
      from,
    });
  }

  return meetingSummaries;
}

/**
 * Filters out unwanted emails (calendar, Linear automated, newsletters, low importance).
 * Uses shared pattern constants and helpers defined at the top of this file.
 *
 * @param strictFiltering - If false, only excludes calendar and Linear automation (for agent use)
 */
export function filterEmails(
  emails: GmailMessageDetail[],
  strictFiltering: boolean = true
): GmailMessageDetail[] {
  return emails.filter((email) => {
    const fromLower = email.from.toLowerCase();
    const subjectLower = email.subject.toLowerCase();

    // ALWAYS exclude calendar emails (already integrated via calendar tool)
    if (isCalendarEmail(fromLower, subjectLower)) {
      return false;
    }

    // ALWAYS exclude Linear emails (already integrated via Linear tool).
    // All linear.app emails are automated notifications — there's no real
    // "personal email from linear.app" use case worth the fragile heuristic.
    const emailDomain = extractDomain(fromLower);
    if (emailDomain?.includes("linear.app")) {
      return false;
    }

    // Only apply these filters if strictFiltering is enabled
    if (strictFiltering) {
      if (isNewsletter(email.from, email.subject)) {
        return false;
      }

      if (isLowImportance(email.from, email.subject, email.isImportant ?? false)) {
        return false;
      }
    }

    return true;
  });
}

// ── Google Docs comment email extraction ─────────────────────────────────────

const DOC_COMMENT_SENDER = "comments-noreply@docs.google.com";

/**
 * Regex to find a direct-to-comment URL in an email body.
 * Matches: https://docs.google.com/document/d/{fileId}/comment?discussion={id}...
 * Also matches: https://docs.google.com/a/{domain}/document/d/{fileId}/...
 */
const DOC_COMMENT_URL_PATTERN =
  /https:\/\/docs\.google\.com\/(?:a\/[^/]+\/)?document\/d\/([^/\s"]+)\/[^\s"]*comment[^\s"]*/;

/**
 * Regex to extract doc title from a Google Docs comment notification subject.
 * Typical formats:
 *   "Ian Ornstein (via Google Docs) - My Document Title"
 *   "Re: Ian Ornstein (via Google Docs) - My Document Title"
 */
const DOC_COMMENT_SUBJECT_PATTERN = /(?:Re:\s*)?.*?\(via Google Docs\)\s*[-–]\s*(.+)/i;

/**
 * Decode base64url-encoded email body data from the Gmail API.
 * Gmail uses URL-safe base64 (- and _ instead of + and /).
 */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Recursively extract text content from a Gmail message payload.
 * Handles both simple (payload.body) and multipart (payload.parts) messages.
 */
function extractMessageBody(message: GmailFullMessage): string {
  const parts: string[] = [];

  function walkParts(part: GmailMessagePart): void {
    // Prefer text/html as it's more likely to contain full URLs
    if (part.body?.data && part.mimeType?.startsWith("text/")) {
      parts.push(decodeBase64Url(part.body.data));
    }
    if (part.parts) {
      for (const child of part.parts) {
        walkParts(child);
      }
    }
  }

  if (message.payload) {
    walkParts(message.payload as GmailMessagePart);
  }

  return parts.join("\n");
}

/**
 * Extract Google Docs comment notification emails from the full message list.
 *
 * Must be called BEFORE messages are reduced to GmailMessageDetail (which
 * discards the body). Identified comment emails are removed from the message
 * list so they flow into the docs pipeline instead of the email pipeline.
 *
 * Uses the email body (already present in the Gmail API response — no extra
 * API calls) to extract the direct-to-comment URL.
 *
 * @param messages - Full Gmail message objects (including payload.body/parts)
 * @returns commentEmails for the docs pipeline, and remainingMessages for the email pipeline
 */
export function extractDocCommentEmails(messages: GmailFullMessage[]): {
  commentEmails: DocCommentEmail[];
  remainingMessages: GmailFullMessage[];
} {
  const commentEmails: DocCommentEmail[] = [];
  const remainingMessages: GmailFullMessage[] = [];
  // Track by fileId to dedup multiple comment emails for the same doc
  const seenFileIds = new Map<string, DocCommentEmail>();

  for (const message of messages) {
    const headers = message.payload?.headers || [];
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value?.toLowerCase() || "";

    if (!from.includes(DOC_COMMENT_SENDER)) {
      remainingMessages.push(message);
      continue;
    }

    // This is a doc comment notification email — try to extract the comment URL
    const body = extractMessageBody(message);
    // Also check the snippet as a fallback
    const searchText = body || message.snippet || "";
    const urlMatch = searchText.match(DOC_COMMENT_URL_PATTERN);

    if (!urlMatch) {
      // Can't extract a file ID — let it fall through to normal email processing
      remainingMessages.push(message);
      continue;
    }

    const commentUrl = urlMatch[0];
    const fileId = urlMatch[1];

    // Extract title from subject
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const titleMatch = subject.match(DOC_COMMENT_SUBJECT_PATTERN);
    const fileTitle = titleMatch?.[1]?.trim() || subject || "Untitled";

    const emailTimestamp = message.internalDate ? parseInt(message.internalDate, 10) : undefined;

    // Dedup: keep the most recent comment email per doc
    const existing = seenFileIds.get(fileId);
    if (
      !existing ||
      (emailTimestamp && (!existing.emailTimestamp || emailTimestamp > existing.emailTimestamp))
    ) {
      const entry: DocCommentEmail = { fileId, fileTitle, commentUrl, emailTimestamp };
      seenFileIds.set(fileId, entry);
    }
  }

  // Collect deduped comment emails
  commentEmails.push(...seenFileIds.values());

  return { commentEmails, remainingMessages };
}

/**
 * Extract the display name from a Gmail "From" header.
 * "Ben Ornstein <ben@example.com>" → "Ben Ornstein"
 * "<ben@example.com>" → "ben@example.com"
 * "ben@example.com" → "ben@example.com"
 */
export function extractSenderName(from: string): string {
  // Match "Display Name <email>" format
  const match = from.match(/^(.+?)\s*<[^>]+>/);
  if (match) {
    const name = match[1].replace(/^["']|["']$/g, "").trim();
    if (name) return name;
    // Empty display name (e.g. " <user@example.com>") — fall through to bare email
  }
  // Match bare "<email>" format
  const bare = from.match(/<([^>]+)>/);
  if (bare) return bare[1];
  // Already just a name or email
  return from.trim();
}

/**
 * Collapse multiple messages from the same Gmail thread into one representative email.
 * Keeps the most recent message per thread, attaches a participant list and message count.
 * Messages without a threadId pass through unchanged.
 */
export function collapseByThread(emails: GmailMessageDetail[]): GmailMessageDetail[] {
  const threadGroups = new Map<string, GmailMessageDetail[]>();
  const noThread: GmailMessageDetail[] = [];

  for (const email of emails) {
    if (email.threadId) {
      const group = threadGroups.get(email.threadId);
      if (group) {
        group.push(email);
      } else {
        threadGroups.set(email.threadId, [email]);
      }
    } else {
      noThread.push(email);
    }
  }

  const collapsed: GmailMessageDetail[] = [];

  for (const [threadId, group] of threadGroups) {
    // Sort by timestamp descending — most recent first
    group.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const latest = group[0];

    // Collect unique sender names across all messages in the thread
    const senderNames = new Set<string>();
    for (const msg of group) {
      senderNames.add(extractSenderName(msg.from));
    }

    // Build the representative message from the latest in the thread
    collapsed.push({
      ...latest,
      // Use thread ID link so Gmail opens the full conversation
      link: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
      threadMessageCount: group.length,
      threadParticipants: Array.from(senderNames),
      // Merge boolean flags: true if ANY message in the thread has it
      isImportant: group.some((m) => m.isImportant),
      isStarred: group.some((m) => m.isStarred),
      needsReply: group.some((m) => m.needsReply),
      hasActionItems: group.some((m) => m.hasActionItems),
      isFromIndividual: group.some((m) => m.isFromIndividual),
    });
  }

  // Add back messages that had no threadId
  return [...collapsed, ...noThread];
}

/** Return shape for fetchGmailTodos — includes doc comment emails extracted from the Gmail results */
export interface FetchGmailTodosResult {
  emails: GmailMessageDetail[];
  docCommentEmails: DocCommentEmail[];
}

/**
 * Maps a full Gmail message object to the lighter GmailMessageDetail shape.
 * Discards the message body — only keeps headers and classification metadata.
 */
function mapToGmailMessageDetail(message: GmailFullMessage): GmailMessageDetail {
  const headers = message.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

  const subject = getHeader("subject") || "(No subject)";
  const from = getHeader("from") || "Unknown";
  const isUnread = message.labelIds?.includes("UNREAD") ?? false;
  const fromIndividual = isFromIndividual(from, subject);
  const needsReply = emailNeedsReply(subject, from, isUnread);
  const hasAction = emailHasActionItems(subject);

  return {
    id: message.id,
    threadId: message.threadId,
    subject,
    from,
    link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
    snippet: message.snippet,
    timestamp: message.internalDate ? parseInt(message.internalDate, 10) : undefined,
    isImportant: message.labelIds?.includes("IMPORTANT") ?? false,
    isStarred: message.labelIds?.includes("STARRED") ?? false,
    isFromIndividual: fromIndividual,
    needsReply,
    hasActionItems: hasAction,
  };
}

/**
 * Fetches Gmail todos and extracts Google Docs comment notification emails.
 *
 * Doc comment emails (from comments-noreply@docs.google.com) are extracted
 * from the full message list BEFORE filtering, since they'd otherwise be
 * discarded as automated emails. They're returned separately so the docs
 * pipeline can verify them against the Drive v3 API.
 *
 * @param accessToken - Gmail access token
 * @param options - Optional configuration
 * @param options.daysBack - Number of days to look back (default: 7, agent: 14)
 * @param options.maxResults - Maximum emails to return (default: 20, agent: 30-40)
 * @param options.includeRead - Include recent read emails (default: false, agent: true)
 * @param options.strictFiltering - Apply strict filtering for newsletters/low-priority (default: true, agent: false)
 * @returns emails for the email pipeline, and docCommentEmails for the docs pipeline
 */
export async function fetchGmailTodos(
  accessToken: string,
  options: {
    daysBack?: number;
    maxResults?: number;
    includeRead?: boolean;
    strictFiltering?: boolean;
  } = {}
): Promise<FetchGmailTodosResult> {
  // Defaults: backward compatible with existing behavior
  const { daysBack = 7, maxResults = 20, includeRead = false, strictFiltering = true } = options;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Look back based on daysBack parameter
  const lookbackDate = new Date(today);
  lookbackDate.setDate(today.getDate() - daysBack);
  const afterDate = Math.floor(lookbackDate.getTime() / 1000);

  // Build query based on includeRead option
  let query: string;
  if (includeRead) {
    // Include starred + unread + recent read (last 3 days)
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    const recentDate = Math.floor(threeDaysAgo.getTime() / 1000);
    query = `(is:starred OR is:unread OR after:${recentDate}) -label:Complete after:${afterDate}`;
  } else {
    // Original behavior: only unread or starred
    query = `(is:unread OR is:starred) -label:Complete after:${afterDate}`;
  }

  const messagesResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?` +
      new URLSearchParams({
        q: query,
        maxResults: maxResults.toString(),
      }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!messagesResponse.ok) {
    if (messagesResponse.status === 401 || messagesResponse.status === 403) {
      throw new AuthenticationError("Gmail", messagesResponse.status);
    }
    getLogger().withOperation("email_utils").warn("Gmail todos API error — returning empty results", {
      status: messagesResponse.status,
      statusText: messagesResponse.statusText,
    });
    return { emails: [], docCommentEmails: [] };
  }

  const messagesData = (await messagesResponse.json()) as { messages?: Array<{ id: string }> };
  if (!messagesData.messages || messagesData.messages.length === 0) {
    return { emails: [], docCommentEmails: [] };
  }

  // Fetch full message details (includes payload.body/parts for comment URL extraction)
  const messagePromises = messagesData.messages.slice(0, maxResults).map((msg) =>
    fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }).then((r) => (r.ok ? r.json() : null))
  );

  const messages = (await Promise.all(messagePromises)).filter(Boolean) as GmailFullMessage[];

  // Extract doc comment notification emails BEFORE mapping to GmailMessageDetail.
  // This must happen first because: (a) we need the full message body to extract
  // comment URLs, and (b) filterEmails() would discard them as automated emails.
  const { commentEmails: docCommentEmails, remainingMessages } = extractDocCommentEmails(messages);

  // Map remaining messages to GmailMessageDetail (discards body data)
  const emails = remainingMessages.map(mapToGmailMessageDetail);

  // Collapse messages in the same thread into one representative email.
  // Keeps the most recent message per thread, attaches participant list and count.
  const collapsed = collapseByThread(emails);

  // Filter out unwanted emails (pass strictFiltering parameter)
  return { emails: filterEmails(collapsed, strictFiltering), docCommentEmails };
}

/**
 * Calculates priority metadata for a Gmail message
 *
 * @param email - Gmail message detail
 * @param now - Current date/time for recency calculations
 * @returns Priority metadata
 */
export function calculateEmailPriority(email: GmailMessageDetail, now: Date): PriorityMetadata {
  let score = 30; // Base email score
  const reasons: string[] = [];

  // From individual boost
  if (email.isFromIndividual) {
    score += 80;
    reasons.push("From individual");

    if (email.needsReply) {
      score += 50;
      reasons.push("Needs action");
    }

    if (email.hasActionItems) {
      score += 60;
      reasons.push("Has action items");
    }
  }

  // Important flag
  if (email.isImportant) {
    score += 20;
    reasons.push("Marked important");
  }

  // Starred
  if (email.isStarred) {
    reasons.push("Starred");
  }

  // Recency boost — branch on the shared label so threshold changes
  // in calculateRecencyBoost propagate everywhere automatically.
  const ageHours = email.timestamp ? (now.getTime() - email.timestamp) / (1000 * 60 * 60) : 999;

  const recencyBoost = calculateRecencyBoost(ageHours);

  if (recencyBoost === "very_recent") {
    score += 50;
    reasons.push("Very recent");
  } else if (recencyBoost === "recent") {
    score += 30;
    reasons.push("Recent");
  } else if (recencyBoost === "moderate") {
    score += 10;
  }

  return {
    score,
    category: categorizeScore(score),
    signals: {
      isFromIndividual: email.isFromIndividual ?? false,
      needsReply: email.needsReply ?? false,
      hasActionItems: email.hasActionItems ?? false,
      isImportant: email.isImportant ?? false,
      isStarred: email.isStarred ?? false,
      ageHours,
      recencyBoost,
    },
    reasons,
  };
}

/**
 * Calculates priority metadata for a meeting summary
 *
 * @param summary - Meeting summary detail
 * @param now - Current date/time for recency calculations
 * @returns Priority metadata
 */
export function calculateMeetingSummaryPriority(
  summary: MeetingSummaryDetail,
  now: Date
): PriorityMetadata {
  let score = 70; // Base meeting summary score
  const reasons: string[] = [];

  if (summary.hasActionItems) {
    score += 80;
    reasons.push("Has action items");
  }

  if (summary.recordingLink) {
    score += 20;
    reasons.push("Recording available");
  }

  const ageHours = (now.getTime() - summary.timestamp) / (1000 * 60 * 60);
  const recencyBoost = calculateRecencyBoost(ageHours);

  if (recencyBoost === "very_recent") {
    score += 50;
    reasons.push("Very recent");
  } else if (recencyBoost === "recent") {
    score += 30;
    reasons.push("Recent");
  } else if (recencyBoost === "moderate") {
    score += 10;
  }

  return {
    score,
    category: categorizeScore(score),
    signals: {
      platform: summary.platform,
      hasActionItems: summary.hasActionItems,
      hasRecording: !!summary.recordingLink,
      ageHours,
      recencyBoost,
    },
    reasons,
  };
}
