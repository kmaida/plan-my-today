/**
 * Pure logic for evaluating tool round results.
 *
 * Extracted from useChat.ts so it's testable without React hook
 * infrastructure. The useChat hook calls evaluateToolRound() after
 * each tool execution round to determine:
 *
 * - Whether to refresh the task store (list-all-tasks-today was called)
 * - Whether to show the reauth banner (any tool returned isError: true)
 *
 * Auth errors reach the banner via two paths:
 * 1. MCP isError flag (individual tool failures) — detected by evaluateToolRound()
 * 2. metadata.errors in the task store (list-all-tasks-today partial failures) —
 *    detected when App.tsx re-reads the task store after a didFetchAllTasks round.
 *    Merged by mergeAuthErrors().
 */

import type { ToolCall } from "./types";

/** Result passed to the onToolRoundComplete callback after each tool execution round. */
export interface ToolRoundResult {
  /** Whether list-all-tasks-today was called this round. */
  didFetchAllTasks: boolean;
  /** Tool errors detected via the MCP isError flag (typically expired grants). */
  authErrors: string[];
}

/**
 * Evaluate a completed tool round and return structured results.
 *
 * Returns null if nothing actionable happened (no task fetch, no errors),
 * so the caller can skip the callback entirely.
 *
 * Detection uses the MCP `isError` boolean — no text parsing, no JSON
 * parsing, cannot break. In this app, tool failures are almost always
 * expired grants, so isError = show reauth banner.
 */
export function evaluateToolRound(toolCalls: ToolCall[]): ToolRoundResult | null {
  const didFetchAllTasks = toolCalls.some((tc) => tc.name === "list-all-tasks-today");

  // Any tool that returned isError triggers the reauth banner.
  // The MCP isError boolean is the most reliable signal.
  const authErrors = toolCalls
    .filter((tc) => tc.isError)
    .map((tc) => `${tc.name}: ${tc.result?.slice(0, 200) ?? "Unknown error"}`);

  if (didFetchAllTasks || authErrors.length > 0) {
    return { didFetchAllTasks, authErrors };
  }

  return null;
}

/**
 * Merge auth errors from the MCP tool round and the task store into a
 * deduplicated array. Used by the App-level callback after re-reading
 * the task store following a list-all-tasks-today call.
 *
 * This ensures partial failures from the aggregate tool (which doesn't set
 * isError) still surface in the reauth banner without a page refresh.
 */
export function mergeAuthErrors(
  existing: string[],
  roundErrors: string[],
  storeErrors: string[],
): string[] {
  return [...new Set([...existing, ...roundErrors, ...storeErrors])];
}
