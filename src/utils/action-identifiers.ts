import { createHash } from "node:crypto";

/**
 * Action source types - only for items without native completion tracking.
 * "slack" covers local dismissal of non-emoji messages (mentions, DMs, threads).
 * Emoji-saved Slack messages are dismissed in Slack itself, not here.
 */
export type ActionSource = "meeting-note" | "slack" | "drive" | "adhoc";

/**
 * Hash action text to create a short, stable identifier
 * @param text - Text to hash
 * @returns First 8 characters of MD5 hash
 */
export function hashActionText(text: string): string {
  return createHash("md5").update(text.trim()).digest("hex").substring(0, 8);
}
