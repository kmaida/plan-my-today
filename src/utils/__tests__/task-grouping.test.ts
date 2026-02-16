/**
 * Tests for the UI's task grouping utility.
 *
 * groupTasks() organizes a flat task array into labeled groups based on
 * the active view mode (priority or source). Uses the same factory helpers
 * as task-helpers.test.ts.
 *
 * Note: SourceIcon.tsx imports CSS, so we mock getSourceLabel to avoid
 * pulling React and CSS processing into the Jest environment.
 */

jest.mock("../../../ui/src/components/SourceIcon", () => ({
  getSourceLabel: (source: string) => {
    const labels: Record<string, string> = {
      linear: "Linear",
      github: "GitHub",
      gmail: "Gmail",
      slack: "Slack",
      calendar: "Calendar",
      drive: "Google Drive",
      "meeting-notes": "Meeting Notes",
      "github-issue": "GitHub Issues",
    };
    return labels[source] || source;
  },
}));

import type {
  GitHubTask,
  GmailTask,
  LinearTask,
  PriorityMetadata,
  SlackTask,
  Task,
} from "../../../ui/src/types/tasks";
import { groupTasks } from "../../../ui/src/utils/taskGrouping";

// ── Factories ────────────────────────────────────────────────────────────────

function makePriority(category: PriorityMetadata["category"], score: number): PriorityMetadata {
  return { score, category, signals: [], reasons: "" };
}

function makeLinear(overrides: Partial<LinearTask> = {}): LinearTask {
  return {
    source: "linear",
    taskId: "linear-1",
    stableId: "linear:KIM-1",
    identifier: "KIM-1",
    title: "Fix bug",
    url: "https://linear.app/team/KIM-1",
    priorityMetadata: makePriority("medium", 100),
    ...overrides,
  };
}

function makeGmail(overrides: Partial<GmailTask> = {}): GmailTask {
  return {
    source: "gmail",
    taskId: "gmail-1",
    stableId: "gmail:msg-1",
    id: "msg-1",
    subject: "Update",
    from: "alice@example.com",
    link: "https://mail.google.com",
    timestamp: new Date().toISOString(),
    priorityMetadata: makePriority("low", 30),
    ...overrides,
  };
}

function makeSlack(overrides: Partial<SlackTask> = {}): SlackTask {
  return {
    source: "slack",
    taskId: "slack-1",
    stableId: "slack:general:123",
    text: "Hey",
    timestamp: "123.000",
    channel: "general",
    user: "bob",
    type: "mention",
    priorityMetadata: makePriority("high", 150),
    ...overrides,
  };
}

function makeGitHub(overrides: Partial<GitHubTask> = {}): GitHubTask {
  return {
    source: "github",
    taskId: "gh-1",
    stableId: "github-pr:org/repo:1",
    number: 1,
    title: "Add feature",
    url: "https://github.com/org/repo/pull/1",
    repo: "org/repo",
    type: "review",
    priorityMetadata: makePriority("medium", 90),
    ...overrides,
  };
}

// ── Priority view ────────────────────────────────────────────────────────────

describe("groupTasks — priority view", () => {
  it("returns empty array for empty input", () => {
    expect(groupTasks([], "priority")).toEqual([]);
  });

  it("groups tasks into priority buckets", () => {
    const tasks: Task[] = [
      makeLinear({
        taskId: "l1",
        priorityMetadata: makePriority("critical", 200),
      }),
      makeSlack({
        taskId: "s1",
        priorityMetadata: makePriority("high", 150),
      }),
      makeGmail({
        taskId: "g1",
        priorityMetadata: makePriority("low", 20),
      }),
      makeGitHub({
        taskId: "gh1",
        priorityMetadata: makePriority("medium", 90),
      }),
    ];

    const groups = groupTasks(tasks, "priority");

    expect(groups.map((g) => g.label)).toEqual(["Critical", "High", "Medium", "Low"]);
    expect(groups[0].count).toBe(1); // Critical
    expect(groups[1].count).toBe(1); // High
    expect(groups[2].count).toBe(1); // Medium
    expect(groups[3].count).toBe(1); // Low
  });

  it("omits empty priority buckets", () => {
    const tasks: Task[] = [
      makeLinear({
        taskId: "l1",
        priorityMetadata: makePriority("high", 150),
      }),
      makeLinear({
        taskId: "l2",
        priorityMetadata: makePriority("high", 140),
      }),
    ];

    const groups = groupTasks(tasks, "priority");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("High");
    expect(groups[0].count).toBe(2);
  });

  it("sorts tasks within each group by score descending", () => {
    const tasks: Task[] = [
      makeLinear({
        taskId: "l-low",
        title: "Low score",
        priorityMetadata: makePriority("high", 131),
      }),
      makeLinear({
        taskId: "l-high",
        title: "High score",
        priorityMetadata: makePriority("high", 170),
      }),
      makeLinear({
        taskId: "l-mid",
        title: "Mid score",
        priorityMetadata: makePriority("high", 150),
      }),
    ];

    const groups = groupTasks(tasks, "priority");
    const scores = groups[0].tasks.map((t) => t.priorityMetadata.score);
    expect(scores).toEqual([170, 150, 131]);
  });
});

// ── Source view ──────────────────────────────────────────────────────────────

describe("groupTasks — source view", () => {
  it("returns empty array for empty input", () => {
    expect(groupTasks([], "source")).toEqual([]);
  });

  it("groups tasks by source with correct labels", () => {
    const tasks: Task[] = [
      makeLinear({ taskId: "l1" }),
      makeGmail({ taskId: "g1" }),
      makeSlack({ taskId: "s1" }),
    ];

    const groups = groupTasks(tasks, "source");
    const labels = groups.map((g) => g.label);

    expect(labels).toContain("Linear");
    expect(labels).toContain("Gmail");
    expect(labels).toContain("Slack");
  });

  it("follows defined source order (linear before gmail before slack)", () => {
    // Insert in reverse order to verify sorting isn't just insertion order
    const tasks: Task[] = [
      makeSlack({ taskId: "s1" }),
      makeGmail({ taskId: "g1" }),
      makeLinear({ taskId: "l1" }),
    ];

    const groups = groupTasks(tasks, "source");
    const labels = groups.map((g) => g.label);

    // Expected order from SOURCE_ORDER: linear, github, gmail, slack, calendar, docs, meeting-notes
    expect(labels.indexOf("Linear")).toBeLessThan(labels.indexOf("Gmail"));
    expect(labels.indexOf("Gmail")).toBeLessThan(labels.indexOf("Slack"));
  });

  it("normalizes github-issue into github group", () => {
    const tasks: Task[] = [
      makeGitHub({ taskId: "pr-1", source: "github" }),
      makeGitHub({ taskId: "issue-1", source: "github-issue" }),
    ];

    const groups = groupTasks(tasks, "source");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("GitHub");
    expect(groups[0].count).toBe(2);
  });

  it("sorts tasks within each source group by priority score descending", () => {
    const tasks: Task[] = [
      makeLinear({
        taskId: "l-low",
        priorityMetadata: makePriority("low", 30),
      }),
      makeLinear({
        taskId: "l-high",
        priorityMetadata: makePriority("critical", 200),
      }),
    ];

    const groups = groupTasks(tasks, "source");
    const scores = groups[0].tasks.map((t) => t.priorityMetadata.score);
    expect(scores).toEqual([200, 30]);
  });
});
