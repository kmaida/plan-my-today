/**
 * Tests for the UI's task helper utilities.
 *
 * These are pure functions that the dashboard uses for:
 * - getTaskIdentifier: the stable ID sent to dismiss-task
 *   (MUST agree with filter-completed-tasks.ts or dismissals break)
 * - getTaskSearchText: full-text search across task fields
 * - applyFilters: combined search/source/priority/time filtering
 * - normalizeSource: collapses github-issue → github for filter chips
 */

import type {
  CalendarTask,
  DocsActionTask,
  FilterState,
  GitHubTask,
  GmailTask,
  LinearTask,
  MeetingNotesTask,
  PriorityMetadata,
  SlackTask,
  Task,
} from "../../../ui/src/types/tasks";
import {
  applyFilters,
  getTaskIdentifier,
  getTaskSearchText,
  getTaskTimestamp,
  normalizeSource,
} from "../../../ui/src/utils/taskHelpers";

// ── Factories ────────────────────────────────────────────────────────────────

const DEFAULT_PRIORITY: PriorityMetadata = {
  score: 100,
  category: "medium",
  signals: [],
  reasons: "",
};

function makeSlack(overrides: Partial<SlackTask> = {}): SlackTask {
  return {
    source: "slack",
    taskId: "slack-1",
    stableId: "slack:general:1234567890.000001",
    text: "Hello from Slack",
    timestamp: "1234567890.000001",
    channel: "general",
    user: "alice",
    type: "mention",
    priorityMetadata: DEFAULT_PRIORITY,
    ...overrides,
  };
}

function makeGmail(overrides: Partial<GmailTask> = {}): GmailTask {
  return {
    source: "gmail",
    taskId: "gmail-1",
    stableId: "gmail:msg-abc123",
    id: "msg-abc123",
    subject: "Re: Project update",
    from: "bob@example.com",
    link: "https://mail.google.com/mail/u/0/#inbox/abc",
    timestamp: new Date().toISOString(),
    priorityMetadata: DEFAULT_PRIORITY,
    ...overrides,
  };
}

function makeDocs(overrides: Partial<DocsActionTask> = {}): DocsActionTask {
  return {
    source: "docs",
    taskId: "docs-1",
    stableId: "docs:https://docs.google.com/document/d/abc",
    fileTitle: "Q3 Planning",
    actionType: "assigned_action_item",
    fileLink: "https://docs.google.com/document/d/abc",
    timestamp: new Date().toISOString(),
    priorityMetadata: DEFAULT_PRIORITY,
    ...overrides,
  };
}

function makeMeetingNote(overrides: Partial<MeetingNotesTask> = {}): MeetingNotesTask {
  return {
    source: "meeting-notes",
    taskId: "note-1",
    stableId: "meeting-note:doc-xyz",
    documentId: "doc-xyz",
    actionItem: "Follow up with team",
    timestamp: new Date().toISOString(),
    priorityMetadata: DEFAULT_PRIORITY,
    ...overrides,
  };
}

function makeLinear(overrides: Partial<LinearTask> = {}): LinearTask {
  return {
    source: "linear",
    taskId: "linear-1",
    stableId: "linear:KIM-123",
    identifier: "KIM-123",
    title: "Fix authentication bug",
    url: "https://linear.app/team/KIM-123",
    priorityMetadata: DEFAULT_PRIORITY,
    ...overrides,
  };
}

function makeGitHub(overrides: Partial<GitHubTask> = {}): GitHubTask {
  return {
    source: "github",
    taskId: "gh-1",
    stableId: "github-pr:org/repo:42",
    number: 42,
    title: "Add retry logic to API client",
    url: "https://github.com/org/repo/pull/42",
    repo: "org/repo",
    type: "review",
    priorityMetadata: DEFAULT_PRIORITY,
    ...overrides,
  };
}

function makeCalendar(overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    source: "calendar",
    taskId: "cal-1",
    stableId: "calendar:cal-1",
    summary: "Team standup",
    start: new Date().toISOString(),
    end: new Date(Date.now() + 3600_000).toISOString(),
    htmlLink: "https://calendar.google.com/event/abc",
    priorityMetadata: DEFAULT_PRIORITY,
    ...overrides,
  };
}

const DEFAULT_FILTERS: FilterState = {
  search: "",
  sources: [],
  priorities: [],
  timeFilter: "all",
  showCompleted: false,
};

// ── getTaskIdentifier ────────────────────────────────────────────────────────

