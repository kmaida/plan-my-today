/**
 * Tests for meeting context generation — cross-references calendar events
 * with Linear issues, GitHub PRs, emails, and meeting summaries using
 * keyword matching and attendee matching.
 *
 * Known limitations documented as tests:
 * - Attendee email matching uses substring (includes), so
 *   alice@example.com matches alice@example.com.evil.com
 * - Keyword matching requires >= 2 overlapping keywords, which can miss
 *   meetings with short or generic names
 */

import { generateMeetingContext } from "../meeting-prep-utils";
import type {
  CalendarEventDetail,
  GitHubIssueDetail,
  GitHubPRDetail,
  GmailMessageDetail,
  LinearIssueDetail,
  MeetingSummaryDetail,
} from "../types";

// ── Factories ────────────────────────────────────────────────────────────────

function makeCalEvent(overrides: Partial<CalendarEventDetail> = {}): CalendarEventDetail {
  return {
    summary: "Sprint Planning Review",
    start: { dateTime: "2026-02-11T10:00:00Z" },
    end: { dateTime: "2026-02-11T11:00:00Z" },
    attendees: [{ email: "alice@company.com" }, { email: "bob@company.com" }],
    ...overrides,
  } as CalendarEventDetail;
}

function makeLinearIssue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    identifier: "KIM-123",
    title: "Sprint Planning Feature",
    url: "https://linear.app/KIM-123",
    state: { name: "In Progress", type: "started" },
    priority: 2,
    priorityLabel: "High",
    ...overrides,
  } as LinearIssueDetail;
}

function makeGitHubPR(overrides: Partial<GitHubPRDetail> = {}): GitHubPRDetail {
  return {
    number: 42,
    title: "Sprint Planning UI Update",
    url: "https://github.com/org/repo/pull/42",
    repo: "org/repo",
    type: "review" as const,
    isDraft: false,
    updatedAt: "2026-02-10T00:00:00Z",
    ...overrides,
  } as GitHubPRDetail;
}

function makeGitHubIssue(overrides: Partial<GitHubIssueDetail> = {}): GitHubIssueDetail {
  return {
    number: 100,
    title: "Sprint Planning Bug Report",
    url: "https://github.com/org/repo/issues/100",
    repo: "org/repo",
    updatedAt: "2026-02-10T00:00:00Z",
    ...overrides,
  } as GitHubIssueDetail;
}

function makeGmailMessage(overrides: Partial<GmailMessageDetail> = {}): GmailMessageDetail {
  return {
    id: "msg-1",
    subject: "Re: sprint prep",
    from: "alice@company.com",
    link: "https://mail.google.com/inbox/1",
    needsReply: true,
    ...overrides,
  } as GmailMessageDetail;
}

function makeMeetingSummary(overrides: Partial<MeetingSummaryDetail> = {}): MeetingSummaryDetail {
  return {
    id: "sum-1",
    subject: "recording assets",
    from: "zoom@zoom.us",
    link: "https://mail.google.com/inbox/2",
    meetingTitle: "Sprint Planning Review",
    recordingLink: "https://zoom.us/rec/123",
    ...overrides,
  } as MeetingSummaryDetail;
}

const emptyGitHub = { prs: [] as GitHubPRDetail[], issues: [] as GitHubIssueDetail[] };

// ── Keyword matching ─────────────────────────────────────────────────────────

