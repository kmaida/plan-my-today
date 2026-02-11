/**
 * Source error detection for chat tool results.
 *
 * Detects source failures in MCP tool results so the UI can show the
 * reauthorization banner. Two structured detection paths — no string
 * pattern matching required:
 *
 * 1. **isError flag** — Individual source tools (list-gmail-todos, etc.)
 *    set `isError: true` in the MCP CallToolResult when they fail. The
 *    chat layer propagates this to `ToolCall.isError`.
 *
 * 2. **metadata.errors** — The aggregate tool (list-all-tasks-today)
 *    succeeds overall but reports per-source failures in a structured
 *    `metadata.errors` array. Each entry is a human-readable string
 *    from formatAuthError().
 */

import type { ToolCall } from "./types";

/**
 * Try to extract structured metadata.errors from a JSON tool result.
 *
 * Returns:
 * - `string[]` (possibly empty) if the result is a JSON object with a
 *   `metadata` field — signaling "this is a structured response."
 *   The caller should use these errors directly.
 * - `null` if the result isn't structured JSON (e.g. plain-text error
 *   from an individual tool).
 */
export function extractMetadataErrors(result: string): string[] | null {
  try {
    const parsed = JSON.parse(result);
    // If the response has a metadata object, it's a structured response
    // from an aggregate tool — trust the structure.
    if (parsed?.metadata && typeof parsed.metadata === "object") {
      if (Array.isArray(parsed.metadata.errors)) {
        return parsed.metadata.errors as string[];
      }
      return []; // Structured response with no errors
    }
  } catch {
    // Not JSON — caller should use isError flag instead
  }
  return null;
}

/**
 * Extract source errors from a single tool call result.
 *
 * Uses two structured signals — no string pattern matching:
 * - `tc.isError` — set by the MCP protocol when a tool returns isError: true
 * - `metadata.errors` — structured per-source errors from aggregate tools
 *
 * @returns Array of formatted error strings, empty if no errors found.
 */
export function extractToolCallAuthErrors(tc: ToolCall): string[] {
  if (!tc.result) return [];

  // Structured path: JSON response with metadata.errors (e.g. list-all-tasks-today)
  const metadataErrors = extractMetadataErrors(tc.result);
  if (metadataErrors) {
    return metadataErrors.map((err) => `${tc.name}: ${err}`);
  }

  // MCP protocol error flag from individual source tools
  if (tc.isError) {
    return [`${tc.name}: ${tc.result.slice(0, 200)}`];
  }

  return [];
}
