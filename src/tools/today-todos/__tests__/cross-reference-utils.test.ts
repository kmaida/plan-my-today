/**
 * Tests for cross-reference utilities — detect mentions of Linear issues
 * and GitHub PRs/issues across email and Slack, and link Zoom "meeting
 * assets" emails to matching Granola meeting notes and calendar events.
 *
 * Known limitations documented as tests:
 * - linkMeetingAssets uses bidirectional substring matching, which can
 *   match too broadly for short titles
 */

import {
  buildCalendarCrossRefs,
  buildSourceLinearCrossRefs,
  containsExactToken,
  detectGitHubMentions,
  detectLinearMentions,
  linkMeetingAssets,
} from "../cross-reference-utils";
import type {
  CalendarEventDetail,
  GmailMessageDetail,
  LinearIssueDetail,
  MeetingNoteActionDetail,
  MeetingSummaryDetail,
  SlackMessageDetail,
} from "../types";

// ── Factories ────────────────────────────────────────────────────────────────

function makeEmail(overrides: Partial<GmailMessageDetail> = {}): GmailMessageDetail {
  return {
    id: "msg-1",
    subject: "No match",
    from: "someone@example.com",
    link: "https://mail.google.com/inbox/1",
    ...overrides,
  } as GmailMessageDetail;
}

function makeSlackMsg(overrides: Partial<SlackMessageDetail> = {}): SlackMessageDetail {
  return {
    text: "No match",
    timestamp: "1234567890.000001",
    channel: "C123",
    user: "U123",
    type: "mention" as const,
    ...overrides,
  } as SlackMessageDetail;
}

function makeMeetingSummary(overrides: Partial<MeetingSummaryDetail> = {}): MeetingSummaryDetail {
  return {
    id: "sum-1",
    subject: "meeting assets for Sprint Review are ready!",
    from: "zoom@zoom.us",
    link: "https://mail.google.com/inbox/2",
    meetingTitle: "Sprint Review",
    ...overrides,
  } as MeetingSummaryDetail;
}

function makeMeetingNote(
  overrides: Partial<MeetingNoteActionDetail> = {}
): MeetingNoteActionDetail {
  return {
    documentId: "doc-1",
    documentTitle: "2026-02-07 Sprint Review",
    documentLink: "https://granola.so/doc/1",
    actionItem: "Follow up on blockers",
    isUrgent: false,
    timestamp: Date.now(),
    ...overrides,
  } as MeetingNoteActionDetail;
}

function makeCalEvent(overrides: Partial<CalendarEventDetail> = {}): CalendarEventDetail {
  return {
    summary: "Sprint Review",
    start: { dateTime: "2026-02-11T10:00:00Z" },
    end: { dateTime: "2026-02-11T10:30:00Z" },
    ...overrides,
  } as CalendarEventDetail;
}

function makeLinearIssue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    identifier: "TEAM-1",
    title: "Test issue",
    priority: 0,
    priorityLabel: "No priority",
    url: "https://linear.app/team/issue/TEAM-1",
    state: null,
    dueDate: null,
    estimate: null,
    project: null,
    ...overrides,
  };
}

// ── detectLinearMentions ─────────────────────────────────────────────────────

