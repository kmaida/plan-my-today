/**
 * Structured error contract carried in `_meta.error` on MCP tool results.
 *
 * The wire response keeps its sanitized `text` content (LLM-facing). This
 * companion object travels in `_meta.error` and is consumed only by the UI,
 * which renders it as expandable detail. See `handleToolError()` for the
 * server-side build site and `ErrorDetail.tsx` for the UI render site.
 */

export type ErrorCategory =
  | "auth"
  | "rate_limit"
  | "upstream_api"
  | "network"
  | "config"
  | "unknown";

export interface StructuredToolError {
  /** Coarse bucket the UI uses for styling / badging. */
  category: ErrorCategory;
  /** Short source identifier — e.g. "linear", "gmail", "calendar". */
  source: string;
  /** Resource URI (Keycard resource identifier) when the failure was tied to one. */
  resource?: string;
  /** OAuth scopes that were requested in the failing token exchange. */
  scopes?: string[];
  /** HTTP or OAuth status code, when known. */
  status?: number;
  /** Raw upstream description (e.g. OAuth `error_description`). */
  description?: string;
  /** Raw `error.message` from the caught error. */
  message: string;
  /** Optional dev-facing hint about what to check. */
  hint?: string;
  /** ISO-8601 timestamp for correlating with server logs. */
  timestamp: string;
}
