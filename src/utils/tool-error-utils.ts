/**
 * Shared error handling for MCP tool catch blocks.
 *
 * Most tools have the same pattern: detect token-exchange failures and
 * return a structured MCP error response. Uses instanceof checks on
 * typed error classes — no string matching.
 *
 * Two-channel contract:
 *   - `content[].text` is sanitized human-readable text. The LLM reads this
 *     on the next round and uses the wording to acknowledge the failure to
 *     the user — keep it intentionally bland so it doesn't leak internal
 *     URLs, user IDs, or stack traces.
 *   - `_meta.error` carries the full {@link StructuredToolError} (status,
 *     resource, scopes, raw message, hint, timestamp). The UI consumes this
 *     to render expandable error detail — `_meta` is not echoed back to the
 *     LLM in subsequent `tool_result` content blocks.
 */

import { getLogger } from "../observability/logger";
import { TokenExchangeError } from "../services/keycard-client";
import type { ErrorCategory, StructuredToolError } from "../types/tool-error";
import { AuthenticationError } from "./error-utils";

type ToolErrorResponse = {
  content: [{ type: "text"; text: string }];
  isError: true;
  _meta: { error: StructuredToolError };
};

/**
 * Classify a caught error into a coarse category. Resolves via `instanceof`
 * first (the precise path) and falls back to status / message inspection.
 */
function classifyError(error: unknown): {
  category: ErrorCategory;
  status?: number;
  description?: string;
} {
  if (error instanceof TokenExchangeError) {
    return { category: "auth", status: error.status, description: error.description };
  }
  if (error instanceof AuthenticationError) {
    return { category: "auth", status: error.status };
  }
  // TypeError from `fetch` is the typical signal for network-layer failures
  // (DNS, connection reset, CORS preflight) — distinct from a 4xx/5xx upstream
  // response, which would be a wrapped Error with a status.
  if (error instanceof TypeError) {
    return { category: "network" };
  }
  // Status-bearing errors (e.g. an upstream client throwing { status }).
  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? (error.status as number)
      : undefined;
  if (status === 429) {
    return { category: "rate_limit", status };
  }
  if (status && status >= 400) {
    return { category: "upstream_api", status };
  }
  return { category: "unknown" };
}

/** Build the sanitized LLM-facing message — unchanged from prior behavior. */
function buildSanitizedText(category: ErrorCategory): string {
  if (category === "auth") {
    return '❌ Authorization failed for this source. The user\'s grant may have expired or been revoked. Suggest the user click "Reauthorize" in the dashboard to refresh their grants.';
  }
  return "❌ This source encountered an unexpected error. The user may want to try again or check the server logs for details.";
}

/**
 * Build a {@link StructuredToolError} from any caught error. Shared by
 * `handleToolError()` (single-tool case) and `list-all-tasks-today`'s
 * aggregation (per-source case) so both paths emit the same shape.
 */
export function buildStructuredError(
  error: unknown,
  source: string,
  resource?: string,
  scopes?: string[],
  hint?: string
): StructuredToolError {
  const message = error instanceof Error ? error.message : "Unknown error";
  const { category, status, description } = classifyError(error);
  return {
    category,
    source,
    resource,
    scopes: scopes && scopes.length > 0 ? scopes : undefined,
    status,
    description,
    message,
    hint,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a structured MCP error response from a caught error.
 *
 * @param error      The caught error of unknown shape.
 * @param source     Short identifier for the failing source — e.g. "linear",
 *                   "gmail", "calendar". Surfaced in the UI badge and used
 *                   for log correlation.
 * @param resources  Resource URI(s) the tool was operating on (Keycard
 *                   resource identifier). Logged + surfaced to the UI.
 * @param scopes     OAuth scopes requested. Logged + surfaced to the UI.
 * @param extraHints Optional dev-facing hints joined with `; ` into the
 *                   `hint` field of the structured error.
 */
export function handleToolError(
  error: unknown,
  source: string,
  resources: string | string[],
  scopes: string[] | string[][],
  extraHints?: string[]
): ToolErrorResponse {
  const resourceList = Array.isArray(resources) ? resources : [resources];
  // Flatten scope lists — calendar/linear/etc. pass `string[]`, but some
  // multi-step tools (assigned-actions) pass `string[][]` (one scope set
  // per upstream resource). Normalize to a single deduped list for display.
  const flatScopes = Array.from(
    new Set(Array.isArray(scopes[0]) ? (scopes as string[][]).flat() : (scopes as string[]))
  );
  const hint = extraHints && extraHints.length > 0 ? extraHints.join("; ") : undefined;
  // For aggregate tools that touch multiple resources (e.g. assigned-actions
  // exchanges tokens for Drive Activity + Gmail + Drive), the caught error
  // doesn't carry which exchange failed. Surface ALL candidate resources
  // joined with newlines so the UI can show them all — better than picking
  // an arbitrary "first" and misleading the reader.
  const resourceField =
    resourceList.length === 0
      ? undefined
      : resourceList.length === 1
        ? resourceList[0]
        : resourceList.join("\n");

  const structuredError = buildStructuredError(error, source, resourceField, flatScopes, hint);

  // Log developer details server-side. Mirrors the prior log shape so
  // existing log queries keep working.
  const logEntry = getLogger().withOperation("tool_error");
  if (structuredError.category === "auth") {
    logEntry.warn("Token exchange failed", {
      source,
      category: structuredError.category,
      description: structuredError.description,
      status: structuredError.status,
      resources: resourceList.join(", "),
      hints: hint,
    });
  } else {
    logEntry.error("Tool call failed", {
      source,
      category: structuredError.category,
      status: structuredError.status,
      message: structuredError.message,
    });
  }

  return {
    content: [{ type: "text", text: buildSanitizedText(structuredError.category) }],
    isError: true,
    _meta: { error: structuredError },
  };
}
