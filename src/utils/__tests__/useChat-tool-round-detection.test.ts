/**
 * Tests for evaluateToolRound() — the core auth error detection logic.
 *
 * This function runs synchronously after each tool execution round in useChat.ts.
 * It replaced a fragile React effect that scanned message state for error patterns.
 * The new approach checks the MCP `isError` boolean directly at call time.
 *
 * Key contract:
 * - isError: true → authErrors entry (triggers reauth banner)
 * - isError: false/undefined → no authErrors (no false positives)
 * - list-all-tasks-today called → didFetchAllTasks: true (triggers task store refresh)
 * - Nothing actionable → returns null (callback doesn't fire)
 */

import { evaluateToolRound, mergeAuthErrors } from "../../../ui/src/chat/tool-round-utils";

// ── Helper ──────────────────────────────────────────────────────────────────

/** Build a minimal ToolCall for testing. */
function makeToolCall(overrides: { name: string; result?: string; isError?: boolean }) {
  return {
    id: `tc_${Math.random().toString(36).slice(2, 6)}`,
    input: {},
    ...overrides,
  };
}

// ── Core isError detection ──────────────────────────────────────────────────

describe("evaluateToolRound → auth error detection", () => {
  it("should detect an error when isError is true", () => {
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-gmail-todos",
        result: "❌ Authorization failed for this source.",
        isError: true,
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.authErrors).toHaveLength(1);
    expect(result!.authErrors[0]).toContain("list-gmail-todos");
    expect(result!.authErrors[0]).toContain("Authorization failed");
  });

  it("should NOT detect errors when isError is false", () => {
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-gmail-todos",
        result: "Found 5 emails with action items",
        isError: false,
      }),
    ]);

    expect(result).toBeNull();
  });

  it("should NOT detect errors when isError is undefined", () => {
    // The MCP SDK doesn't always set isError on successful results
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-gmail-todos",
        result: "Found 5 emails with action items",
      }),
    ]);

    expect(result).toBeNull();
  });

  it("should collect errors from multiple failing tools", () => {
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-gmail-todos",
        result: "❌ Authorization failed",
        isError: true,
      }),
      makeToolCall({
        name: "list-linear-issues",
        result: "❌ Authorization failed",
        isError: true,
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.authErrors).toHaveLength(2);
    expect(result!.authErrors[0]).toContain("list-gmail-todos");
    expect(result!.authErrors[1]).toContain("list-linear-issues");
  });

  it("should only include the failing tool when one of many fails", () => {
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-calendar-events",
        result: "Found 3 events",
        isError: false,
      }),
      makeToolCall({
        name: "list-gmail-todos",
        result: "❌ Authorization failed",
        isError: true,
      }),
      makeToolCall({
        name: "list-linear-issues",
        result: "Found 2 issues",
        isError: false,
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.authErrors).toHaveLength(1);
    expect(result!.authErrors[0]).toContain("list-gmail-todos");
  });
});

// ── didFetchAllTasks detection ──────────────────────────────────────────────

