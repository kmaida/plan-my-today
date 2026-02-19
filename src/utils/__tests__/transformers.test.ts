/**
 * Tests for the UI data transformer — converts grouped server response
 * into a flat, sorted Task[] array for the dashboard.
 *
 * Shape mismatches between server and UI types are silent bugs (blank
 * fields, wrong order). These tests verify each per-source transform
 * and the aggregate sort/flatten.
 */

import { transformServerResponse } from "../../../ui/src/api/transformers";
import type {
  CalendarTask,
  DriveActionTask,
  GitHubTask,
  GmailTask,
  LinearTask,
  MeetingNotesTask,
  ServerPriorityMetadata,
  ServerTasksResponse,
  SlackTask,
} from "../../../ui/src/types/tasks";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeServerPriority(
  score: number,
  overrides?: Partial<ServerPriorityMetadata>
): ServerPriorityMetadata {
  return {
    score,
    category: score >= 180 ? "critical" : score >= 130 ? "high" : score >= 80 ? "medium" : "low",
    signals: {},
    reasons: [],
    ...overrides,
  };
}

function emptyResponse(): ServerTasksResponse {
  return {
    calendar: [],
    linear: [],
    gmail: [],
    meetingSummaries: [],
    drive: [],
    github: { prs: [], issues: [] },
    slack: [],
    meetingNotes: [],
    metadata: { fetched_at: new Date().toISOString(), date: "2026-02-11" },
  };
}

// ── transformPriority ────────────────────────────────────────────────────────

