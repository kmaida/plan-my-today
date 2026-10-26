/**
 * Tests for calculateLinearPriority.
 *
 * This is the sole score-assignment path for Linear issues; wrong weights
 * silently mis-rank every Linear task in the dashboard.
 *
 * Design notes:
 * - `now` (the parameter) only controls ageHours for recency boost. Fix it to NOW.
 * - Due-date comparisons inside the function use `new Date()` directly, not `now`,
 *   so temporal urgency tests compute dates via dateStr() relative to the system clock.
 * - calculateLinearPriority does not read `issue.relationMetadata`; no relation tests needed.
 */

import { calculateLinearPriority } from "../linear-utils";
import type { LinearIssueDetail } from "../types";

// Fixed reference time for the `now` parameter — controls recency boost only.
const NOW = new Date("2026-10-26T12:00:00.000Z");

function makeIssue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    identifier: "KIM-1",
    title: "Test issue",
    priority: 4,
    priorityLabel: "Low",
    url: "https://linear.app/test/issue/KIM-1",
    state: null,
    dueDate: null,
    estimate: null,
    project: null,
    ...overrides,
  };
}

/** Returns a YYYY-MM-DD string offset by `days` from today's system date. */
function dateStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

// ── Temporal urgency ──

describe("temporal urgency", () => {
  it("should set no_due_date when dueDate is null and add no temporal score", () => {
    const result = calculateLinearPriority(makeIssue(), NOW);
    expect(result.signals.temporalUrgency).toBe("no_due_date");
    expect(result.signals.daysUntilDue).toBeNull();
    expect(result.score).toBe(70); // base only
  });

  it("should set overdue for a past due date and add +100 to score", () => {
    const result = calculateLinearPriority(makeIssue({ dueDate: dateStr(-1) }), NOW);
    expect(result.signals.temporalUrgency).toBe("overdue");
    expect(result.reasons).toContain("Overdue");
    expect(result.score).toBe(170); // base 70 + overdue 100
  });

  it("should set due_today for today's date and add +80 to score", () => {
    const result = calculateLinearPriority(makeIssue({ dueDate: dateStr(0) }), NOW);
    expect(result.signals.temporalUrgency).toBe("due_today");
    expect(result.reasons).toContain("Due today");
    expect(result.score).toBe(150); // base 70 + due_today 80
  });

  it("should set due_this_week for a date 3 days out and add +40 to score", () => {
    const result = calculateLinearPriority(makeIssue({ dueDate: dateStr(3) }), NOW);
    expect(result.signals.temporalUrgency).toBe("due_this_week");
    expect(result.reasons).toContain("Due soon");
    expect(result.score).toBe(110); // base 70 + due_this_week 40
  });

  it("should set due_later for a date 14 days out and add +10 to score", () => {
    const result = calculateLinearPriority(makeIssue({ dueDate: dateStr(14) }), NOW);
    expect(result.signals.temporalUrgency).toBe("due_later");
    expect(result.score).toBe(80); // base 70 + due_later 10
  });
});

// ── Linear priority levels ──

describe("Linear priority levels", () => {
  it("should add +50 and 'Urgent priority' reason for priority 1 (Urgent)", () => {
    const result = calculateLinearPriority(
      makeIssue({ priority: 1, priorityLabel: "Urgent" }),
      NOW
    );
    expect(result.score).toBe(120); // base 70 + urgent 50
    expect(result.reasons).toContain("Urgent priority");
    expect(result.signals.priorityLevel).toBe(1);
  });

  it("should add +30 and 'High priority' reason for priority 2 (High)", () => {
    const result = calculateLinearPriority(makeIssue({ priority: 2, priorityLabel: "High" }), NOW);
    expect(result.score).toBe(100); // base 70 + high 30
    expect(result.reasons).toContain("High priority");
    expect(result.signals.priorityLevel).toBe(2);
  });

  it("should add no priority boost for priority 3 (Medium)", () => {
    const result = calculateLinearPriority(
      makeIssue({ priority: 3, priorityLabel: "Medium" }),
      NOW
    );
    expect(result.score).toBe(70); // base only
    expect(result.reasons).not.toContain("Urgent priority");
    expect(result.reasons).not.toContain("High priority");
  });

  it("should add no priority boost for priority 4 (Low)", () => {
    const result = calculateLinearPriority(makeIssue({ priority: 4, priorityLabel: "Low" }), NOW);
    expect(result.score).toBe(70); // base only
    expect(result.reasons).not.toContain("Urgent priority");
    expect(result.reasons).not.toContain("High priority");
  });

  it("should add +50 for priority 0 (No priority) because the priority <= 1 branch fires", () => {
    // Linear API uses 0 for "No priority"; the <= 1 check applies the urgent boost.
    const result = calculateLinearPriority(
      makeIssue({ priority: 0, priorityLabel: "No priority" }),
      NOW
    );
    expect(result.score).toBe(120); // base 70 + <= 1 branch 50
    expect(result.reasons).toContain("Urgent priority");
  });
});

