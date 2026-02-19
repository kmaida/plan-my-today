import type {
  CalendarEventDetail,
  CrossReferenceMetadata,
  GitHubIssueDetail,
  GitHubPRDetail,
  GmailMessageDetail,
  LinearIssueDetail,
  MeetingNoteActionDetail,
  MeetingSummaryDetail,
  SlackMessageDetail,
} from "./types";

/**
 * Returns true when `token` appears in `text` as a whole word — i.e., the
 * match is not followed by additional digits or letters. Prevents "#1" from
 * matching "#196" and "KIM-12" from matching "KIM-123".
 */
export function containsExactToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\b`).test(text);
}

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
  meetingSummaries?: MeetingSummaryDetail[],
  calendarEvents?: CalendarEventDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>();
  const relatedItems: Array<{ source: string; id: string; snippet: string; url?: string }> = [];

  // Search emails for issue ID (subject + body snippet)
  for (const email of gmail) {
    const searchText = `${email.subject} ${email.snippet || ""}`;
    if (containsExactToken(searchText, issueId)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: email.subject.substring(0, 100),
        url: email.link,
      });
    }
  }

  // Search Slack messages for issue ID
  for (const msg of slack) {
    if (containsExactToken(msg.text, issueId)) {
      mentionedIn.add("slack");
      relatedItems.push({
        source: "slack",
        id: msg.timestamp,
        snippet: msg.text.substring(0, 100),
        url: msg.permalink,
      });
    }
  }

  // Search meeting note action items for issue ID
  for (const note of meetingNotes ?? []) {
    if (containsExactToken(note.actionItem, issueId)) {
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
    const searchText = `${summary.subject} ${summary.snippet}`;
    if (containsExactToken(searchText, issueId)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: summary.link,
        snippet: summary.subject.substring(0, 100),
        url: summary.link,
      });
    }
  }

  // Search calendar event descriptions for issue ID.
  // Uses text matching (containsExactToken), which fires on prose mentions AND within URLs.
  // Intentional asymmetry with buildCalendarCrossRefs (Direction 2), which is URL-only:
  // a prose mention like "Working on KIM-123" populates the Linear card but NOT the calendar card.
  for (const event of calendarEvents ?? []) {
    if (!event.description) continue;
    if (containsExactToken(event.description, issueId)) {
      mentionedIn.add("calendar");
      relatedItems.push({
        source: "calendar",
        id: event.id ?? event.htmlLink ?? event.summary ?? "",
        snippet: (event.summary ?? "").substring(0, 100),
        url: event.htmlLink,
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
 * meeting summaries, and calendar events by searching for PR/issue number
 * patterns and URLs.
 *
 * @param repo - Repository name (e.g., "owner/repo")
 * @param number - PR/issue number
 * @param gmail - Array of Gmail messages to search (subject + snippet)
 * @param slack - Array of Slack messages to search
 * @param meetingNotes - Optional array of meeting note actions to search
 * @param meetingSummaries - Optional array of meeting summaries to search
 * @param calendarEvents - Optional array of calendar events to search
 * @returns Cross-reference metadata with mentions
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-source search — each branch is a separate text corpus
export function detectGitHubMentions(
  repo: string,
  number: number,
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[],
  meetingNotes?: MeetingNoteActionDetail[],
  meetingSummaries?: MeetingSummaryDetail[],
  calendarEvents?: CalendarEventDetail[]
): CrossReferenceMetadata {
  const mentionedIn = new Set<string>();
  const relatedItems: Array<{ source: string; id: string; snippet: string; url?: string }> = [];

  // Patterns to search: "owner/repo#123" and exact github.com PR/issue URLs.
  // Bare "#123" is intentionally omitted — it's too ambiguous (every
  // system uses #number for IDs, causing false positives like #1 matching #196).
  // URL patterns are specific to this item's number to avoid matching other
  // PRs/issues or repo file URLs (e.g., github.com/owner/repo/blob/...).
  const repoNumberPattern = `${repo}#${number}`;
  const pullUrl = `github.com/${repo}/pull/${number}`;
  const issueUrl = `github.com/${repo}/issues/${number}`;

  /** Check if text contains any GitHub reference pattern for this specific item */
  const hasGitHubRef = (text: string) =>
    containsExactToken(text, repoNumberPattern) ||
    text.includes(pullUrl) ||
    text.includes(issueUrl);

  // Search emails (subject + body snippet)
  for (const email of gmail) {
    const searchText = `${email.subject} ${email.snippet || ""}`;
    if (hasGitHubRef(searchText)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: email.id,
        snippet: email.subject.substring(0, 100),
        url: email.link,
      });
    }
  }

  // Search Slack messages
  for (const msg of slack) {
    if (hasGitHubRef(msg.text)) {
      mentionedIn.add("slack");
      relatedItems.push({
        source: "slack",
        id: msg.timestamp,
        snippet: msg.text.substring(0, 100),
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
    const searchText = `${summary.subject} ${summary.snippet}`;
    if (hasGitHubRef(searchText)) {
      mentionedIn.add("gmail");
      relatedItems.push({
        source: "gmail",
        id: summary.link,
        snippet: summary.subject.substring(0, 100),
        url: summary.link,
      });
    }
  }

  // Search calendar event descriptions for GitHub references.
  // Uses text matching (containsExactToken + URL includes), which fires on
  // prose mentions AND within URLs. Symmetric with detectLinearMentions behavior.
  for (const event of calendarEvents ?? []) {
    if (!event.description) continue;
    if (hasGitHubRef(event.description)) {
      mentionedIn.add("calendar");
      relatedItems.push({
        source: "calendar",
        id: event.id ?? event.htmlLink ?? event.summary ?? "",
        snippet: (event.summary ?? "").substring(0, 100),
        url: event.htmlLink,
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
 * Appends a relatedItem to an item's crossReferenceMetadata, deduplicating by id.
 * Shared by buildCalendarCrossRefs and buildSourceLinearCrossRefs.
 */
function appendCrossRef(
  item: { crossReferenceMetadata?: CrossReferenceMetadata },
  ref: CrossReferenceMetadata["relatedItems"][number]
): void {
  if (!item.crossReferenceMetadata) {
    item.crossReferenceMetadata = { mentionedIn: [], relatedItems: [], totalMentions: 0 };
  }
  if (item.crossReferenceMetadata.relatedItems.some((r) => r.id === ref.id)) return;
  item.crossReferenceMetadata.relatedItems.push(ref);
  item.crossReferenceMetadata.totalMentions++;
  if (!item.crossReferenceMetadata.mentionedIn.includes(ref.source)) {
    item.crossReferenceMetadata.mentionedIn.push(ref.source);
  }
}

/**
 * Builds crossReferenceMetadata for Calendar events that explicitly link to
 * Linear issues via linear.app URLs in their description. Mutates events in place.
 *
 * Uses URL-based extraction (not text matching) for precision — avoids false positives
 * from prose that happens to contain issue-like tokens (e.g., "version KP-1.0").
 * Works for any event type including focusTime.
 *
 * Intentional asymmetry with detectLinearMentions (Direction 1), which uses text matching:
 * a prose mention like "Working on KIM-123" populates the Linear card (Direction 1)
 * but NOT the calendar card (Direction 2, URL-only).
 *
 * @param calendarEvents - Calendar events to inspect (mutated in place)
 * @param linearIssues - Linear issues in scope, used for title/url lookup
 */
export function buildCalendarCrossRefs(
  calendarEvents: CalendarEventDetail[],
  linearIssues: LinearIssueDetail[]
): void {
  const issueByIdentifier = new Map(linearIssues.map((i) => [i.identifier, i]));
  // matchAll clones the regex internally and resets lastIndex on each call, so a single
  // regex object shared across all events is safe — no /g flag lastIndex accumulation.
  const pattern = /https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z]+-\d+)/gi;
  for (const event of calendarEvents) {
    if (!event.description) continue;
    for (const match of event.description.matchAll(pattern)) {
      const identifier = match[1].toUpperCase();
      const issue = issueByIdentifier.get(identifier);
      // appendCrossRef deduplicates by id, so repeated identifiers are safe
      appendCrossRef(event, {
        source: "linear",
        id: identifier,
        snippet: issue ? issue.title.substring(0, 100) : identifier,
        url: issue ? issue.url : match[0], // fallback to captured URL when issue not in today's list
      });
    }
  }
}

/**
 * Builds crossReferenceMetadata for Gmail messages, Slack messages, and meeting
 * note action items that reference Linear issues. Mutates source items in place.
 *
 * Uses a forward scan (one pass per issue over all sources) rather than
 * reverse-mapping from already-computed cross-refs. The reverse-mapping approach
 * has a false-positive bug: detectLinearMentions uses note.documentId as the
 * relatedItem id, so a reverse map would populate ALL notes from a document even
 * when only one specific action item mentions the issue.
 *
 * Mirrors the exact text fields already searched by detectLinearMentions.
 * Meeting summaries are skipped — they are not standalone task cards in the UI.
 *
 * @param linearIssues - Linear issues to search for
 * @param gmail - Gmail messages to populate (mutated in place)
 * @param slack - Slack messages to populate (mutated in place)
 * @param meetingNotes - Meeting note action items to populate (mutated in place)
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: forward cross-ref scan across sources
export function buildSourceLinearCrossRefs(
  linearIssues: LinearIssueDetail[],
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[],
  meetingNotes: MeetingNoteActionDetail[]
): void {
  for (const issue of linearIssues) {
    const issueRef = {
      source: "linear" as const,
      id: issue.identifier,
      snippet: issue.title.substring(0, 100),
      url: issue.url,
    };
    for (const email of gmail) {
      if (containsExactToken(`${email.subject} ${email.snippet || ""}`, issue.identifier)) {
        appendCrossRef(email, issueRef);
      }
    }
    for (const msg of slack) {
      if (containsExactToken(msg.text, issue.identifier)) {
        appendCrossRef(msg, issueRef);
      }
    }
    for (const note of meetingNotes) {
      if (containsExactToken(note.actionItem, issue.identifier)) {
        appendCrossRef(note, issueRef);
      }
    }
  }
}

/**
 * Builds crossReferenceMetadata for Calendar events that link to GitHub
 * PRs or issues via github.com URLs in their description. Mutates events in place.
 *
 * Uses URL-based extraction for precision — avoids false positives from prose
 * that happens to contain number-like tokens (e.g., "step #42").
 * Symmetric with buildCalendarCrossRefs (which does the same for Linear).
 *
 * @param calendarEvents - Calendar events to inspect (mutated in place)
 * @param githubPRs - GitHub PRs in scope, used for title lookup
 * @param githubIssues - GitHub issues in scope, used for title lookup
 */
export function buildCalendarGitHubCrossRefs(
  calendarEvents: CalendarEventDetail[],
  githubPRs: GitHubPRDetail[],
  githubIssues: GitHubIssueDetail[]
): void {
  const prByKey = new Map(githubPRs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
  const issueByKey = new Map(githubIssues.map((i) => [`${i.repo}#${i.number}`, i]));

  // Match github.com/{owner}/{repo}/pull/{number} or .../issues/{number}
  const pattern = /https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)/gi;

  for (const event of calendarEvents) {
    if (!event.description) continue;
    for (const match of event.description.matchAll(pattern)) {
      const key = `${match[1]}#${match[3]}`;
      const item = prByKey.get(key) ?? issueByKey.get(key);
      appendCrossRef(event, {
        source: "github",
        id: key,
        snippet: item ? item.title.substring(0, 100) : key,
        url: match[0], // use the captured URL (always available; not falling back to item.url)
      });
    }
  }
}

/**
 * Builds crossReferenceMetadata for Gmail messages, Slack messages, and meeting
 * note action items that reference GitHub PRs or issues. Mutates source items in place.
 *
 * Mirrors the exact text fields searched by detectGitHubMentions (Direction 1).
 * Meeting summaries are skipped — they are not standalone task cards in the UI.
 *
 * @param githubPRs - GitHub PRs to search for
 * @param githubIssues - GitHub issues to search for
 * @param gmail - Gmail messages to populate (mutated in place)
 * @param slack - Slack messages to populate (mutated in place)
 * @param meetingNotes - Meeting note action items to populate (mutated in place)
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-source forward scan — each loop is an independent corpus
export function buildSourceGitHubCrossRefs(
  githubPRs: GitHubPRDetail[],
  githubIssues: GitHubIssueDetail[],
  gmail: GmailMessageDetail[],
  slack: SlackMessageDetail[],
  meetingNotes: MeetingNoteActionDetail[]
): void {
  for (const item of [...githubPRs, ...githubIssues]) {
    const repoNumberPattern = `${item.repo}#${item.number}`;
    const pullUrl = `github.com/${item.repo}/pull/${item.number}`;
    const issueUrl = `github.com/${item.repo}/issues/${item.number}`;

    const hasRef = (text: string) =>
      containsExactToken(text, repoNumberPattern) ||
      text.includes(pullUrl) ||
      text.includes(issueUrl);

    const itemRef = {
      source: "github" as const,
      id: `${item.repo}#${item.number}`,
      snippet: item.title.substring(0, 100),
      url: item.url,
    };

    for (const email of gmail) {
      if (hasRef(`${email.subject} ${email.snippet || ""}`)) {
        appendCrossRef(email, itemRef);
      }
    }
    for (const msg of slack) {
      if (hasRef(msg.text)) {
        appendCrossRef(msg, itemRef);
      }
    }
    for (const note of meetingNotes) {
      if (hasRef(note.actionItem)) {
        appendCrossRef(note, itemRef);
      }
    }
  }
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
