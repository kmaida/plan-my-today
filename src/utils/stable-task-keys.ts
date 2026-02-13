import { hashActionText } from "./action-identifiers";

/**
 * Source labels used in stable task IDs.
 * These are the canonical source identifiers for the override system.
 * (Distinct from ActionSource which only covers dismissable sources.)
 */
export type TaskSourceLabel =
  | "linear"
  | "gmail"
  | "calendar"
  | "github-pr"
  | "github-issue"
  | "slack"
  | "docs"
  | "meeting-note"
  | "meeting-summary";

/**
 * Loose shape accepted by computeStableId.
 * Intentionally permissive so it works with both server-side enriched types
 * and raw API types without importing heavy type dependencies.
 */
interface TaskDataForStableId {
  // Linear
  identifier?: string;
  // Gmail / Calendar
  id?: string | number;
  // GitHub
  repo?: string;
  number?: number;
  // Slack
  channel?: string;
  timestamp?: string | number;
  dismissalId?: string;
  // Docs
  fileLink?: string | null;
  fileTitle?: string;
  // Meeting notes
  documentId?: string;
  actionItem?: string;
  // Meeting summary
  link?: string;
}

/**
 * Compute a stable identifier for a task that persists across fetches.
 * Format: `{source}:{identifier}` — the same key used by the override store.
 *
 * Returns an empty string if insufficient data to build a stable ID
 * (callers should treat empty stableId as "not identifiable").
 *
 * @param source - The canonical source label
 * @param data - Task data object (any enriched or raw type)
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch over all task source types
export function computeStableId(source: TaskSourceLabel, data: TaskDataForStableId): string {
  switch (source) {
    case "linear":
      return data.identifier ? `linear:${data.identifier}` : "";

    case "gmail":
      return data.id ? `gmail:${data.id}` : "";

    case "calendar":
      return data.id ? `calendar:${data.id}` : "";

    case "github-pr":
      return data.repo && data.number != null ? `github-pr:${data.repo}:${data.number}` : "";

    case "github-issue":
      return data.repo && data.number != null ? `github-issue:${data.repo}:${data.number}` : "";

    case "slack":
      // Prefer dismissalId (channel:ts) — same format the completion store uses
      if (data.dismissalId) return `slack:${data.dismissalId}`;
      if (data.channel && data.timestamp) return `slack:${data.channel}:${data.timestamp}`;
      return "";

    case "docs":
      return data.fileLink
        ? `docs:${data.fileLink}`
        : data.fileTitle
          ? `docs:${data.fileTitle}`
          : "";

    case "meeting-note":
      if (!data.documentId) return "";
      if (data.actionItem) {
        return `meeting-note:${data.documentId}:${hashActionText(data.actionItem)}`;
      }
      return `meeting-note:${data.documentId}`;

    case "meeting-summary":
      return data.link ? `meeting-summary:${data.link}` : "";

    default:
      return "";
  }
}