describe("detectLinearMentions", () => {
  it("should find issue ID in email subject", () => {
    const result = detectLinearMentions(
      "KIM-123",
      [makeEmail({ subject: "Re: KIM-123 fix authentication" })],
      []
    );
    expect(result.totalMentions).toBe(1);
    expect(result.mentionedIn).toContain("gmail");
  });

  it("should find issue ID in Slack message text", () => {
    const result = detectLinearMentions(
      "KIM-456",
      [],
      [makeSlackMsg({ text: "Working on KIM-456 now" })]
    );
    expect(result.totalMentions).toBe(1);
    expect(result.mentionedIn).toContain("slack");
  });

  it("should find issue ID in both email and Slack", () => {
    const result = detectLinearMentions(
      "ABC-10",
      [makeEmail({ subject: "ABC-10 status update" })],
      [makeSlackMsg({ text: "Blocked on ABC-10" })]
    );
    expect(result.totalMentions).toBe(2);
    expect(result.mentionedIn).toEqual(expect.arrayContaining(["gmail", "slack"]));
  });

  it("should return empty when no mentions exist", () => {
    const result = detectLinearMentions(
      "KIM-999",
      [makeEmail({ subject: "Unrelated email" })],
      [makeSlackMsg({ text: "Unrelated message" })]
    );
    expect(result.totalMentions).toBe(0);
    expect(result.mentionedIn).toEqual([]);
  });

  it("should NOT match when issue ID is a prefix of a longer ID", () => {
    // "KIM-12" must not match "KIM-123" — word boundary prevents this
    const result = detectLinearMentions(
      "KIM-12",
      [makeEmail({ subject: "Working on KIM-123 today" })],
      []
    );
    expect(result.totalMentions).toBe(0);
  });

  it("should truncate snippet to 100 chars", () => {
    const longSubject = "A".repeat(200);
    const result = detectLinearMentions(
      "KIM-1",
      [makeEmail({ subject: `KIM-1 ${longSubject}` })],
      []
    );
    expect(result.relatedItems[0].snippet.length).toBe(100);
  });

  it("should find issue ID in email snippet (body preview)", () => {
    const result = detectLinearMentions(
      "KIM-42",
      [makeEmail({ subject: "Quick update", snippet: "Regarding KIM-42 we should fix it" })],
      []
    );
    expect(result.totalMentions).toBe(1);
    expect(result.mentionedIn).toContain("gmail");
    // Snippet in relatedItems shows subject, not body preview
    expect(result.relatedItems[0].snippet).toBe("Quick update");
  });

  it("should not double-count when issue ID is in both subject and snippet", () => {
    const result = detectLinearMentions(
      "KIM-42",
      [makeEmail({ subject: "Re: KIM-42", snippet: "About KIM-42 auth bug" })],
      []
    );
    // Should be 1 mention, not 2 — same email matched once
    expect(result.totalMentions).toBe(1);
  });

  it("should find issue ID in meeting note action item", () => {
    const result = detectLinearMentions(
      "KIM-99",
      [],
      [],
      [makeMeetingNote({ actionItem: "Follow up on KIM-99 auth migration" })]
    );
    expect(result.totalMentions).toBe(1);
    expect(result.mentionedIn).toContain("meeting-notes");
    expect(result.relatedItems[0].url).toBe("https://granola.so/doc/1");
  });

  it("should find issue ID in meeting summary snippet", () => {
    const result = detectLinearMentions(
      "KIM-55",
      [],
      [],
      [],
      [makeMeetingSummary({ subject: "Meeting recap", snippet: "Discussed KIM-55 progress" })]
    );
    expect(result.totalMentions).toBe(1);
    expect(result.mentionedIn).toContain("gmail");
  });

  it("should populate url on Gmail related items", () => {
    const result = detectLinearMentions(
      "KIM-1",
      [makeEmail({ subject: "KIM-1 update", link: "https://mail.google.com/inbox/1" })],
      []
    );
    expect(result.relatedItems[0].url).toBe("https://mail.google.com/inbox/1");
  });

  it("should populate url on Slack related items", () => {
    const result = detectLinearMentions(
      "KIM-1",
      [],
      [
        makeSlackMsg({
          text: "KIM-1 is blocked",
          permalink: "https://slack.com/archives/C123/p123",
        }),
      ]
    );
    expect(result.relatedItems[0].url).toBe("https://slack.com/archives/C123/p123");
  });

  describe("with calendar events", () => {
    it("should find issue ID in calendar event description", () => {
      const event = makeCalEvent({
        id: "evt-1",
        summary: "Focus: TEAM-4",
        htmlLink: "https://calendar.google.com/event/1",
        description: "Working on https://linear.app/team/issue/TEAM-4/some-title",
      });
      const result = detectLinearMentions("TEAM-4", [], [], [], [], [event]);
      expect(result.totalMentions).toBe(1);
      expect(result.mentionedIn).toContain("calendar");
      expect(result.relatedItems[0].source).toBe("calendar");
      expect(result.relatedItems[0].id).toBe("evt-1");
      expect(result.relatedItems[0].url).toBe("https://calendar.google.com/event/1");
    });

    it("should not match when calendar event has no description", () => {
      const event = makeCalEvent({ summary: "TEAM-4 Focus Block" }); // no description field
      const result = detectLinearMentions("TEAM-4", [], [], [], [], [event]);
      expect(result.totalMentions).toBe(0);
    });

    it("should not match TEAM-4 when only TEAM-42 appears in description (word boundary)", () => {
      const event = makeCalEvent({
        description: "Working on TEAM-42 today",
      });
      const result = detectLinearMentions("TEAM-4", [], [], [], [], [event]);
      expect(result.totalMentions).toBe(0);
    });

    it("should match bare text mention even without a Linear URL (Direction 1 asymmetry)", () => {
      // Direction 1 uses text matching — prose mentions populate the Linear card.
      // Direction 2 (buildCalendarCrossRefs) is URL-only, so this same calendar event
      // would NOT get a cross-ref on the calendar card side.
      const event = makeCalEvent({ description: "Working on TEAM-4 today" });
      const result = detectLinearMentions("TEAM-4", [], [], [], [], [event]);
      expect(result.totalMentions).toBe(1);
      expect(result.mentionedIn).toContain("calendar");
    });
  });
});

