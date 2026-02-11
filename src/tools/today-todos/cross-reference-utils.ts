import type {
  CalendarEventDetail,
  CrossReferenceMetadata,
  GmailMessageDetail,
  MeetingNoteActionDetail,
  MeetingSummaryDetail,
  SlackMessageDetail,
} from "./types";

/**
 * Detects mentions of a Linear issue across email and Slack
 *
 * @param issueId - Linear issue identifier (e.g., "ABC-123")
 * @param gmail - Array of Gmail messages to search
 * @param slack - Array of Slack messages to search
 * @returns Cross-reference metadata with mentions
 */
export function detectLinearMentions(
  issueId: string,
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>();
  const relatedItems: Array<{ source: string; id: string; snippet: string }> = [];

  // Search emails for issue ID
  for (const email of gmail) {
    const subject = email.subject || "";
    if (subject.includes(issueId)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: subject.substring(0, 100),
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
 * Detects mentions of a GitHub PR/issue across email and Slack
 *
 * @param repo - Repository name (e.g., "owner/repo")
 * @param number - PR/issue number
 * @param gmail - Array of Gmail messages to search
 * @param slack - Array of Slack messages to search
 * @returns Cross-reference metadata with mentions
 */
export function detectGitHubMentions(
  repo: string,
  number: number,
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>();
  const relatedItems: Array<{ source: string; id: string; snippet: string }> = [];

  // Patterns to search: "#123", "owner/repo#123", github.com URLs
  const prNumberPattern = `#${number}`;
  const repoNumberPattern = `${repo}#${number}`;
  const githubUrlPattern = `github.com/${repo}/`;

  // Search emails
  for (const email of gmail) {
    const subject = email.subject || "";
    if (
      subject.includes(prNumberPattern) ||
      subject.includes(repoNumberPattern) ||
      subject.includes(githubUrlPattern)
    ) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: subject.substring(0, 100),
      });
    }
  }

  // Search Slack messages
  for (const msg of slack) {
    const text = msg.text || "";
    if (
      text.includes(prNumberPattern) ||
      text.includes(repoNumberPattern) ||
      text.includes(githubUrlPattern)
    ) {
      mentionedIn.add("slack");
      relatedItems.push({
        source: "slack",
        id: msg.timestamp,
        snippet: text.substring(0, 100),
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
