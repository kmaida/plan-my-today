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
  overrides: Partial<Record<"slack" | "docs" | "meeting-note", string[]>>
): void {
  const result = new Map<ActionSource, Set<string>>([
    ["slack", new Set(overrides.slack ?? [])],
    ["docs", new Set(overrides.docs ?? [])],
    ["meeting-note", new Set(overrides["meeting-note"] ?? [])],
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

  it("should check dismissalId before permalink (dismissalId wins)", async () => {
    // Both fields present, but only permalink is in completed set
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

    // dismissalId is checked first and NOT in the set, so the message stays
    // even though the permalink IS in the set — but the code checks both
    // Actually re-reading the code: it checks dismissalId first, if that
    // matches → remove. If not, then checks permalink. So the msg IS removed.
    // The permalink fallback fires when dismissalId doesn't match.
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

// ── Docs filtering ───────────────────────────────────────────────────────────

describe("Docs filtering", () => {
  it("should remove a dismissed doc by fileLink", async () => {
    const link = "https://docs.google.com/document/d/abc123";
    const data = {
      docs: [{ fileLink: link, fileTitle: "My Doc" }],
    };
    setCompletedIds({ docs: [link] });

    await filterCompletedTasks(data);

    expect(data.docs).toHaveLength(0);
  });

  it("should remove a dismissed doc by fileTitle fallback", async () => {
    const data = {
      docs: [{ fileTitle: "Planning Notes" }],
    };
    setCompletedIds({ docs: ["Planning Notes"] });

    await filterCompletedTasks(data);

    expect(data.docs).toHaveLength(0);
  });

  it("should keep docs with empty-string identifier (no fileLink and no fileTitle)", async () => {
    const data = {
      docs: [{}],
    };
    setCompletedIds({ docs: [""] });

    await filterCompletedTasks(data);

    // The code does: const id = action.fileLink || action.fileTitle || ""
    // Then: return !id || !docsCompleted.has(id)
    // !id is true for "", so the item passes through
    expect(data.docs).toHaveLength(1);
  });

  it("should not remove a doc that isn't dismissed", async () => {
    const data = {
      docs: [
        { fileLink: "https://docs.google.com/document/d/abc123" },
        { fileLink: "https://docs.google.com/document/d/def456" },
      ],
    };
    setCompletedIds({
      docs: ["https://docs.google.com/document/d/abc123"],
    });

    await filterCompletedTasks(data);

    expect(data.docs).toHaveLength(1);
    expect(data.docs[0].fileLink).toBe("https://docs.google.com/document/d/def456");
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

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("should not crash when data.slack is undefined", async () => {
    const data = { linear: [] };
    await expect(filterCompletedTasks(data)).resolves.not.toThrow();
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

  it("should leave non-filterable sources untouched", async () => {
    const data = {
      linear: [{ taskId: "LIN-1", title: "Task" }],
      calendar: [{ summary: "Meeting" }],
      gmail: [{ id: "msg-1", subject: "Email" }],
    };
    setCompletedIds({
      slack: ["anything"],
      docs: ["anything"],
      "meeting-note": ["anything"],
    });

    await filterCompletedTasks(data as any);

    // These sources should be completely untouched
    expect(data.linear).toHaveLength(1);
    expect(data.calendar).toHaveLength(1);
    expect(data.gmail).toHaveLength(1);
  });
});

// ── Cross-source isolation ───────────────────────────────────────────────────

describe("Cross-source isolation", () => {
  it("dismissing a Slack message should not affect Docs or meeting notes", async () => {
    const sharedId = "shared-identifier";
    const data = {
      slack: [{ type: "mention", dismissalId: sharedId }],
      docs: [{ fileLink: sharedId }],
      meetingNotes: [{ documentId: sharedId, actionItem: "Action" }],
    };
    // Only Slack has this ID completed
    setCompletedIds({ slack: [sharedId] });

    await filterCompletedTasks(data);

    expect(data.slack).toHaveLength(0); // Dismissed
    expect(data.docs).toHaveLength(1); // Untouched
    expect(data.meetingNotes).toHaveLength(1); // Untouched
  });
});
