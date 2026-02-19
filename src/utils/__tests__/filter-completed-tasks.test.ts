/**
 * Tests for filter-completed-tasks.ts — the bridge between the completion
 * store and the dashboard's task display.
 *
 * A bug here means dismissed tasks reappear on the dashboard (the exact
 * production bug that prompted the completion-identifier-consistency tests).
 *
 * Strategy: mock `getCompletedBySources` to control which identifiers the
 * store reports as completed, then verify filterCompletedTasks removes the
 * correct items and leaves everything else untouched.
 */

import type { ActionSource } from "../action-identifiers";
import { hashActionText } from "../action-identifiers";
import { filterCompletedTasks } from "../filter-completed-tasks";

// ── Mock the completion store ────────────────────────────────────────────────

jest.mock("../../services/action-completion-store", () => ({
  getCompletedBySources: jest.fn(),
}));

import { getCompletedBySources } from "../../services/action-completion-store";

const mockedGetCompleted = getCompletedBySources as jest.MockedFunction<
  typeof getCompletedBySources
>;

/**
 * Helper: set up the mock to return the given completed identifiers per source.
 * Missing sources default to empty Sets.
 */
function setCompletedIds(
  overrides: Partial<Record<"slack" | "meeting-note" | "github", string[]>>
): void {
  const result = new Map<ActionSource, Set<string>>([
    ["slack", new Set(overrides.slack ?? [])],
    ["meeting-note", new Set(overrides["meeting-note"] ?? [])],
    ["github", new Set(overrides.github ?? [])],
  ]);
  mockedGetCompleted.mockResolvedValue(result);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: nothing completed
  setCompletedIds({});
});

// ── Slack filtering ──────────────────────────────────────────────────────────

describe("Slack filtering", () => {
  it("should remove a dismissed non-saved message by dismissalId", async () => {
    const data = {
      slack: [
        { type: "mention", dismissalId: "C123:1234567890.000001" },
        { type: "mention", dismissalId: "C123:1234567890.000002" },
      ],
    };
    setCompletedIds({ slack: ["C123:1234567890.000001"] });

    await filterCompletedTasks(data);

    expect(data.slack).toHaveLength(1);
    expect(data.slack[0].dismissalId).toBe("C123:1234567890.000002");
  });

  it("should always keep saved messages even if dismissed", async () => {
    const data = {
      slack: [
        { type: "saved", dismissalId: "C123:1234567890.000001" },
        { type: "mention", dismissalId: "C123:1234567890.000002" },
      ],
    };
    setCompletedIds({
      slack: ["C123:1234567890.000001", "C123:1234567890.000002"],
    });

    await filterCompletedTasks(data);

    // Saved message kept, mention removed
    expect(data.slack).toHaveLength(1);
    expect(data.slack[0].type).toBe("saved");
  });

  it("should fall back to permalink when dismissalId is absent", async () => {
    const permalink = "https://workspace.slack.com/archives/C123/p1234567890000001";
    const data = {
      slack: [{ type: "mention", permalink }],
    };
    setCompletedIds({ slack: [permalink] });

    await filterCompletedTasks(data);

    expect(data.slack).toHaveLength(0);
  });

  it("should still check permalink when dismissalId is present but not completed", async () => {
    // dismissalId is present but not in the completed set;
    // the permalink IS in the set — verifies the permalink fallback fires even
    // when a dismissalId field exists (it's only skipped when dismissalId matches).
    const data = {
      slack: [
        {
          type: "dm",
          dismissalId: "C123:1234567890.000001",
          permalink: "https://workspace.slack.com/archives/C123/p1234567890000001",
        },
      ],
    };
    setCompletedIds({
      slack: ["https://workspace.slack.com/archives/C123/p1234567890000001"],
    });

    await filterCompletedTasks(data);

    expect(data.slack).toHaveLength(0);
  });

  it("should keep messages with neither dismissalId nor permalink", async () => {
    const data = {
      slack: [{ type: "thread" }],
    };
    setCompletedIds({ slack: ["anything"] });

    await filterCompletedTasks(data);

    expect(data.slack).toHaveLength(1);
  });
});