describe("transformPriority", () => {
  it("should return default priority when server priority is undefined", () => {
    const data = emptyResponse();
    data.linear = [
      {
        identifier: "KIM-1",
        title: "No priority",
        priority: 3,
        priorityLabel: "Normal",
        url: "https://linear.app/KIM-1",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
        // No priorityMetadata
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as LinearTask;

    expect(task.priorityMetadata).toEqual({
      score: 0,
      category: "low",
      signals: [],
      reasons: "",
    });
  });

  it("should convert signals object keys to string array", () => {
    const data = emptyResponse();
    data.linear = [
      {
        identifier: "KIM-2",
        title: "With signals",
        priority: 1,
        priorityLabel: "Urgent",
        url: "https://linear.app/KIM-2",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
        priorityMetadata: {
          score: 200,
          category: "critical",
          signals: { urgentPriority: true, hasDueDate: true },
          reasons: ["Urgent priority", "Due today"],
        },
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as LinearTask;

    expect(task.priorityMetadata.signals).toEqual(["urgentPriority", "hasDueDate"]);
  });

  it("should join reasons array into comma-separated string", () => {
    const data = emptyResponse();
    data.linear = [
      {
        identifier: "KIM-3",
        title: "With reasons",
        priority: 2,
        priorityLabel: "High",
        url: "https://linear.app/KIM-3",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
        priorityMetadata: makeServerPriority(160, {
          reasons: ["High priority", "Blocked by other issue"],
        }),
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as LinearTask;

    expect(task.priorityMetadata.reasons).toBe("High priority, Blocked by other issue");
  });

  it("should handle reasons as string (defensive fallback)", () => {
    const data = emptyResponse();
    data.linear = [
      {
        identifier: "KIM-4",
        title: "String reasons",
        priority: 3,
        priorityLabel: "Normal",
        url: "https://linear.app/KIM-4",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
        priorityMetadata: {
          score: 100,
          category: "medium",
          signals: {},
          // biome-ignore lint/suspicious/noExplicitAny: testing defensive fallback where server sends string instead of array
          reasons: "Already a string" as any,
        },
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as LinearTask;

    expect(task.priorityMetadata.reasons).toBe("Already a string");
  });
});

// ── transformServerResponse (flatten + sort) ─────────────────────────────────

describe("transformServerResponse", () => {
  it("should sort tasks by priority score descending", () => {
    const data = emptyResponse();
    data.linear = [
      {
        identifier: "KIM-LOW",
        title: "Low",
        priority: 4,
        priorityLabel: "Low",
        url: "https://linear.app/KIM-LOW",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
        priorityMetadata: makeServerPriority(20),
      },
      {
        identifier: "KIM-HIGH",
        title: "High",
        priority: 1,
        priorityLabel: "Urgent",
        url: "https://linear.app/KIM-HIGH",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
        priorityMetadata: makeServerPriority(200),
      },
    ];

    const tasks = transformServerResponse(data);

    expect((tasks[0] as LinearTask).identifier).toBe("KIM-HIGH");
    expect((tasks[1] as LinearTask).identifier).toBe("KIM-LOW");
  });

  it("should flatten all 8 source types into a single array", () => {
    const data = emptyResponse();
    data.calendar = [
      {
        summary: "Standup",
        start: { dateTime: "2026-02-11T10:00:00Z" },
        end: { dateTime: "2026-02-11T10:30:00Z" },
        priorityMetadata: makeServerPriority(50),
      },
    ];
    data.linear = [
      {
        identifier: "KIM-1",
        title: "Task",
        priority: 3,
        priorityLabel: "Normal",
        url: "url",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
        priorityMetadata: makeServerPriority(100),
      },
    ];
    data.gmail = [
      {
        id: "msg-1",
        subject: "Email",
        from: "a@b.com",
        link: "url",
        priorityMetadata: makeServerPriority(80),
      },
    ];
    data.github = {
      prs: [
        {
          id: 1,
          number: 10,
          title: "PR",
          url: "url",
          repo: "org/repo",
          isReviewRequested: true,
          isAssigned: false,
          isAuthored: false,
          isOwnedRepo: false,
          dismissalId: "org/repo#10",
          updatedAt: "2026-01-01T00:00:00Z",
          isDraft: false,
          priorityMetadata: makeServerPriority(90),
        },
      ],
      issues: [
        {
          id: 2,
          number: 20,
          title: "Issue",
          url: "url",
          repo: "org/repo",
          isAssigned: true,
          isAuthored: false,
          isOwnedRepo: false,
          dismissalId: "org/repo#20",
          updatedAt: "2026-01-01T00:00:00Z",
          priorityMetadata: makeServerPriority(70),
        },
      ],
    };
    data.slack = [
      {
        text: "Hey",
        timestamp: "1234567890.000001",
        channel: "C123",
        user: "U123",
        type: "mention",
        priorityMetadata: makeServerPriority(110),
      },
    ];
    data.drive = [
      {
        fileTitle: "Doc",
        actionType: "assigned_action_item",
        fileLink: "url",
        priorityMetadata: makeServerPriority(60),
      },
    ];
    data.meetingNotes = [
      {
        documentId: "doc-1",
        documentTitle: "Meeting",
        documentLink: "url",
        actionItem: "Action",
        isUrgent: false,
        timestamp: Date.now(),
        priorityMetadata: makeServerPriority(40),
      },
    ];

    const tasks = transformServerResponse(data);

    // 8 source items total
    expect(tasks).toHaveLength(8);
    // Verify all source types are present
    const sources = tasks.map((t) => t.source);
    expect(sources).toContain("calendar");
    expect(sources).toContain("linear");
    expect(sources).toContain("gmail");
    expect(sources).toContain("github"); // PR
    expect(sources).toContain("github-issue"); // Issue
    expect(sources).toContain("slack");
    expect(sources).toContain("drive");
    expect(sources).toContain("meeting-notes");
  });

  it("should produce empty array from empty response", () => {
    const tasks = transformServerResponse(emptyResponse());
    expect(tasks).toEqual([]);
  });
});

// ── Per-source transform edge cases ──────────────────────────────────────────

describe("Per-source transforms", () => {
  it("Gmail: missing timestamp falls back to current time", () => {
    const now = new Date("2026-02-11T12:00:00Z");
    jest.useFakeTimers({ now });

    const data = emptyResponse();
    data.gmail = [
      {
        id: "msg-1",
        subject: "No timestamp",
        from: "a@b.com",
        link: "url",
        // timestamp intentionally undefined
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as GmailTask;

    // Should fall back to new Date().toISOString()
    expect(task.timestamp).toBe(now.toISOString());

    jest.useRealTimers();
  });

  it("MeetingNote: numeric timestamp converts to ISO string", () => {
    const ts = 1707609600000; // A specific epoch ms
    const data = emptyResponse();
    data.meetingNotes = [
      {
        documentId: "doc-1",
        documentTitle: "Meeting",
        documentLink: "url",
        actionItem: "Follow up",
        isUrgent: false,
        timestamp: ts,
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as MeetingNotesTask;

    expect(task.timestamp).toBe(new Date(ts).toISOString());
  });

  it("Slack: prefers channelName over channel, userName over user", () => {
    const data = emptyResponse();
    data.slack = [
      {
        text: "Hello",
        timestamp: "1234567890.000001",
        channel: "C123ABC",
        channelName: "engineering",
        user: "U456DEF",
        userName: "alice",
        type: "mention",
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as SlackTask;

    expect(task.channel).toBe("engineering");
    expect(task.user).toBe("alice");
  });

  it("Calendar: all-day event uses start.date not start.dateTime", () => {
    const data = emptyResponse();
    data.calendar = [
      {
        summary: "All day event",
        start: { date: "2026-02-11" },
        end: { date: "2026-02-12" },
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as CalendarTask;

    expect(task.start).toBe("2026-02-11");
    expect(task.end).toBe("2026-02-12");
  });

  it("GitHub PR: maps boolean flags and dismissalId from server", () => {
    const data = emptyResponse();
    data.github = {
      prs: [
        {
          id: 1,
          number: 10,
          title: "PR",
          url: "url",
          repo: "org/repo",
          isReviewRequested: true,
          isAssigned: false,
          isAuthored: false,
          isOwnedRepo: false,
          dismissalId: "org/repo#10",
          updatedAt: "2026-01-01T00:00:00Z",
          isDraft: true,
        },
      ],
      issues: [],
    };

    const tasks = transformServerResponse(data);
    const task = tasks[0] as GitHubTask;

    expect(task.source).toBe("github");
    expect(task.isReviewRequested).toBe(true);
    expect(task.isAssigned).toBe(false);
    expect(task.dismissalId).toBe("org/repo#10");
    expect(task.isDraft).toBe(true);
  });

  it("GitHub Issue: uses source 'github-issue' and boolean flags", () => {
    const data = emptyResponse();
    data.github = {
      prs: [],
      issues: [
        {
          id: 2,
          number: 20,
          title: "Issue",
          url: "url",
          repo: "org/repo",
          isAssigned: true,
          isAuthored: false,
          isOwnedRepo: false,
          dismissalId: "org/repo#20",
          updatedAt: "2026-01-01T00:00:00Z",
          labels: ["bug", "p1"],
        },
      ],
    };

    const tasks = transformServerResponse(data);
    const task = tasks[0] as GitHubTask;

    expect(task.source).toBe("github-issue");
    expect(task.isAssigned).toBe(true);
    expect(task.dismissalId).toBe("org/repo#20");
    expect(task.labels).toEqual(["bug", "p1"]);
  });

  it("Slack: maps permalink to link and preserves dismissalId", () => {
    const data = emptyResponse();
    data.slack = [
      {
        text: "Hello",
        timestamp: "1234567890.000001",
        channel: "C123",
        user: "U456",
        type: "saved",
        permalink: "https://workspace.slack.com/archives/C123/p1234567890000001",
        dismissalId: "C123:1234567890.000001",
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as SlackTask;

    expect(task.link).toBe("https://workspace.slack.com/archives/C123/p1234567890000001");
    expect(task.dismissalId).toBe("C123:1234567890.000001");
  });

  it("Drive: preserves driveType field from server", () => {
    const data = emptyResponse();
    data.drive = [
      {
        fileTitle: "Design doc",
        actionType: "comment_added",
        fileLink: "https://docs.google.com/document/d/abc",
        driveType: "unresolved-comment",
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as DriveActionTask;

    expect(task.source).toBe("drive");
    expect(task.driveType).toBe("unresolved-comment");
  });

  it("Drive: driveType is undefined when server omits it", () => {
    const data = emptyResponse();
    data.drive = [
      {
        fileTitle: "Spec",
        actionType: "mentioned",
        fileLink: "https://docs.google.com/document/d/def",
        // no driveType
      },
    ];

    const tasks = transformServerResponse(data);
    const task = tasks[0] as DriveActionTask;

    expect(task.driveType).toBeUndefined();
  });

  it("missing taskId defaults to empty string", () => {
    const data = emptyResponse();
    data.linear = [
      {
        // no taskId
        identifier: "KIM-1",
        title: "Task",
        priority: 3,
        priorityLabel: "Normal",
        url: "url",
        state: null,
        dueDate: null,
        estimate: null,
        project: null,
      },
    ];

    const tasks = transformServerResponse(data);
    expect(tasks[0].taskId).toBe("");
  });
});