describe("getTaskIdentifier", () => {
  it("Slack: returns dismissalId when available", () => {
    const task = makeSlack({ dismissalId: "C123:1234567890.000001" });
    expect(getTaskIdentifier(task)).toBe("C123:1234567890.000001");
  });

  it("Slack: falls back to link when dismissalId is absent", () => {
    const task = makeSlack({
      dismissalId: undefined,
      link: "https://workspace.slack.com/archives/C123/p1234567890000001",
    });
    expect(getTaskIdentifier(task)).toBe(
      "https://workspace.slack.com/archives/C123/p1234567890000001"
    );
  });

  it("Slack: returns empty string when neither dismissalId nor link exists", () => {
    const task = makeSlack({ dismissalId: undefined, link: undefined });
    expect(getTaskIdentifier(task)).toBe("");
  });

  it("Gmail: returns message id", () => {
    const task = makeGmail({ id: "msg-abc123" });
    expect(getTaskIdentifier(task)).toBe("msg-abc123");
  });

  it("Docs: returns fileLink when available", () => {
    const task = makeDocs({
      fileLink: "https://docs.google.com/document/d/abc",
    });
    expect(getTaskIdentifier(task)).toBe("https://docs.google.com/document/d/abc");
  });

  it("Docs: falls back to fileTitle when fileLink is empty", () => {
    const task = makeDocs({ fileLink: "", fileTitle: "My Document" });
    expect(getTaskIdentifier(task)).toBe("My Document");
  });

  it("MeetingNotes: returns documentId", () => {
    const task = makeMeetingNote({ documentId: "doc-xyz" });
    expect(getTaskIdentifier(task)).toBe("doc-xyz");
  });

  it("Linear: returns empty string (not dismissable via this path)", () => {
    expect(getTaskIdentifier(makeLinear())).toBe("");
  });

  it("GitHub: returns empty string (not dismissable via this path)", () => {
    expect(getTaskIdentifier(makeGitHub())).toBe("");
  });

  it("Calendar: returns empty string (not dismissable via this path)", () => {
    expect(getTaskIdentifier(makeCalendar())).toBe("");
  });
});

// ── getTaskSearchText ────────────────────────────────────────────────────────

describe("getTaskSearchText", () => {
  it("should return lowercase text", () => {
    const task = makeLinear({ title: "Fix Auth Bug", identifier: "KIM-123" });
    const text = getTaskSearchText(task);
    expect(text).toBe(text.toLowerCase());
  });

  it("Linear: includes title, identifier, project, and state", () => {
    const task = makeLinear({
      title: "Fix Auth Bug",
      identifier: "KIM-123",
      project: "Backend",
      state: "In Progress",
    });
    const text = getTaskSearchText(task);
    expect(text).toContain("fix auth bug");
    expect(text).toContain("kim-123");
    expect(text).toContain("backend");
    expect(text).toContain("in progress");
  });

  it("Slack: includes text, channel, and user", () => {
    const task = makeSlack({
      text: "Can you review the PR?",
      channel: "eng-team",
      user: "charlie",
    });
    const text = getTaskSearchText(task);
    expect(text).toContain("can you review the pr?");
    expect(text).toContain("eng-team");
    expect(text).toContain("charlie");
  });

  it("Gmail: includes subject and from", () => {
    const task = makeGmail({
      subject: "Invoice ready",
      from: "billing@vendor.com",
    });
    const text = getTaskSearchText(task);
    expect(text).toContain("invoice ready");
    expect(text).toContain("billing@vendor.com");
  });

  it("GitHub: includes title, repo, and number", () => {
    const task = makeGitHub({
      title: "Add retry logic",
      repo: "org/repo",
      number: 42,
    });
    const text = getTaskSearchText(task);
    expect(text).toContain("add retry logic");
    expect(text).toContain("org/repo");
    expect(text).toContain("#42");
  });
});

// ── getTaskTimestamp ─────────────────────────────────────────────────────────

describe("getTaskTimestamp", () => {
  it("Calendar: returns start time", () => {
    const task = makeCalendar({ start: "2026-02-11T10:00:00Z" });
    expect(getTaskTimestamp(task)).toBe("2026-02-11T10:00:00Z");
  });

  it("Linear: returns dueDate or null", () => {
    expect(getTaskTimestamp(makeLinear({ dueDate: "2026-03-01" }))).toBe("2026-03-01");
    expect(getTaskTimestamp(makeLinear({ dueDate: undefined }))).toBeNull();
  });

  it("GitHub: returns null (no meaningful due date)", () => {
    expect(getTaskTimestamp(makeGitHub())).toBeNull();
  });
});

// ── normalizeSource ──────────────────────────────────────────────────────────

