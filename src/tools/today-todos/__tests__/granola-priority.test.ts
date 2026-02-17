/**
 * Tests for calculateMeetingNotePriority — the scoring algorithm that
 * determines meeting note action item ordering on the dashboard.
 *
 * Pure function: MeetingNoteActionDetail → PriorityMetadata.
 * Scoring: base 80, recency tiers (+10/+30/+50), urgency (+40),
 * assignee (+20), cap at 300.
 */

import { calculateMeetingNotePriority } from "../granola-utils";
import type { MeetingNoteActionDetail } from "../types";

/** Build a minimal action item for testing. Override any fields as needed. */
function makeAction(
  overrides: Partial<MeetingNoteActionDetail> & { timestamp: number }
): MeetingNoteActionDetail {
  return {
    documentId: "doc-1",
    documentTitle: "Test Meeting",
    documentLink: "https://docs.google.com/document/d/doc-1",
    actionItem: "Follow up with vendor",
    isUrgent: false,
    ...overrides,
  };
}

// ── Base score ───────────────────────────────────────────────────────────────

describe("base score (no bonuses)", () => {
  it("returns 80 for an old, non-urgent, unassigned item", () => {
    const now = new Date("2026-02-17T12:00:00");
    // 48 hours ago — outside all recency tiers
    const action = makeAction({
      timestamp: now.getTime() - 48 * 60 * 60 * 1000,
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(80);
    expect(result.category).toBe("medium");
    expect(result.reasons).toHaveLength(0);
  });
});

// ── Recency tiers ────────────────────────────────────────────────────────────

describe("recency scoring", () => {
  const now = new Date("2026-02-17T12:00:00");

  it("adds +50 for items less than 1 hour old", () => {
    const action = makeAction({
      timestamp: now.getTime() - 30 * 60 * 1000, // 30 min ago
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(130); // 80 + 50
    expect(result.category).toBe("high");
    expect(result.reasons).toContain("Very recent meeting notes");
  });

  it("adds +30 for items 1-4 hours old", () => {
    const action = makeAction({
      timestamp: now.getTime() - 2 * 60 * 60 * 1000, // 2 hours ago
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(110); // 80 + 30
    expect(result.reasons).toContain("Recent meeting notes");
  });

  it("adds +10 for items 4-24 hours old", () => {
    const action = makeAction({
      timestamp: now.getTime() - 8 * 60 * 60 * 1000, // 8 hours ago
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(90); // 80 + 10
    expect(result.reasons).toContain("From today");
  });

  it("adds nothing for items older than 24 hours", () => {
    const action = makeAction({
      timestamp: now.getTime() - 48 * 60 * 60 * 1000, // 2 days ago
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(80);
    expect(result.reasons).toHaveLength(0);
  });
});

// ── meetingDate vs timestamp ────────────────────────────────────────────────

describe("meetingDate takes precedence over timestamp", () => {
  const now = new Date("2026-02-17T12:00:00");

  it("uses meetingDate when available (ignores timestamp)", () => {
    const action = makeAction({
      // timestamp says 48h ago (no recency bonus)
      timestamp: now.getTime() - 48 * 60 * 60 * 1000,
      // meetingDate says 30 min ago (very recent bonus)
      meetingDate: new Date(now.getTime() - 30 * 60 * 1000),
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(130); // 80 + 50 (from meetingDate, not timestamp)
    expect(result.signals.usedMeetingDate).toBe(true);
  });

  it("falls back to timestamp when meetingDate is undefined", () => {
    const action = makeAction({
      timestamp: now.getTime() - 2 * 60 * 60 * 1000, // 2 hours ago
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(110); // 80 + 30
    expect(result.signals.usedMeetingDate).toBe(false);
  });
});

// ── Urgency bonus ────────────────────────────────────────────────────────────

describe("urgency bonus", () => {
  it("adds +40 for urgent items", () => {
    const now = new Date("2026-02-17T12:00:00");
    const action = makeAction({
      timestamp: now.getTime() - 48 * 60 * 60 * 1000,
      isUrgent: true,
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(120); // 80 + 40
    expect(result.reasons).toContain("Marked as urgent");
    expect(result.signals.isUrgent).toBe(true);
  });

  it("does not add urgency bonus for non-urgent items", () => {
    const now = new Date("2026-02-17T12:00:00");
    const action = makeAction({
      timestamp: now.getTime() - 48 * 60 * 60 * 1000,
      isUrgent: false,
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.signals.isUrgent).toBe(false);
    expect(result.reasons).not.toContain("Marked as urgent");
  });
});

// ── Assignee bonus ───────────────────────────────────────────────────────────

describe("assignee bonus", () => {
  it("adds +20 when assignee is present", () => {
    const now = new Date("2026-02-17T12:00:00");
    const action = makeAction({
      timestamp: now.getTime() - 48 * 60 * 60 * 1000,
      assignee: "Kim",
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBe(100); // 80 + 20
    expect(result.reasons).toContain("Assigned to Kim");
    expect(result.signals.assignee).toBe("Kim");
    expect(result.signals.hasAssignee).toBe(true);
  });

  it("does not add assignee bonus when assignee is undefined", () => {
    const now = new Date("2026-02-17T12:00:00");
    const action = makeAction({
      timestamp: now.getTime() - 48 * 60 * 60 * 1000,
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.signals.hasAssignee).toBe(false);
  });
});

// ── Stacking and cap ─────────────────────────────────────────────────────────

describe("bonus stacking and score cap", () => {
  it("stacks all bonuses: very recent + urgent + assignee", () => {
    const now = new Date("2026-02-17T12:00:00");
    const action = makeAction({
      timestamp: now.getTime() - 30 * 60 * 1000, // 30 min ago
      isUrgent: true,
      assignee: "Kim",
    });

    const result = calculateMeetingNotePriority(action, now);

    // 80 + 50 (very recent) + 40 (urgent) + 20 (assignee) = 190
    expect(result.score).toBe(190);
    expect(result.category).toBe("critical");
    expect(result.reasons).toHaveLength(3);
  });

  it("caps score at 300", () => {
    const now = new Date("2026-02-17T12:00:00");
    // This is a sanity check — current max is 190, well below 300.
    // The cap guards against future scoring additions that could inflate scores.
    const action = makeAction({
      timestamp: now.getTime() - 30 * 60 * 1000,
      isUrgent: true,
      assignee: "Kim",
    });

    const result = calculateMeetingNotePriority(action, now);

    expect(result.score).toBeLessThanOrEqual(300);
  });
});
