/**
 * Tests for buildActionDetails — the helper that transforms extracted action
 * items into MeetingNoteActionDetail objects with user-name filtering and
 * priority scoring.
 *
 * Used by both the cache-hit and cache-miss paths in fetchMeetingNoteActions.
 * Reads config.userDisplayNames for filtering — mocked here to control behavior.
 */

// ── Mock config ──
// Must be declared before jest.mock because constants.ts reads config at
// module load time (SLACK_SAVED_MESSAGES.EMOJI_NAME = config.slackEmojiName).
// Using a mutable object + getter defers reads to test time.
const mockConfig: Record<string, unknown> = {
  userDisplayNames: ["kim"],
  slackEmojiName: "test-emoji",
};

jest.mock("../../../config", () => ({
  get config() {
    return mockConfig;
  },
}));

import { buildActionDetails } from "../granola-utils";

// ── Fixtures ──

const DOC = {
  id: "doc-123",
  name: "Team Sync - 2026-02-17",
  webViewLink: "https://docs.google.com/document/d/doc-123/edit",
};

const DOC_NO_LINK = {
  id: "doc-456",
  name: "Quick Chat",
};

const TIMESTAMP = new Date("2026-02-17T10:00:00").getTime();
const MEETING_DATE = new Date("2026-02-17");
const NOW = new Date("2026-02-17T12:00:00");

// ── Basic field mapping ──────────────────────────────────────────────────────

describe("field mapping", () => {
  it("maps extracted items to MeetingNoteActionDetail correctly", () => {
    const items = [{ text: "Follow up with vendor", assignee: "Kim", isUrgent: false }];

    const result = buildActionDetails(items, DOC, TIMESTAMP, MEETING_DATE, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].documentId).toBe("doc-123");
    expect(result[0].documentTitle).toBe("Team Sync - 2026-02-17");
    expect(result[0].documentLink).toBe("https://docs.google.com/document/d/doc-123/edit");
    expect(result[0].actionItem).toBe("Follow up with vendor");
    expect(result[0].assignee).toBe("Kim");
    expect(result[0].isUrgent).toBe(false);
    expect(result[0].timestamp).toBe(TIMESTAMP);
    expect(result[0].meetingDate).toEqual(MEETING_DATE);
  });

  it("falls back to constructed link when webViewLink is undefined", () => {
    const items = [{ text: "Do the thing", isUrgent: false }];

    const result = buildActionDetails(items, DOC_NO_LINK, TIMESTAMP, null, NOW);

    expect(result[0].documentLink).toBe("https://docs.google.com/document/d/doc-456");
  });

  it("sets meetingDate to undefined when passed null", () => {
    const items = [{ text: "Do the thing", isUrgent: false }];

    const result = buildActionDetails(items, DOC, TIMESTAMP, null, NOW);

    expect(result[0].meetingDate).toBeUndefined();
  });

  it("attaches priorityMetadata to each result", () => {
    const items = [{ text: "Ship the feature", isUrgent: true }];

    const result = buildActionDetails(items, DOC, TIMESTAMP, MEETING_DATE, NOW);

    expect(result[0].priorityMetadata).toBeDefined();
    expect(result[0].priorityMetadata?.score).toBeGreaterThan(0);
  });
});

// ── User-name filtering ──────────────────────────────────────────────────────

describe("user-name filtering", () => {
  beforeEach(() => {
    mockConfig.userDisplayNames = ["kim"];
  });

  it("keeps items with no assignee (unassigned = potentially mine)", () => {
    const items = [{ text: "Unassigned task", isUrgent: false }];

    const result = buildActionDetails(items, DOC, TIMESTAMP, null, NOW);

    expect(result).toHaveLength(1);
  });

  it("keeps items assigned to the configured user", () => {
    const items = [{ text: "Kim: review the PR", assignee: "Kim", isUrgent: false }];

    const result = buildActionDetails(items, DOC, TIMESTAMP, null, NOW);

    expect(result).toHaveLength(1);
  });

  it("drops items assigned to someone else", () => {
    const items = [{ text: "Alex: update the docs", assignee: "Alex", isUrgent: false }];

    const result = buildActionDetails(items, DOC, TIMESTAMP, null, NOW);

    expect(result).toHaveLength(0);
  });

  it("keeps items that mention the user in the text (even with different assignee)", () => {
    // containsExactToken checks both assignee AND text
    const items = [
      {
        text: "Kim should pair with Alex on this",
        assignee: "Alex",
        isUrgent: false,
      },
    ];

    const result = buildActionDetails(items, DOC, TIMESTAMP, null, NOW);

    expect(result).toHaveLength(1);
  });

  it("returns all items when no user names are configured", () => {
    mockConfig.userDisplayNames = [];
    const items = [
      { text: "Task for Kim", assignee: "Kim", isUrgent: false },
      { text: "Task for Alex", assignee: "Alex", isUrgent: false },
      { text: "Unassigned task", isUrgent: false },
    ];

    const result = buildActionDetails(items, DOC, TIMESTAMP, null, NOW);

    expect(result).toHaveLength(3);
  });

  it("is case-insensitive for user name matching", () => {
    // containsExactToken lowercases both sides
    const items = [{ text: "KIM: do the thing", assignee: "KIM", isUrgent: false }];

    const result = buildActionDetails(items, DOC, TIMESTAMP, null, NOW);

    expect(result).toHaveLength(1);
  });
});