// ── containsExactToken ─────────────────────────────────────────────────────

describe("containsExactToken", () => {
  it("should match token at end of string", () => {
    expect(containsExactToken("fix #1", "#1")).toBe(true);
  });

  it("should match token followed by space", () => {
    expect(containsExactToken("#1 is ready", "#1")).toBe(true);
  });

  it("should match token followed by punctuation", () => {
    expect(containsExactToken("merged #1, closing", "#1")).toBe(true);
  });

  it("should NOT match token followed by more digits", () => {
    expect(containsExactToken("Request #196", "#1")).toBe(false);
  });

  it("should NOT match partial Linear ID", () => {
    expect(containsExactToken("KIM-123", "KIM-12")).toBe(false);
  });

  it("should match exact Linear ID", () => {
    expect(containsExactToken("KIM-12 is done", "KIM-12")).toBe(true);
  });

  it("should handle regex-special characters in token", () => {
    // The # in "#1" is regex-special; escaping ensures it matches literally
    expect(containsExactToken("fix #42 now", "#42")).toBe(true);
    expect(containsExactToken("fix #42 now", "#4")).toBe(false);
  });
});

// ── detectGitHubMentions ─────────────────────────────────────────────────────

describe("detectGitHubMentions", () => {
  it("should NOT match bare #number in email subject (too ambiguous)", () => {
    // Bare #number is no longer matched — only repo#number and github.com URLs
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [makeEmail({ subject: "Review needed for #42" })],
      []
    );
    expect(result.totalMentions).toBe(0);
  });

  it("should match owner/repo#number pattern", () => {
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [makeEmail({ subject: "Merged org/repo#42" })],
      []
    );
    expect(result.totalMentions).toBe(1);
  });

  it("should match github.com URL pattern", () => {
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [],
      [makeSlackMsg({ text: "https://github.com/org/repo/pull/42" })]
    );
    expect(result.totalMentions).toBe(1);
  });

  it("should NOT match bare #number from unrelated systems", () => {
    // Bare #number is no longer matched, so unrelated references
    // like "Request #196" or "item #42" no longer false-positive
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [makeEmail({ subject: "See item #42 in the backlog" })],
      []
    );
    expect(result.totalMentions).toBe(0);
  });

  it("should return empty when no mentions exist", () => {
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [makeEmail({ subject: "Unrelated email about project" })],
      [makeSlackMsg({ text: "No PR refs here" })]
    );
    expect(result.totalMentions).toBe(0);
  });

  it("should deduplicate sources (multiple emails from same source count once)", () => {
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [
        makeEmail({ id: "msg-1", subject: "org/repo#42 review" }),
        makeEmail({ id: "msg-2", subject: "org/repo#42 merged" }),
      ],
      []
    );
    // Total mentions = 2 (two separate related items)
    expect(result.totalMentions).toBe(2);
    // But mentionedIn is deduplicated — only "gmail" once
    expect(result.mentionedIn).toEqual(["gmail"]);
  });

  it("should find repo#number in email snippet", () => {
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [makeEmail({ subject: "Code review", snippet: "Please review org/repo#42 when you can" })],
      []
    );
    expect(result.totalMentions).toBe(1);
    expect(result.relatedItems[0].url).toBe("https://mail.google.com/inbox/1");
  });

  it("should find GitHub URL in meeting note action item", () => {
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [],
      [],
      [makeMeetingNote({ actionItem: "Merge github.com/org/repo/pull/42 before release" })]
    );
    expect(result.totalMentions).toBe(1);
    expect(result.mentionedIn).toContain("meeting-notes");
  });

  it("should find repo#number in meeting summary", () => {
    const result = detectGitHubMentions(
      "org/repo",
      42,
      [],
      [],
      [],
      [makeMeetingSummary({ subject: "Sprint recap", snippet: "Discussed org/repo#42" })]
    );
    expect(result.totalMentions).toBe(1);
  });

  it("should NOT match #1 inside #196 (the original bug)", () => {
    const result = detectGitHubMentions(
      "kmaida/plan-my-today",
      1,
      [
        makeEmail({
          subject:
            "Kamil Potrec is requesting Engineering - Temporary Admin Access to AWS (Request #196)",
        }),
      ],
      []
    );
    expect(result.totalMentions).toBe(0);
  });
});