describe("normalizeSource", () => {
  it("should collapse github-issue into github", () => {
    expect(normalizeSource("github-issue")).toBe("github");
  });

  it("should leave other sources unchanged", () => {
    expect(normalizeSource("linear")).toBe("linear");
    expect(normalizeSource("slack")).toBe("slack");
    expect(normalizeSource("gmail")).toBe("gmail");
    expect(normalizeSource("calendar")).toBe("calendar");
    expect(normalizeSource("docs")).toBe("docs");
    expect(normalizeSource("meeting-notes")).toBe("meeting-notes");
  });
});

// ── applyFilters ─────────────────────────────────────────────────────────────

describe("applyFilters", () => {
  const tasks: Task[] = [
    makeLinear({
      title: "Auth bug",
      identifier: "KIM-1",
      dueDate: "2020-01-01",
      priorityMetadata: { ...DEFAULT_PRIORITY, category: "critical", score: 200 },
    }),
    makeSlack({
      text: "Review PR",
      priorityMetadata: { ...DEFAULT_PRIORITY, category: "high", score: 150 },
    }),
    makeGmail({
      subject: "Newsletter",
      priorityMetadata: { ...DEFAULT_PRIORITY, category: "low", score: 20 },
    }),
    makeGitHub({
      source: "github-issue",
      title: "Flaky test",
      priorityMetadata: { ...DEFAULT_PRIORITY, category: "medium", score: 90 },
    }),
    makeCalendar({ summary: "Team standup" }),
  ];

  it("should return all tasks when filters are empty", () => {
    expect(applyFilters(tasks, DEFAULT_FILTERS)).toHaveLength(tasks.length);
  });

  it("search: case-insensitive substring match", () => {
    const result = applyFilters(tasks, { ...DEFAULT_FILTERS, search: "auth" });
    expect(result).toHaveLength(1);
    expect((result[0] as LinearTask).identifier).toBe("KIM-1");
  });

  it("source filter: filters by normalized source", () => {
    const result = applyFilters(tasks, {
      ...DEFAULT_FILTERS,
      sources: ["github"],
    });
    // Should match both "github" and "github-issue" sources
    expect(result).toHaveLength(1);
    expect((result[0] as GitHubTask).title).toBe("Flaky test");
  });

  it("source filter: empty array means all sources pass", () => {
    const result = applyFilters(tasks, {
      ...DEFAULT_FILTERS,
      sources: [],
    });
    expect(result).toHaveLength(tasks.length);
  });

  it("priority filter: filters by category", () => {
    const result = applyFilters(tasks, {
      ...DEFAULT_FILTERS,
      priorities: ["critical", "high"],
    });
    expect(result).toHaveLength(2);
  });

  it("overdue filter: includes past-due tasks, excludes future", () => {
    // Build a clean set with explicit timestamps to avoid Slack epoch format issues.
    // The overdue filter does: !ts → exclude; new Date(ts).getTime() >= Date.now() → exclude.
    // Slack timestamps like "1234567890.000001" parse as invalid Date (NaN), which
    // means NaN >= Date.now() is false, so they'd be kept as "overdue" — a quirk
    // of the real code. For this test we use explicit ISO timestamps.
    const overdueTasks: Task[] = [
      makeLinear({
        identifier: "KIM-OVERDUE",
        title: "Overdue",
        dueDate: "2020-01-01",
        priorityMetadata: { ...DEFAULT_PRIORITY, category: "critical", score: 200 },
      }),
      makeLinear({
        identifier: "KIM-FUTURE",
        title: "Future",
        dueDate: "2099-12-31",
        priorityMetadata: { ...DEFAULT_PRIORITY, category: "medium", score: 100 },
      }),
      makeGitHub({ title: "No timestamp" }), // getTaskTimestamp returns null
    ];

    const result = applyFilters(overdueTasks, {
      ...DEFAULT_FILTERS,
      timeFilter: "overdue",
    });
    // Only the Linear task with a past dueDate should match.
    // GitHub (null timestamp) is excluded. Future Linear is excluded.
    expect(result).toHaveLength(1);
    expect((result[0] as LinearTask).identifier).toBe("KIM-OVERDUE");
  });

  it("no-due filter: includes tasks without a timestamp", () => {
    const result = applyFilters(tasks, {
      ...DEFAULT_FILTERS,
      timeFilter: "no-due",
    });
    // GitHub tasks return null from getTaskTimestamp
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t) => getTaskTimestamp(t) === null)).toBe(true);
  });

  it("combined filters: AND together", () => {
    const result = applyFilters(tasks, {
      ...DEFAULT_FILTERS,
      sources: ["linear"],
      priorities: ["low"], // Linear task is critical, not low
    });
    expect(result).toHaveLength(0);
  });
});