// ── Meeting notes filtering ──────────────────────────────────────────────────

describe("Meeting notes filtering", () => {
  const DOC_ID = "doc-abc123";
  const ACTION_TEXT = "Follow up with team about Q3 planning";

  it("should remove all notes for a doc-level dismissal", async () => {
    const data = {
      meetingNotes: [
        { documentId: DOC_ID, actionItem: "Action 1" },
        { documentId: DOC_ID, actionItem: "Action 2" },
        { documentId: "doc-other", actionItem: "Other action" },
      ],
    };
    setCompletedIds({ "meeting-note": [DOC_ID] });

    await filterCompletedTasks(data);

    expect(data.meetingNotes).toHaveLength(1);
    expect(data.meetingNotes[0].documentId).toBe("doc-other");
  });

  it("should remove only the specific action for action-level dismissal", async () => {
    const hash = hashActionText(ACTION_TEXT);
    const data = {
      meetingNotes: [
        { documentId: DOC_ID, actionItem: ACTION_TEXT },
        { documentId: DOC_ID, actionItem: "A different action" },
      ],
    };
    setCompletedIds({ "meeting-note": [`${DOC_ID}:${hash}`] });

    await filterCompletedTasks(data);

    expect(data.meetingNotes).toHaveLength(1);
    expect(data.meetingNotes[0].actionItem).toBe("A different action");
  });

  it("should keep notes with no documentId (passes through unfiltered)", async () => {
    const data = {
      meetingNotes: [{ actionItem: "Orphan action" }],
    };
    setCompletedIds({ "meeting-note": ["anything"] });

    await filterCompletedTasks(data);

    expect(data.meetingNotes).toHaveLength(1);
  });

  it("doc-level and action-level dismissals work independently", async () => {
    const hash = hashActionText("Specific action");
    const otherDocId = "doc-other";
    const data = {
      meetingNotes: [
        { documentId: DOC_ID, actionItem: "Any action from dismissed doc" },
        { documentId: otherDocId, actionItem: "Specific action" },
        { documentId: otherDocId, actionItem: "Kept action" },
      ],
    };
    // Doc-level dismissal for DOC_ID, action-level for otherDocId:Specific action
    setCompletedIds({
      "meeting-note": [DOC_ID, `${otherDocId}:${hash}`],
    });

    await filterCompletedTasks(data);

    expect(data.meetingNotes).toHaveLength(1);
    expect(data.meetingNotes[0].actionItem).toBe("Kept action");
  });
});

// ── GitHub filtering ─────────────────────────────────────────────────────────