describe("evaluateToolRound → task fetch detection", () => {
  it("should set didFetchAllTasks when list-all-tasks-today is called", () => {
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-all-tasks-today",
        result: JSON.stringify({ calendar: [], linear: [], metadata: {} }),
        isError: false,
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.didFetchAllTasks).toBe(true);
    expect(result!.authErrors).toEqual([]);
  });

  it("should handle aggregate tool with partial failures (isError: false)", () => {
    // list-all-tasks-today succeeds overall but has per-source failures
    // in metadata.errors. isError stays false because the tool didn't throw.
    // The metadata.errors reach the banner via the REST path, not here.
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-all-tasks-today",
        result: JSON.stringify({
          calendar: [{ summary: "standup" }],
          metadata: {
            errors: ["Gmail: Authentication failed — reauthorize to refresh grants"],
          },
        }),
        isError: false,
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.didFetchAllTasks).toBe(true);
    // authErrors should be empty — metadata.errors are handled via REST
    expect(result!.authErrors).toEqual([]);
  });

  it("should NOT set didFetchAllTasks for other tools", () => {
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-gmail-todos",
        result: "Found 5 emails",
        isError: false,
      }),
    ]);

    expect(result).toBeNull();
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("evaluateToolRound → edge cases", () => {
  it("should return null for empty tool calls array", () => {
    expect(evaluateToolRound([])).toBeNull();
  });

  it("should use 'Unknown error' fallback when result is undefined", () => {
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-gmail-todos",
        isError: true,
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.authErrors[0]).toBe("list-gmail-todos: Unknown error");
  });

  it("should truncate long error results to 200 characters", () => {
    const longError = `Error: ${"x".repeat(300)}`;
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-linear-issues",
        result: longError,
        isError: true,
      }),
    ]);

    expect(result).not.toBeNull();
    // Tool name prefix + ": " + 200 chars of result
    const maxLength = "list-linear-issues: ".length + 200;
    expect(result!.authErrors[0].length).toBeLessThanOrEqual(maxLength);
    expect(result!.authErrors[0].length).toBeGreaterThan("list-linear-issues: ".length);
  });

  it("should handle combined task fetch + error in same round", () => {
    // Agent calls list-all-tasks-today AND a failing individual tool
    const result = evaluateToolRound([
      makeToolCall({
        name: "list-all-tasks-today",
        result: JSON.stringify({ calendar: [], metadata: {} }),
        isError: false,
      }),
      makeToolCall({
        name: "list-meeting-notes-actions",
        result: "❌ Authorization failed",
        isError: true,
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.didFetchAllTasks).toBe(true);
    expect(result!.authErrors).toHaveLength(1);
    expect(result!.authErrors[0]).toContain("list-meeting-notes-actions");
  });
});

// ── mergeAuthErrors ─────────────────────────────────────────────────────────
// Regression tests for the reauth banner bug where list-all-tasks-today
// partial failures (metadata.errors) didn't surface until page refresh.
// The fix: mergeAuthErrors() combines errors from both the MCP isError path
// and the task store re-read path into a single deduplicated array.

describe("mergeAuthErrors", () => {
  it("should surface task store errors even when round errors are empty", () => {
    // This is the exact scenario that caused the regression:
    // list-all-tasks-today succeeds (isError: false) but has metadata.errors.
    // evaluateToolRound produces empty authErrors.
    // The task store re-read returns those errors.
    const result = mergeAuthErrors(
      [],
      [], // round errors — empty because isError was false
      ["Gmail: Authentication failed — reauthorize to refresh grants"]
    );

    expect(result).toEqual(["Gmail: Authentication failed — reauthorize to refresh grants"]);
  });

  it("should merge round errors and store errors together", () => {
    const result = mergeAuthErrors(
      [],
      ["list-meeting-notes-actions: ❌ Authorization failed"],
      ["Gmail: Authentication failed — reauthorize to refresh grants"]
    );

    expect(result).toHaveLength(2);
    expect(result).toContain("list-meeting-notes-actions: ❌ Authorization failed");
    expect(result).toContain("Gmail: Authentication failed — reauthorize to refresh grants");
  });

  it("should preserve existing errors from previous rounds", () => {
    const result = mergeAuthErrors(
      ["Slack: token expired"],
      [],
      ["Gmail: Authentication failed — reauthorize to refresh grants"]
    );

    expect(result).toHaveLength(2);
    expect(result).toContain("Slack: token expired");
    expect(result).toContain("Gmail: Authentication failed — reauthorize to refresh grants");
  });

  it("should deduplicate identical errors", () => {
    const result = mergeAuthErrors(
      ["Gmail: Authentication failed"],
      ["Gmail: Authentication failed"],
      ["Gmail: Authentication failed"]
    );

    expect(result).toEqual(["Gmail: Authentication failed"]);
  });

  it("should return empty array when all sources are empty", () => {
    expect(mergeAuthErrors([], [], [])).toEqual([]);
  });
});