describe("Keyword matching", () => {
  it("should match Linear issue when 2+ keywords overlap", () => {
    // "Sprint Planning Review" → keywords: sprint, planning, review
    // "Sprint Planning Feature" → keywords: sprint, planning, feature
    // Overlap: sprint, planning (2 matches) → should match
    const meeting = makeCalEvent({ summary: "Sprint Planning Review" });
    const issue = makeLinearIssue({ title: "Sprint Planning Feature" });

    const context = generateMeetingContext(meeting, [issue], emptyGitHub, [], []);

    expect(context.relatedIssues).toHaveLength(1);
    expect(context.relatedIssues[0].identifier).toBe("KIM-123");
  });

  it("should NOT match with only 1 keyword overlap", () => {
    // "Sprint Planning Review" → sprint, planning, review
    // "Authentication Sprint" → authentication, sprint
    // Overlap: sprint (1 match) → should NOT match
    const meeting = makeCalEvent({ summary: "Sprint Planning Review" });
    const issue = makeLinearIssue({ title: "Authentication Sprint" });

    const context = generateMeetingContext(meeting, [issue], emptyGitHub, [], []);

    expect(context.relatedIssues).toHaveLength(0);
  });

  it("should include project name keywords in matching", () => {
    // Meeting: "Sprint Planning Review" → sprint, planning, review
    // Issue title: "Fix the dashboard" → dashboard (only 1 match with meeting)
    // But project name: "Sprint Board" → sprint, board
    // Combined overlap: sprint (from project) + planning? No.
    // Let's make it clearer:
    const meeting = makeCalEvent({ summary: "Board Sprint Review" });
    const issue = makeLinearIssue({
      title: "Fix layout bugs",
      project: { name: "Board Sprint" },
    });

    const context = generateMeetingContext(meeting, [issue], emptyGitHub, [], []);

    // "board sprint review" keywords: board, sprint, review
    // issue keywords: layout, bugs
    // project keywords: board, sprint
    // Overlap: board, sprint (2 from project) → should match
    expect(context.relatedIssues).toHaveLength(1);
    expect(context.relatedIssues[0].reason).toBe("project_match");
  });

  it("should match GitHub PRs by 2+ keywords", () => {
    const meeting = makeCalEvent({ summary: "Sprint Planning Review" });
    const pr = makeGitHubPR({ title: "Sprint Planning UI Update" });

    const context = generateMeetingContext(meeting, [], { prs: [pr], issues: [] }, [], []);

    expect(context.relatedPRs).toHaveLength(1);
    expect(context.relatedPRs[0].number).toBe(42);
  });

  it("should match GitHub issues by 2+ keywords", () => {
    const meeting = makeCalEvent({ summary: "Sprint Planning Review" });
    const issue = makeGitHubIssue({ title: "Sprint Planning Bug Report" });

    const context = generateMeetingContext(meeting, [], { prs: [], issues: [issue] }, [], []);

    expect(context.relatedGitHubIssues).toHaveLength(1);
  });

  it("should filter words <= 3 chars from keywords", () => {
    // "The API fix" → only "fix" passes (4 chars), but "the" (stop word)
    // and "api" (3 chars) are excluded → only 1 keyword
    // Meeting with similar: "New API fix" → only "fix" (4 chars)
    // Overlap: "fix" (1 match) → NOT enough
    const meeting = makeCalEvent({ summary: "The API fix" });
    const issue = makeLinearIssue({ title: "New API fix" });

    const context = generateMeetingContext(meeting, [issue], emptyGitHub, [], []);

    // Only 1 overlapping keyword ("fix") → below threshold
    // Actually wait — "the" is a stop word, "api" is 3 chars (excluded).
    // "fix" passes (3 chars? No, "fix" has length 3 → excluded)
    // Actually: filter is w.length > 3, so "fix" (3 chars) is excluded!
    // This means ZERO keywords pass → definitely no match
    expect(context.relatedIssues).toHaveLength(0);
  });
});

// ── Attendee email matching ──────────────────────────────────────────────────

describe("Attendee email matching", () => {
  it("should match emails from attendees that need a reply", () => {
    const meeting = makeCalEvent({
      attendees: [{ email: "alice@company.com" }],
    });
    const email = makeGmailMessage({
      from: "alice@company.com",
      needsReply: true,
    });

    const context = generateMeetingContext(meeting, [], emptyGitHub, [email], []);

    expect(context.relatedEmails).toHaveLength(1);
    expect(context.relatedEmails[0].from).toBe("alice@company.com");
  });

  it("should NOT match emails from attendees that don't need a reply", () => {
    const meeting = makeCalEvent({
      attendees: [{ email: "alice@company.com" }],
    });
    const email = makeGmailMessage({
      from: "alice@company.com",
      needsReply: false,
    });

    const context = generateMeetingContext(meeting, [], emptyGitHub, [email], []);

    expect(context.relatedEmails).toHaveLength(0);
  });

  it("should count pending items per attendee", () => {
    const meeting = makeCalEvent({
      attendees: [{ email: "alice@company.com" }],
    });
    const emails = [
      makeGmailMessage({ id: "msg-1", from: "alice@company.com" }),
      makeGmailMessage({ id: "msg-2", from: "alice@company.com" }),
      makeGmailMessage({ id: "msg-3", from: "bob@other.com" }),
    ];

    const context = generateMeetingContext(meeting, [], emptyGitHub, emails, []);

    expect(context.attendeeContext).toHaveLength(1);
    expect(context.attendeeContext[0].email).toBe("alice@company.com");
    expect(context.attendeeContext[0].pendingItems).toBe(2);
  });

  it("KNOWN LIMITATION: substring matching can match spoofed domains", () => {
    // alice@company.com matches alice@company.com.evil.com because
    // the code uses senderEmail.includes(attendee)
    const meeting = makeCalEvent({
      attendees: [{ email: "alice@company.com" }],
    });
    const email = makeGmailMessage({
      from: "alice@company.com.evil.com",
      needsReply: true,
    });

    const context = generateMeetingContext(meeting, [], emptyGitHub, [email], []);

    // This matches — which is a security concern worth fixing
    expect(context.relatedEmails).toHaveLength(1);
  });
});

