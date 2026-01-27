import type {
  CalendarEventDetail,
  MeetingContextMetadata,
  LinearIssueDetail,
  GitHubPRDetail,
  GitHubIssueDetail,
  GmailMessageDetail,
  MeetingSummaryDetail
} from "./types";

/**
 * Extracts meaningful keywords from text (>3 chars, excluding common words)
 *
 * @param text - Text to extract keywords from
 * @returns Set of keywords
 */
function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase().split(/\W+/);
  const stopWords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "will", "can",
    "are", "was", "were", "been", "has", "had", "but", "not", "you", "all"
  ]);
  return new Set(
    words.filter(w => w.length > 3 && !stopWords.has(w))
  );
}

/**
 * Generates meeting context by cross-referencing calendar event with work items
 *
 * @param meeting - Calendar event to generate context for
 * @param linear - Array of Linear issues
 * @param github - GitHub PRs and issues
 * @param gmail - Array of Gmail messages
 * @param meetingSummaries - Array of meeting summaries
 * @returns Meeting context metadata with related items
 */
export function generateMeetingContext(
  meeting: CalendarEventDetail,
  linear: LinearIssueDetail[],
  github: { prs: GitHubPRDetail[], issues: GitHubIssueDetail[] },
  gmail: GmailMessageDetail[],
  meetingSummaries: MeetingSummaryDetail[]
): MeetingContextMetadata {
  const context: MeetingContextMetadata = {
    relatedIssues: [],
    relatedPRs: [],
    relatedEmails: [],
    attendeeContext: [],
    hasSummary: false,
  };

  // Early return if no meeting summary
  if (!meeting.summary) return context;

  const meetingKeywords = extractKeywords(meeting.summary);
  const attendeeEmails = new Set(
    (meeting.attendees || [])
      .map(a => a.email?.toLowerCase())
      .filter(Boolean) as string[]
  );

  // Match Linear issues by keywords or project name
  for (const issue of linear) {
    const issueKeywords = extractKeywords(issue.title);
    const projectKeywords = issue.project?.name
      ? extractKeywords(issue.project.name)
      : new Set<string>();

    const keywordOverlap = Array.from(meetingKeywords)
      .filter(k => issueKeywords.has(k) || projectKeywords.has(k));

    // Require at least 2 keyword matches to avoid false positives
    if (keywordOverlap.length >= 2) {
      context.relatedIssues.push({
        identifier: issue.identifier,
        title: issue.title,
        reason: projectKeywords.has(keywordOverlap[0])
          ? "project_match"
          : "keyword_match",
      });
    }
  }

  // Match GitHub PRs by keywords
  for (const pr of github.prs) {
    const prKeywords = extractKeywords(pr.title);
    const keywordOverlap = Array.from(meetingKeywords)
      .filter(k => prKeywords.has(k));

    if (keywordOverlap.length >= 2) {
      context.relatedPRs.push({
        number: pr.number,
        repo: pr.repo,
        title: pr.title,
        reason: "keyword_match",
      });
    }
  }

  // Match GitHub issues by keywords
  for (const issue of github.issues) {
    const issueKeywords = extractKeywords(issue.title);
    const keywordOverlap = Array.from(meetingKeywords)
      .filter(k => issueKeywords.has(k));

    if (keywordOverlap.length >= 2) {
      context.relatedPRs.push({
        number: issue.number,
        repo: issue.repo,
        title: issue.title,
        reason: "keyword_match",
      });
    }
  }

  // Match emails from attendees that need a reply
  for (const email of gmail) {
    const senderEmail = email.from.toLowerCase();
    const senderInMeeting = Array.from(attendeeEmails)
      .some(attendee => senderEmail.includes(attendee));

    if (senderInMeeting && email.needsReply) {
      context.relatedEmails.push({
        id: email.id,
        subject: email.subject,
        from: email.from,
        reason: "attendee_needs_reply",
      });
    }
  }

  // Count pending items per attendee (emails from them)
  const attendeeItemCount = new Map<string, number>();
  for (const attendeeEmail of attendeeEmails) {
    const count = gmail.filter(e =>
      e.from.toLowerCase().includes(attendeeEmail)
    ).length;

    if (count > 0) {
      context.attendeeContext.push({
        email: attendeeEmail,
        pendingItems: count,
      });
    }
  }

  // Match with meeting summaries (Zoom recordings, etc.)
  for (const summary of meetingSummaries) {
    const summaryTitle = summary.meetingTitle || summary.subject;
    const meetingTitle = meeting.summary.toLowerCase();
    const summaryLower = summaryTitle.toLowerCase();

    if (summaryLower.includes(meetingTitle) ||
        meetingTitle.includes(summaryLower)) {
      context.hasSummary = true;
      context.summaryLink = summary.recordingLink || summary.link;
      break; // Only need one match
    }
  }

  return context;
}