// ── linkMeetingAssets ────────────────────────────────────────────────────────

describe("linkMeetingAssets", () => {
  it("should match Zoom email to Granola doc with date prefix", () => {
    const summary = makeMeetingSummary({ meetingTitle: "Sprint Review" });
    const note = makeMeetingNote({
      documentTitle: "2026-02-07 Sprint Review",
    });
    const summaries = [summary];

    linkMeetingAssets(summaries, [note], []);

    expect(summary.relatedMeetingNotes).toHaveLength(1);
    expect(summary.relatedMeetingNotes![0].documentId).toBe("doc-1");
  });

  it("should match calendar event by title", () => {
    const summary = makeMeetingSummary({ meetingTitle: "Sprint Review" });
    const event = makeCalEvent({ summary: "Sprint Review" });
    const summaries = [summary];

    linkMeetingAssets(summaries, [], [event]);

    expect(summary.relatedCalendarEvent).toBeDefined();
    expect(summary.relatedCalendarEvent!.summary).toBe("Sprint Review");
  });

  it("should deduplicate meeting notes by documentId", () => {
    const summary = makeMeetingSummary({ meetingTitle: "Sprint Review" });
    // Two action items from the same document
    const note1 = makeMeetingNote({
      documentId: "doc-1",
      documentTitle: "2026-02-07 Sprint Review",
      actionItem: "Action 1",
    });
    const note2 = makeMeetingNote({
      documentId: "doc-1",
      documentTitle: "2026-02-07 Sprint Review",
      actionItem: "Action 2",
    });
    const summaries = [summary];

    linkMeetingAssets(summaries, [note1, note2], []);

    // Only one note entry even though two action items share the same doc
    expect(summary.relatedMeetingNotes).toHaveLength(1);
  });

  it("should not match when meeting title is empty after normalization", () => {
    const summary = makeMeetingSummary({ meetingTitle: "" });
    const note = makeMeetingNote({
      documentTitle: "2026-02-07 Sprint Review",
    });
    const summaries = [summary];

    linkMeetingAssets(summaries, [note], []);

    expect(summary.relatedMeetingNotes).toBeUndefined();
  });

  it("should skip summaries with no meetingTitle", () => {
    const summary = makeMeetingSummary({ meetingTitle: undefined });
    const note = makeMeetingNote();
    const summaries = [summary];

    linkMeetingAssets(summaries, [note], []);

    expect(summary.relatedMeetingNotes).toBeUndefined();
  });

  it("bidirectional matching: short zoom title matches longer doc title", () => {
    const summary = makeMeetingSummary({ meetingTitle: "Sync" });
    const note = makeMeetingNote({
      documentTitle: "2026-02-07 Team Sync Meeting",
    });
    const summaries = [summary];

    linkMeetingAssets(summaries, [note], []);

    // "sync" is a substring of "team sync meeting" (after normalization)
    expect(summary.relatedMeetingNotes).toHaveLength(1);
  });

  it("bidirectional matching: long zoom title matches shorter doc title", () => {
    const summary = makeMeetingSummary({
      meetingTitle: "Sprint Review and Retrospective",
    });
    const note = makeMeetingNote({
      documentTitle: "Sprint Review and Retrospective",
    });
    const summaries = [summary];

    linkMeetingAssets(summaries, [note], []);

    expect(summary.relatedMeetingNotes).toHaveLength(1);
  });

  it("should normalize whitespace and case for matching", () => {
    const summary = makeMeetingSummary({
      meetingTitle: "  Sprint   Review  ",
    });
    const note = makeMeetingNote({
      documentTitle: "sprint review",
    });
    const summaries = [summary];

    linkMeetingAssets(summaries, [note], []);

    expect(summary.relatedMeetingNotes).toHaveLength(1);
  });

  it("mutates input summaries (side effect)", () => {
    const summaries = [makeMeetingSummary({ meetingTitle: "Sprint Review" })];
    const notes = [makeMeetingNote({ documentTitle: "Sprint Review" })];
    const events = [makeCalEvent({ summary: "Sprint Review" })];

    // Before: no related data
    expect(summaries[0].relatedMeetingNotes).toBeUndefined();
    expect(summaries[0].relatedCalendarEvent).toBeUndefined();

    linkMeetingAssets(summaries, notes, events);

    // After: mutated in place
    expect(summaries[0].relatedMeetingNotes).toBeDefined();
    expect(summaries[0].relatedCalendarEvent).toBeDefined();
  });
});