// ── Meeting summary matching ─────────────────────────────────────────────────

describe("Meeting summary matching", () => {
  it("should match meeting summary by title substring", () => {
    const meeting = makeCalEvent({ summary: "Sprint Planning Review" });
    const summary = makeMeetingSummary({
      meetingTitle: "Sprint Planning Review",
      recordingLink: "https://zoom.us/rec/123",
    });

    const context = generateMeetingContext(meeting, [], emptyGitHub, [], [summary]);

    expect(context.hasSummary).toBe(true);
    expect(context.summaryLink).toBe("https://zoom.us/rec/123");
  });

  it("should match when summary title is a substring of meeting title", () => {
    const meeting = makeCalEvent({
      summary: "Weekly Sprint Planning Review Session",
    });
    const summary = makeMeetingSummary({
      meetingTitle: "Sprint Planning Review",
    });

    const context = generateMeetingContext(meeting, [], emptyGitHub, [], [summary]);

    // meetingTitle.includes(summaryLower) should match
    expect(context.hasSummary).toBe(true);
  });

  it("should match when meeting title is a substring of summary title", () => {
    const meeting = makeCalEvent({ summary: "Review" });
    const summary = makeMeetingSummary({
      meetingTitle: "Sprint Review Meeting",
    });

    const context = generateMeetingContext(meeting, [], emptyGitHub, [], [summary]);

    // summaryLower.includes(meetingTitle) should match
    expect(context.hasSummary).toBe(true);
  });
});

// ── Early return / edge cases ────────────────────────────────────────────────

describe("Edge cases", () => {
  it("should return empty context when meeting has no summary", () => {
    const meeting = makeCalEvent({ summary: undefined });

    const context = generateMeetingContext(
      meeting,
      [makeLinearIssue()],
      { prs: [makeGitHubPR()], issues: [] },
      [makeGmailMessage()],
      [makeMeetingSummary()]
    );

    expect(context.relatedIssues).toEqual([]);
    expect(context.relatedPRs).toEqual([]);
    expect(context.relatedEmails).toEqual([]);
    expect(context.attendeeContext).toEqual([]);
    expect(context.hasSummary).toBe(false);
  });

  it("should handle meeting with no attendees", () => {
    const meeting = makeCalEvent({
      summary: "Solo Working Session",
      attendees: undefined,
    });

    const context = generateMeetingContext(meeting, [], emptyGitHub, [makeGmailMessage()], []);

    // No attendees → no email matches, no attendee context
    expect(context.relatedEmails).toEqual([]);
    expect(context.attendeeContext).toEqual([]);
  });

  it("short meeting title 'sync' has exactly 4 chars → passes keyword filter", () => {
    // "sync" is 4 chars → passes the >3 filter, so it becomes a keyword
    // But a single keyword alone can't reach the 2-keyword threshold
    const meeting = makeCalEvent({ summary: "Sync" });
    const issue = makeLinearIssue({ title: "Sync meeting notes" });

    const context = generateMeetingContext(meeting, [issue], emptyGitHub, [], []);

    // Meeting keywords: { "sync" } (1 keyword)
    // Issue keywords: { "sync", "meeting", "notes" }
    // Overlap: { "sync" } → only 1 → NOT enough
    expect(context.relatedIssues).toHaveLength(0);
  });
});
