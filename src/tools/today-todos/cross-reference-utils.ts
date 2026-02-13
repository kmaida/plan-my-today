import type {
  CalendarEventDetail,
  CrossReferenceMetadata,
  GmailMessageDetail,
  MeetingNoteActionDetail,
  MeetingSummaryDetail,
  SlackMessageDetail,
} from "./types";

/**
 * Detects mentions of a Linear issue across email, Slack, meeting notes,
 * and meeting summaries by searching for the exact issue identifier.
 *
 * @param issueId - Linear issue identifier (e.g., "ABC-123")
 * @param gmail - Array of Gmail messages to search (subject + snippet)
 * @param slack - Array of Slack messages to search
 * @param meetingNotes - Optional array of meeting note actions to search
 * @param meetingSummaries - Optional array of meeting summaries to search
 * @returns Cross-reference metadata with mentions
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: cross-source mention matching
export function detectLinearMentions(
  issueId: string,
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[],
  meetingNotes?: MeetingNoteActionDetail[],
  meetingSummaries?: MeetingSummaryDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>();
  const relatedItems: Array<{ source: string; id: string; snippet: string; url?: string }> = [];

  // Search emails for issue ID (subject + body snippet)
  for (const email of gmail) {
    const searchText = `${email.subject || ""} ${email.snippet || ""}`;
    if (searchText.includes(issueId)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: (email.subject || "").substring(0, 100),
        url: email.link,
      });
    }
  }

  // Search Slack messages for issue ID
  for (const msg of slack) {
    const text = msg.text || "";
    if (text.includes(issueId)) {
      mentionedIn.add("slack");
      relatedItems.push({
        source: "slack",
        id: msg.timestamp,
        snippet: text.substring(0, 100),
        url: msg.permalink,
      });
    }
  }

  // Search meeting note action items for issue ID
  for (const note of meetingNotes ?? []) {
    if (note.actionItem.includes(issueId)) {
      mentionedIn.add("meeting-notes");
      relatedItems.push({
        source: "meeting-notes",
        id: note.documentId,
        snippet: note.actionItem.substring(0, 100),
        url: note.documentLink,
      });
    }
  }

  // Search meeting summaries for issue ID (subject + snippet)
  for (const summary of meetingSummaries ?? []) {
    const searchText = `${summary.subject || ""} ${summary.snippet || ""}`;
    if (searchText.includes(issueId)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: summary.link,
        snippet: (summary.subject || "").substring(0, 100),
        url: summary.link,
      });
    }
  }

  return {
    mentionedIn: Array.from(mentionedIn),
    relatedItems,
    totalMentions: relatedItems.length,
  };
}

/**
 * Detects mentions of a GitHub PR/issue across email, Slack, meeting notes,
 * and meeting summaries by searching for PR/issue number patterns and URLs.
 *
 * @param repo - Repository name (e.g., "owner/repo")
 * @param number - PR/issue number
 * @param gmail - Array of Gmail messages to search (subject + snippet)
 * @param slack - Array of Slack messages to search
 * @param meetingNotes - Optional array of meeting note actions to search
 * @param meetingSummaries - Optional array of meeting summaries to search
 * @returns Cross-reference metadata with mentions
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: cross-source mention matching
export function detectGitHubMentions(
  repo: string,
  number: number,
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[],
  meetingNotes?: MeetingNoteActionDetail[],
  meetingSummaries?: MeetingSummaryDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>();
  const relatedItems: Array<{ source: string; id: string; snippet: string; url?: string }> = [];

  // Patterns to search: "#123", "owner/repo#123", github.com URLs
  const prNumberPattern = `#${number}`;
  const repoNumberPattern = `${repo}#${number}`;
  const githubUrlPattern = `github.com/${repo}/`;

  /** Check if text contains any GitHub reference pattern */
  const hasGitHubRef = (text: string) =>
    text.includes(prNumberPattern) ||
    text.includes(repoNumberPattern) ||
    text.includes(githubUrlPattern);

  // Search emails (subject + body snippet)
  for (const email of gmail) {
    const searchText = `${email.subject || ""} ${email.snippet || ""}`;
    if (hasGitHubRef(searchText)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: (email.subject || "").substring(0, 100),
        url: email.link,
      });
    }
  }

  // Search Slack messages
  for (const msg of slack) {
    const text = msg.text || "";
    if (hasGitHubRef(text)) {
      mentionedIn.add("slack");
      relatedItems.push({
        source: "slack",
        id: msg.timestamp,
        snippet: text.substring(0, 100),
        url: msg.permalink,
      });
    }
  }

  // Search meeting note action items
  for (const note of meetingNotes ?? []) {
    if (hasGitHubRef(note.actionItem)) {
      mentionedIn.add("meeting-notes");
      relatedItems.push({
        source: "meeting-notes",
        id: note.documentId,
        snippet: note.actionItem.substring(0, 100),
        url: note.documentLink,
      });
    }
  }

  // Search meeting summaries (subject + snippet)
  for (const summary of meetingSummaries ?? []) {
    const searchText = `${summary.subject || ""} ${summary.snippet || ""}`;
    if (hasGitHubRef(searchText)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: summary.link,
        snippet: (summary.subject || "").substring(0, 100),
        url: summary.link,
      });
    }
  }

  return {
    mentionedIn: Array.from(mentionedIn),
    relatedItems,
    totalMentions: relatedItems.length,
  };
}