// ── buildCalendarCrossRefs ───────────────────────────────────────────────────

describe("buildCalendarCrossRefs", () => {
  it("should set crossReferenceMetadata on event that links a Linear issue via URL", () => {
    const issue = makeLinearIssue({
      identifier: "TEAM-4",
      title: "Auth refactor",
      url: "https://linear.app/team/issue/TEAM-4",
    });
    const event = makeCalEvent({
      description: "Focus block for https://linear.app/team/issue/TEAM-4/auth-refactor",
    });

    buildCalendarCrossRefs([event], [issue]);

    expect(event.crossReferenceMetadata).toBeDefined();
    const { relatedItems, mentionedIn, totalMentions } = event.crossReferenceMetadata!;
    expect(relatedItems).toHaveLength(1);
    expect(relatedItems[0].source).toBe("linear");
    expect(relatedItems[0].id).toBe("TEAM-4");
    expect(relatedItems[0].url).toBe("https://linear.app/team/issue/TEAM-4");
    expect(relatedItems[0].snippet).toBe("Auth refactor");
    expect(mentionedIn).toContain("linear");
    expect(totalMentions).toBe(1);
  });

  it("should not mutate event when no description is present", () => {
    const issue = makeLinearIssue({ identifier: "TEAM-4" });
    const event = makeCalEvent(); // no description

    buildCalendarCrossRefs([event], [issue]);

    expect(event.crossReferenceMetadata).toBeUndefined();
  });

  it("should deduplicate when the same Linear URL appears twice in description", () => {
    const issue = makeLinearIssue({ identifier: "TEAM-4" });
    const url = "https://linear.app/team/issue/TEAM-4/title";
    const event = makeCalEvent({ description: `${url} and also ${url}` });

    buildCalendarCrossRefs([event], [issue]);

    expect(event.crossReferenceMetadata!.relatedItems).toHaveLength(1);
    expect(event.crossReferenceMetadata!.totalMentions).toBe(1);
  });

  it("should populate multiple distinct issues from one description", () => {
    const issueA = makeLinearIssue({
      identifier: "TEAM-4",
      title: "Issue A",
      url: "https://linear.app/team/issue/TEAM-4",
    });
    const issueB = makeLinearIssue({
      identifier: "TEAM-5",
      title: "Issue B",
      url: "https://linear.app/team/issue/TEAM-5",
    });
    const event = makeCalEvent({
      description:
        "https://linear.app/team/issue/TEAM-4/a and https://linear.app/team/issue/TEAM-5/b",
    });

    buildCalendarCrossRefs([event], [issueA, issueB]);

    const ids = event.crossReferenceMetadata!.relatedItems.map((r) => r.id);
    expect(ids).toContain("TEAM-4");
    expect(ids).toContain("TEAM-5");
    expect(event.crossReferenceMetadata!.relatedItems).toHaveLength(2);
  });

  it("should fall back to URL from description when issue is not in linearIssues", () => {
    const event = makeCalEvent({
      description: "https://linear.app/team/issue/TEAM-99/unknown-issue",
    });

    buildCalendarCrossRefs([event], []); // empty issues list — issue not fetched today

    expect(event.crossReferenceMetadata).toBeDefined();
    expect(event.crossReferenceMetadata!.relatedItems[0].id).toBe("TEAM-99");
    // The regex captures up to the identifier only (match[0] = "https://linear.app/team/issue/TEAM-99")
    // The slug (/unknown-issue) is not included — but the URL is still a valid Linear link
    expect(event.crossReferenceMetadata!.relatedItems[0].url).toBe(
      "https://linear.app/team/issue/TEAM-99"
    );
    // Snippet falls back to identifier when issue title is unavailable
    expect(event.crossReferenceMetadata!.relatedItems[0].snippet).toBe("TEAM-99");
  });

  it("should not mutate event when description contains no Linear URLs", () => {
    // Prose mentioning an identifier (not a URL) must NOT trigger URL-based extraction
    const event = makeCalEvent({
      description: "Working on TEAM-4 today (no URL link present)",
    });
    const issue = makeLinearIssue({ identifier: "TEAM-4" });

    buildCalendarCrossRefs([event], [issue]);

    expect(event.crossReferenceMetadata).toBeUndefined();
  });
});

