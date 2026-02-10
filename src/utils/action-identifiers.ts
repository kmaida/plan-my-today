import { createHash } from "crypto";

/**
 * Action source types - only for items without native completion tracking
 */
export type ActionSource = "meeting-note" | "docs" | "adhoc";

/**
 * Hash action text to create a short, stable identifier
 * @param text - Text to hash
 * @returns First 8 characters of MD5 hash
 */
export function hashActionText(text: string): string {
  return createHash("md5").update(text.trim()).digest("hex").substring(0, 8);
}