/**
 * Normalize a title for fuzzy comparison: lowercase, collapse whitespace,
 * strip leading date-like prefixes (e.g., "2025-02-07 ") that Granola
 * often prepends to document names.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*/, "") // strip leading date
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Links Zoom "meeting assets" emails to matching Granola meeting notes
 * and calendar events using meeting title matching.
 *
 * Zoom emails have subjects like "meeting assets for <title> are ready!"
 * The extracted meetingTitle should match (as a substring) against:
 * - Granola document titles (often "<date> <meeting title>")
 * - Calendar event summaries (the meeting name itself)
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: links meetings across calendar, notes, and summaries
export function linkMeetingAssets(
  meetingSummaries: MeetingSummaryDetail[],
  meetingNotes: MeetingNoteActionDetail[],
  calendarEvents: CalendarEventDetail[]
): void {
  for (const summary of meetingSummaries) {
    if (!summary.meetingTitle) continue;

    const normalizedZoomTitle = normalizeTitle(summary.meetingTitle);
    if (!normalizedZoomTitle) continue;

    // Match against Granola meeting notes by document title
    // Dedupe by documentId (multiple action items can come from the same doc)
    const seenDocIds = new Set<string>();
    const matchedNotes: MeetingSummaryDetail["relatedMeetingNotes"] = [];

    for (const note of meetingNotes) {
      if (seenDocIds.has(note.documentId)) continue;

      const normalizedDocTitle = normalizeTitle(note.documentTitle);
      if (
        normalizedDocTitle.includes(normalizedZoomTitle) ||
        normalizedZoomTitle.includes(normalizedDocTitle)
      ) {
        seenDocIds.add(note.documentId);
        matchedNotes.push({
          documentId: note.documentId,
          documentTitle: note.documentTitle,
          documentLink: note.documentLink,
        });
      }
    }

    if (matchedNotes.length > 0) {
      summary.relatedMeetingNotes = matchedNotes;
    }

    // Match against calendar events by summary (title)
    for (const event of calendarEvents) {
      if (!event.summary) continue;

      const normalizedEventTitle = normalizeTitle(event.summary);
      if (
        normalizedEventTitle.includes(normalizedZoomTitle) ||
        normalizedZoomTitle.includes(normalizedEventTitle)
      ) {
        summary.relatedCalendarEvent = {
          summary: event.summary,
          htmlLink: event.htmlLink,
        };
        break; // Take the first match
      }
    }
  }
}