// ── buildSourceLinearCrossRefs ───────────────────────────────────────────────

describe("buildSourceLinearCrossRefs", () => {
  describe("Gmail", () => {
    it("should populate crossReferenceMetadata when email subject contains issue identifier", () => {
      const issue = makeLinearIssue({
        identifier: "TEAM-4",
        title: "Auth refactor",
        url: "https://linear.app/team/issue/TEAM-4",
      });
      const email = makeEmail({ subject: "Re: TEAM-4 is blocked" });

      buildSourceLinearCrossRefs([issue], [email], [], []);

      expect(email.crossReferenceMetadata).toBeDefined();
      expect(email.crossReferenceMetadata!.relatedItems[0].source).toBe("linear");
      expect(email.crossReferenceMetadata!.relatedItems[0].id).toBe("TEAM-4");
      expect(email.crossReferenceMetadata!.relatedItems[0].url).toBe(
        "https://linear.app/team/issue/TEAM-4"
      );
    });

    it("should populate crossReferenceMetadata when issue identifier is in email snippet", () => {
      const issue = makeLinearIssue({ identifier: "TEAM-4" });
      const email = makeEmail({ subject: "Quick update", snippet: "See TEAM-4 for details" });

      buildSourceLinearCrossRefs([issue], [email], [], []);

      expect(email.crossReferenceMetadata).toBeDefined();
    });

    it("should not mutate email when subject and snippet do not mention any issue", () => {
      const issue = makeLinearIssue({ identifier: "TEAM-4" });
      const email = makeEmail({ subject: "Unrelated email" });

      buildSourceLinearCrossRefs([issue], [email], [], []);

      expect(email.crossReferenceMetadata).toBeUndefined();
    });
  });

  describe("Slack", () => {
    it("should populate crossReferenceMetadata when message text contains issue identifier", () => {
      const issue = makeLinearIssue({
        identifier: "TEAM-4",
        title: "Auth refactor",
        url: "https://linear.app/team/issue/TEAM-4",
      });
      const msg = makeSlackMsg({ text: "Just submitted TEAM-4 for review" });

      buildSourceLinearCrossRefs([issue], [], [msg], []);

      expect(msg.crossReferenceMetadata).toBeDefined();
      expect(msg.crossReferenceMetadata!.relatedItems[0].id).toBe("TEAM-4");
    });

    it("should not mutate message when text does not mention any issue", () => {
      const issue = makeLinearIssue({ identifier: "TEAM-4" });
      const msg = makeSlackMsg({ text: "Lunch at noon" });

      buildSourceLinearCrossRefs([issue], [], [msg], []);

      expect(msg.crossReferenceMetadata).toBeUndefined();
    });
  });

  describe("Meeting notes — forward scan regression", () => {
    it("should only populate the specific note whose actionItem mentions the issue", () => {
      // Regression guard: reverse-mapping would populate ALL notes from a document because
      // detectLinearMentions uses documentId as relatedItem.id. Forward scan checks each
      // note's actionItem individually, so only the matching note gets populated.
      const issue = makeLinearIssue({ identifier: "TEAM-4" });
      const noteWithMatch = makeMeetingNote({
        documentId: "doc-1",
        documentTitle: "Sprint Review",
        actionItem: "Fix TEAM-4 before release",
      });
      const noteWithoutMatch = makeMeetingNote({
        documentId: "doc-1", // same document — reverse mapping would populate this incorrectly
        documentTitle: "Sprint Review",
        actionItem: "Update the changelog",
      });

      buildSourceLinearCrossRefs([issue], [], [], [noteWithMatch, noteWithoutMatch]);

      expect(noteWithMatch.crossReferenceMetadata).toBeDefined();
      expect(noteWithMatch.crossReferenceMetadata!.relatedItems[0].id).toBe("TEAM-4");
      // This note's actionItem does NOT mention TEAM-4 — must NOT be populated
      expect(noteWithoutMatch.crossReferenceMetadata).toBeUndefined();
    });

    it("should not mutate note when actionItem does not mention any issue", () => {
      const issue = makeLinearIssue({ identifier: "TEAM-4" });
      const note = makeMeetingNote({ actionItem: "Follow up with design team" });

      buildSourceLinearCrossRefs([issue], [], [], [note]);

      expect(note.crossReferenceMetadata).toBeUndefined();
    });
  });

  describe("deduplication", () => {
    it("should count as one match when identifier appears in both subject and snippet", () => {
      // buildSourceLinearCrossRefs concatenates subject + snippet and calls containsExactToken
      // once per (email, issue) pair — one match → one appendCrossRef call.
      const issue = makeLinearIssue({ identifier: "TEAM-4" });
      const email = makeEmail({ subject: "Re: TEAM-4", snippet: "TEAM-4 is still open" });

      buildSourceLinearCrossRefs([issue], [email], [], []);

      expect(email.crossReferenceMetadata!.relatedItems).toHaveLength(1);
      expect(email.crossReferenceMetadata!.totalMentions).toBe(1);
    });

    it("should accumulate refs for multiple distinct issues that appear in one item", () => {
      const issueA = makeLinearIssue({ identifier: "TEAM-4", title: "Issue A" });
      const issueB = makeLinearIssue({ identifier: "TEAM-5", title: "Issue B" });
      const email = makeEmail({ subject: "TEAM-4 and TEAM-5 updates" });

      buildSourceLinearCrossRefs([issueA, issueB], [email], [], []);

      expect(email.crossReferenceMetadata!.relatedItems).toHaveLength(2);
      const ids = email.crossReferenceMetadata!.relatedItems.map((r) => r.id);
      expect(ids).toContain("TEAM-4");
      expect(ids).toContain("TEAM-5");
    });

    it("appendCrossRef dedup guard: should not add a ref whose id already exists in relatedItems", () => {
      // This exercises appendCrossRef's own dedup guard (relatedItems.some(r => r.id === ref.id)).
      // The guard fires when an item's crossReferenceMetadata is pre-populated with a ref whose id
      // matches what buildSourceLinearCrossRefs would add. The current callers never produce this
      // scenario organically, so we set it up manually by pre-populating the email.
      const issue = makeLinearIssue({ identifier: "TEAM-4" });
      const email = makeEmail({ subject: "Re: TEAM-4" });
      email.crossReferenceMetadata = {
        mentionedIn: ["linear"],
        relatedItems: [
          {
            source: "linear",
            id: "TEAM-4",
            snippet: "Pre-existing ref",
            url: "https://linear.app/team/issue/TEAM-4",
          },
        ],
        totalMentions: 1,
      };

      buildSourceLinearCrossRefs([issue], [email], [], []);

      // appendCrossRef's guard should block the duplicate — counts stay at 1
      expect(email.crossReferenceMetadata.relatedItems).toHaveLength(1);
      expect(email.crossReferenceMetadata.totalMentions).toBe(1);
    });
  });
});