// ── State boost ──

describe("state boost", () => {
  it("should add +10 and 'In progress' reason for started state", () => {
    const result = calculateLinearPriority(
      makeIssue({ state: { name: "In Progress", type: "started" } }),
      NOW
    );
    expect(result.score).toBe(80); // base 70 + state 10
    expect(result.reasons).toContain("In progress");
  });

  it("should add 'Recently completed' reason for completed state without changing score", () => {
    const result = calculateLinearPriority(
      makeIssue({ state: { name: "Done", type: "completed" } }),
      NOW
    );
    expect(result.reasons).toContain("Recently completed");
    expect(result.signals.isCompleted).toBe(true);
    expect(result.score).toBe(70); // no score boost for completed
  });

  it("should add no state boost for null state", () => {
    const result = calculateLinearPriority(makeIssue({ state: null }), NOW);
    expect(result.score).toBe(70);
    expect(result.reasons).not.toContain("In progress");
  });
});

// ── Recency boost ──
// Recency only fires when hasPriorityOrDueDate = (priority >= 1 || !!dueDate).
// priority 0 with no dueDate is the only combination that skips it.

describe("recency boost", () => {
  it("should add +30 when updated within 24 hours and issue has priority", () => {
    const updatedAt = new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const result = calculateLinearPriority(
      makeIssue({ priority: 2, priorityLabel: "High", updatedAt }),
      NOW
    );
    expect(result.score).toBe(130); // base 70 + high 30 + recency 30
    expect(result.reasons).toContain("Updated in last 24 hours");
    expect(result.signals.recentlyUpdated).toBe(true);
  });

  it("should add +20 when updated between 24 and 72 hours ago", () => {
    const updatedAt = new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const result = calculateLinearPriority(
      makeIssue({ priority: 2, priorityLabel: "High", updatedAt }),
      NOW
    );
    expect(result.score).toBe(120); // base 70 + high 30 + recency 20
    expect(result.reasons).toContain("Updated recently");
  });

  it("should add +10 when updated between 72 and 168 hours ago", () => {
    const updatedAt = new Date(NOW.getTime() - 120 * 60 * 60 * 1000).toISOString();
    const result = calculateLinearPriority(
      makeIssue({ priority: 2, priorityLabel: "High", updatedAt }),
      NOW
    );
    expect(result.score).toBe(110); // base 70 + high 30 + recency 10
    expect(result.reasons).toContain("Updated this week");
    expect(result.signals.recentlyUpdated).toBe(true);
  });

  it("should add no recency boost when updated more than 168 hours ago", () => {
    const updatedAt = new Date(NOW.getTime() - 200 * 60 * 60 * 1000).toISOString();
    const result = calculateLinearPriority(
      makeIssue({ priority: 2, priorityLabel: "High", updatedAt }),
      NOW
    );
    expect(result.score).toBe(100); // base 70 + high 30, no recency
    expect(result.signals.recentlyUpdated).toBe(false);
  });

  it("should skip recency boost for priority 0 with no due date", () => {
    // hasPriorityOrDueDate = (0 >= 1 = false) && (no dueDate) → recency disabled.
    // The priority <= 1 boost still fires, so score = 70 + 50 = 120.
    const updatedAt = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const result = calculateLinearPriority(
      makeIssue({ priority: 0, priorityLabel: "No priority", updatedAt }),
      NOW
    );
    expect(result.score).toBe(120); // base 70 + priority boost 50, no recency
    expect(result.reasons).not.toContain("Updated in last 24 hours");
  });

  it("should set ageHours to null and recentlyUpdated to false when updatedAt is absent", () => {
    const result = calculateLinearPriority(makeIssue({ updatedAt: undefined }), NOW);
    expect(result.signals.ageHours).toBeNull();
    expect(result.signals.recentlyUpdated).toBe(false);
  });
});

// ── Signal fields ──

describe("signal fields", () => {
  it("should set hasEstimate true and estimatePoints when estimate is set", () => {
    const result = calculateLinearPriority(makeIssue({ estimate: 3 }), NOW);
    expect(result.signals.hasEstimate).toBe(true);
    expect(result.signals.estimatePoints).toBe(3);
  });

  it("should set hasEstimate false and estimatePoints null when estimate is null", () => {
    const result = calculateLinearPriority(makeIssue({ estimate: null }), NOW);
    expect(result.signals.hasEstimate).toBe(false);
    expect(result.signals.estimatePoints).toBeNull();
  });

  it("should derive category from score via categorizeScore", () => {
    // score 170 (overdue) → "high" (>= 130)
    const overdue = calculateLinearPriority(makeIssue({ dueDate: dateStr(-1) }), NOW);
    expect(overdue.category).toBe("high");

    // score 70 (base only) → "low" (< 80)
    const base = calculateLinearPriority(makeIssue(), NOW);
    expect(base.category).toBe("low");
  });
});