describe("GitHub filtering", () => {
  it("should remove a dismissed PR by dismissalId", async () => {
    const data = {
      github: {
        prs: [{ dismissalId: "org/repo#42" }, { dismissalId: "org/repo#43" }],
        issues: [],
      },
    };
    setCompletedIds({ github: ["org/repo#42"] });

    await filterCompletedTasks(data);

    expect(data.github.prs).toHaveLength(1);
    expect(data.github.prs[0].dismissalId).toBe("org/repo#43");
  });

  it("should remove a dismissed issue by dismissalId", async () => {
    const data = {
      github: {
        prs: [],
        issues: [{ dismissalId: "org/repo#10" }, { dismissalId: "org/repo#11" }],
      },
    };
    setCompletedIds({ github: ["org/repo#10"] });

    await filterCompletedTasks(data);

    expect(data.github.issues).toHaveLength(1);
    expect(data.github.issues[0].dismissalId).toBe("org/repo#11");
  });

  it("should keep items with no dismissalId (not dismissable, never hidden)", async () => {
    const data = {
      github: {
        prs: [{ dismissalId: null }, { dismissalId: undefined }],
        issues: [{ dismissalId: null }],
      },
    };
    setCompletedIds({ github: ["anything"] });

    await filterCompletedTasks(data);

    expect(data.github.prs).toHaveLength(2);
    expect(data.github.issues).toHaveLength(1);
  });

  it("dismissing a PR should not remove issues, and vice versa", async () => {
    const data = {
      github: {
        prs: [{ dismissalId: "org/repo#1" }],
        issues: [{ dismissalId: "org/repo#2" }],
      },
    };
    // Only PR #1 is dismissed — issue #2 must survive
    setCompletedIds({ github: ["org/repo#1"] });

    await filterCompletedTasks(data);

    expect(data.github.prs).toHaveLength(0);
    expect(data.github.issues).toHaveLength(1);
    expect(data.github.issues[0].dismissalId).toBe("org/repo#2");
  });

  it("same number in different repos are independent", async () => {
    const data = {
      github: {
        prs: [{ dismissalId: "org/repo-a#42" }, { dismissalId: "org/repo-b#42" }],
        issues: [],
      },
    };
    setCompletedIds({ github: ["org/repo-a#42"] });

    await filterCompletedTasks(data);

    expect(data.github.prs).toHaveLength(1);
    expect(data.github.prs[0].dismissalId).toBe("org/repo-b#42");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("should not crash when data.slack is undefined", async () => {
    const data = { linear: [] };
    // biome-ignore lint/suspicious/noExplicitAny: intentional partial data for edge case test
    await expect(filterCompletedTasks(data as any)).resolves.not.toThrow();
  });

  it("should not crash when data.slack is an empty array", async () => {
    const data = { slack: [] };
    await filterCompletedTasks(data);
    expect(data.slack).toHaveLength(0);
  });

  it("should not crash when all arrays are undefined", async () => {
    const data = {};
    await expect(filterCompletedTasks(data)).resolves.not.toThrow();
  });

  it("should not crash when data.github.prs is undefined", async () => {
    const data = { github: { issues: [{ dismissalId: "org/repo#1" }] } };
    setCompletedIds({ github: ["org/repo#1"] });

    await filterCompletedTasks(data);

    expect(data.github.issues).toHaveLength(0);
  });

  it("should not crash when data.github.issues is undefined", async () => {
    const data = { github: { prs: [{ dismissalId: "org/repo#1" }] } };
    setCompletedIds({ github: ["org/repo#1"] });

    await filterCompletedTasks(data);

    expect(data.github.prs).toHaveLength(0);
  });

  it("should leave non-filterable sources untouched", async () => {
    const data = {
      linear: [{ taskId: "LIN-1", title: "Task" }],
      calendar: [{ summary: "Meeting" }],
      gmail: [{ id: "msg-1", subject: "Email" }],
    };
    setCompletedIds({
      slack: ["anything"],
      "meeting-note": ["anything"],
    });

    // biome-ignore lint/suspicious/noExplicitAny: intentional partial data for edge case test
    await filterCompletedTasks(data as any);

    // These sources should be completely untouched
    expect(data.linear).toHaveLength(1);
    expect(data.calendar).toHaveLength(1);
    expect(data.gmail).toHaveLength(1);
  });
});

// ── Cross-source isolation ───────────────────────────────────────────────────

describe("Cross-source isolation", () => {
  it("dismissing a GitHub item should not affect Slack or meeting notes", async () => {
    const sharedId = "org/repo#1";
    const data = {
      slack: [{ type: "mention", dismissalId: sharedId }],
      meetingNotes: [{ documentId: sharedId, actionItem: "Action" }],
      github: { prs: [{ dismissalId: sharedId }], issues: [] },
    };
    setCompletedIds({ github: [sharedId] });

    await filterCompletedTasks(data);

    expect(data.github.prs).toHaveLength(0); // dismissed
    expect(data.slack).toHaveLength(1); // untouched
    expect(data.meetingNotes).toHaveLength(1); // untouched
  });

  it("dismissing a Slack message should not affect meeting notes", async () => {
    const sharedId = "shared-identifier";
    const data = {
      slack: [{ type: "mention", dismissalId: sharedId }],
      meetingNotes: [{ documentId: sharedId, actionItem: "Action" }],
    };
    // Only Slack has this ID completed
    setCompletedIds({ slack: [sharedId] });

    await filterCompletedTasks(data);

    expect(data.slack).toHaveLength(0); // Dismissed
    expect(data.meetingNotes).toHaveLength(1); // Untouched
  });
});
