import type { GmailMessageDetail, MeetingSummaryDetail } from "./types";
import { PriorityMetadata, categorizeScore, calculateRecencyBoost } from "./priority-utils";
import { AuthenticationError } from "../../utils/error-utils";

/**
 * Determines if an email is from an individual (not an automated system).
 * Errs on the side of "not individual" to avoid flagging automated messages
 * as needing replies.
 */
export function isFromIndividual(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();

  // ── Definite automated senders ────────────────────────────────────────────
  const automatedFromPatterns = [
    /noreply/i,
    /no-reply/i,
    /donotreply/i,
    /don't reply/i,
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
    /do-not-reply/i,
  ];

  if (automatedFromPatterns.some(pattern => pattern.test(fromLower))) {
    return false;
  }

  // ── Known automated service domains ───────────────────────────────────────
  const automatedDomains = [
    'linear.app',
    'github.com',
    'zoom.us',
    'figma.com',
    'render.com',
    'n8n.cloud',
    'granola.so',
    'instatunnel.my',
    'google.com',
    'googlemail.com',
    'atlassian.net',
    'jira.com',
    'slack.com',
    'notion.so',
    'vercel.com',
    'netlify.com',
    'stripe.com',
    'intercom.io',
    'hubspot.com',
    'mailchimp.com',
    'sendgrid.net',
    'amazonses.com',
    'postmarkapp.com',
  ];

  // Calendar emails are always automated
  if (fromLower.includes('calendar') || fromLower.includes('calendar-notification') ||
      subjectLower.includes('google calendar') || subjectLower.includes('calendar event')) {
    return false;
  }

  const emailDomain = fromLower.match(/@([^\s>]+)/)?.[1];
  if (emailDomain && automatedDomains.some(domain => emailDomain.includes(domain))) {
    return false;
  }

  // ── Subject patterns that indicate automated/transactional email ──────────
  const automatedSubjectPatterns = [
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
    /invitation:/i,
    /accepted:/i,
    /canceled event:/i,
    /declined:/i,
    /notification/i,
    /has joined your meeting/i,
    /has invited you/i,
  ];

  if (automatedSubjectPatterns.some(pattern => pattern.test(subjectLower))) {
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
    'action items',
    'action item',
    'can you',
    'could you',
    'would you',
    'follow up',
    'follow-up',
    'question',
    '?',
  ];

  if (actionKeywords.some(keyword => subjectLower.includes(keyword))) {
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
  return actionItemPatterns.some(pattern => pattern.test(subjectLower));
}

/**
 * Determines if an email is a newsletter or marketing email
 */
export function isNewsletter(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  
  // Newsletter/marketing patterns in subject
  const newsletterSubjectPatterns = [
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
  
  // Newsletter/marketing patterns in from field
  const newsletterFromPatterns = [
    /newsletter/i,
    /marketing/i,
    /noreply/i,
    /no-reply/i,
    /donotreply/i,
    /updates@/i,
    /news@/i,
    /info@/i,
    /team@/i,
    /hello@/i,
    /hi@/i,
  ];
  
  // Check subject
  if (newsletterSubjectPatterns.some(pattern => pattern.test(subjectLower))) {
    return true;
  }
  
  // Check from field
  if (newsletterFromPatterns.some(pattern => pattern.test(fromLower))) {
    return true;
  }
  
  return false;
}

/**
 * Determines if an email looks unimportant (low priority)
 */
export function isLowImportance(from: string, subject: string, isImportant: boolean): boolean {
  // If marked as important by Gmail, keep it
  if (isImportant) {
    return false;
  }
  
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  
  // Low importance patterns
  const lowImportancePatterns = [
    /^re:/i, // Replies that might be low priority
    /^fwd:/i,
    /^fw:/i,
    /automated/i,
    /system notification/i,
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
  
  // Check subject for low importance patterns
  if (lowImportancePatterns.some(pattern => pattern.test(subjectLower))) {
    // But allow if it's from an individual and has action items
    if (isFromIndividual(from, subject) && emailHasActionItems(subject)) {
      return false; // Keep it if it has action items
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
  if (!fromLower.includes('zoom.us') || !fromLower.includes('no-reply')) {
    return false;
  }

  // Check subject patterns
  const meetingNotePatterns = [
    /meeting (assets|summary|recording) for .+ (are|is) ready/i,
    /meeting notes for .+/i,
  ];

  return meetingNotePatterns.some(pattern => pattern.test(subjectLower));
}

/**
 * Detects action items in email snippet
 */
export function snippetHasActionItems(snippet: string | undefined): boolean {
  if (!snippet) return false;

  const snippetLower = snippet.toLowerCase();

  // Action item keywords
  const actionKeywords = [
    'action item',
    'todo',
    'to do',
    'follow up',
    'follow-up',
    'assigned to',
    '@', // Mentions often indicate assignments
  ];

  return actionKeywords.some(keyword => snippetLower.includes(keyword));
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
    const textPart = payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64").toString("utf-8");
    }

    // Check for HTML part if no plain text
    const htmlPart = payload.parts.find(p => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
    }

    // Check nested parts (multipart/alternative)
    for (const part of payload.parts) {
      if (part.parts) {
        const nestedText = part.parts.find(p => p.mimeType === "text/plain");
        if (nestedText?.body?.data) {
          return Buffer.from(nestedText.body.data, "base64").toString("utf-8");
        }
        const nestedHtml = part.parts.find(p => p.mimeType === "text/html");
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
    return [];
  }

  const messagesData = await messagesResponse.json() as { messages?: Array<{ id: string }> };
  if (!messagesData.messages || messagesData.messages.length === 0) {
    return [];
  }

  // Fetch message details WITH FULL BODY to extract recording links
  const messagePromises = messagesData.messages.slice(0, maxResults).map(msg =>
    fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    ).then(r => r.ok ? r.json() : null)
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
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;

    const subject = getHeader("subject") || "";
    const from = getHeader("from") || "";
    const snippet = message.snippet || '';

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
 * Filters out unwanted emails (calendar, Linear automated, newsletters, low importance)
 * @param strictFiltering - If false, only excludes calendar and Linear automation (for agent use)
 */
export function filterEmails(emails: GmailMessageDetail[], strictFiltering: boolean = true): GmailMessageDetail[] {
  return emails.filter(email => {
    const fromLower = email.from.toLowerCase();
    const subjectLower = email.subject.toLowerCase();

    // ALWAYS exclude Google Calendar automated emails (already integrated)
    if (fromLower.includes('calendar') ||
        fromLower.includes('calendar-notification') ||
        fromLower.includes('noreply@calendar.google.com') ||
        fromLower.includes('calendar@google.com') ||
        (subjectLower.includes('calendar') && fromLower.includes('google'))) {
      return false;
    }

    // ALWAYS exclude calendar notification patterns in subject (even from individuals)
    // These are typically automated calendar notifications
    const calendarNotificationPatterns = [
      /^accepted:/i,
      /^invitation:/i,
      /^canceled event:/i,
      /^declined:/i,
      /^tentative:/i,
      /google calendar/i,
      /calendar event/i,
    ];

    if (calendarNotificationPatterns.some(pattern => pattern.test(subjectLower))) {
      return false;
    }

    // ALWAYS exclude Linear automated emails (already integrated)
    if (fromLower.includes('linear.app') ||
        fromLower.includes('notifications@linear.app') ||
        fromLower.includes('noreply@linear.app')) {
      // But allow if it's from an individual at Linear (e.g., name@linear.app)
      const emailDomain = fromLower.match(/@([^\s>]+)/)?.[1];
      if (emailDomain && emailDomain.includes('linear.app')) {
        const localPart = fromLower.split('@')[0];
        // If it looks like a personal name (has dot or is long), might be individual
        if (localPart.includes('.') || localPart.length > 8) {
          // Check if subject looks automated (comprehensive Linear patterns)
          const linearAutomatedPatterns = [
            // Existing patterns
            /notification/i,
            /reminder/i,
            /unread notifications/i,
            /^\[Linear\]/i,

            // Overdue/Due date patterns
            /overdue/i,
            /due today/i,
            /due tomorrow/i,
            /due in \d+ day/i,
            /due:/i,

            // Assignment patterns
            /assigned:/i,
            /assigned to/i,
            /you've been assigned/i,
            /you have been assigned/i,

            // Status change patterns
            /moved to/i,
            /status changed/i,
            /updated:/i,

            // Issue identifier patterns (Linear uses ABC-123 format)
            // Only match if it's the main subject component, not just mentioned in passing
            /^[A-Z]{2,10}-\d+/i,  // Starts with issue ID like "ABC-123: Task name"
            /^⚠️\s*[A-Z]{2,10}-\d+/i,  // Urgent icon + issue ID

            // Comment/mention patterns
            /commented on/i,
            /mentioned you/i,
            /new comment/i,
          ];
          if (linearAutomatedPatterns.some(pattern => pattern.test(subjectLower))) {
            return false; // Automated Linear notification
          }
        } else {
          return false; // Likely automated
        }
      } else {
        return false; // Linear automated
      }
    }

    // Only apply these filters if strictFiltering is enabled
    if (strictFiltering) {
      // Exclude newsletters and marketing emails
      if (isNewsletter(email.from, email.subject)) {
        return false;
      }

      // Exclude low importance emails (unless from individual with action items)
      if (isLowImportance(email.from, email.subject, email.isImportant ?? false)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Fetches Gmail todos
 * Expands date range to include individual emails from the past week
 *
 * @param accessToken - Gmail access token
 * @param options - Optional configuration
 * @param options.daysBack - Number of days to look back (default: 7, agent: 14)
 * @param options.maxResults - Maximum emails to return (default: 20, agent: 30-40)
 * @param options.includeRead - Include recent read emails (default: false, agent: true)
 * @param options.strictFiltering - Apply strict filtering for newsletters/low-priority (default: true, agent: false)
 * @returns Array of Gmail messages
 */
export async function fetchGmailTodos(
  accessToken: string,
  options: {
    daysBack?: number;
    maxResults?: number;
    includeRead?: boolean;
    strictFiltering?: boolean;
  } = {}
): Promise<GmailMessageDetail[]> {
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
    return [];
  }

  const messagesData = await messagesResponse.json() as { messages?: Array<{ id: string }> };
  if (!messagesData.messages || messagesData.messages.length === 0) {
    return [];
  }

  // Fetch message details (use maxResults limit)
  const messagePromises = messagesData.messages.slice(0, maxResults).map(msg =>
    fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    ).then(r => r.ok ? r.json() : null)
  );

  const messages = (await Promise.all(messagePromises)).filter(Boolean) as Array<{
    payload?: {
      headers?: Array<{ name?: string; value?: string }>;
    };
    snippet?: string;
    id: string;
    internalDate?: string;
    labelIds?: string[];
  }>;

  const emails = messages
    .map(message => {
      const headers = message.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;

      const subject = getHeader("subject") || "(No subject)";
      const from = getHeader("from") || "Unknown";
      const isUnread = message.labelIds?.includes("UNREAD") ?? false;
      const fromIndividual = isFromIndividual(from, subject);
      const needsReply = emailNeedsReply(subject, from, isUnread);
      const hasActionItems = emailHasActionItems(subject);

      return {
        id: message.id,
        subject,
        from,
        link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
        timestamp: message.internalDate ? parseInt(message.internalDate, 10) : undefined,
        isImportant: message.labelIds?.includes("IMPORTANT") ?? false,
        isStarred: message.labelIds?.includes("STARRED") ?? false,
        isFromIndividual: fromIndividual,
        needsReply,
        hasActionItems,
      };
    });

  // Filter out unwanted emails (pass strictFiltering parameter)
  return filterEmails(emails, strictFiltering);
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

  // Recency boost
  const ageHours = email.timestamp
    ? (now.getTime() - email.timestamp) / (1000 * 60 * 60)
    : 999;

  const recencyBoost = calculateRecencyBoost(ageHours);

  if (ageHours < 1) {
    score += 50;
    reasons.push("Very recent");
  } else if (ageHours < 4) {
    score += 30;
    reasons.push("Recent");
  } else if (ageHours < 24) {
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
      recencyBoost
    },
    reasons
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
      recencyBoost
    },
    reasons
  };
}
