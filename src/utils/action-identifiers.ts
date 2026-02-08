import { createHash } from "crypto";

/**
 * Action source types - only for items without native completion tracking
 */
export type ActionSource = "meeting-note" | "slack" | "adhoc";

/**
 * Hash action text to create a short, stable identifier
 * @param text - Text to hash
 * @returns First 8 characters of MD5 hash
 */
export function hashActionText(text: string): string {
  return createHash("md5").update(text.trim()).digest("hex").substring(0, 8);
}

/**
 * Build identifier for meeting note actions
 * @param documentId - Google Doc ID
 * @param actionText - Full text of the action item
 * @returns Composite identifier: meeting-note:{documentId}:{hash}
 */
export function buildMeetingNoteId(
  documentId: string,
  actionText: string
): string {
  const hash = hashActionText(actionText);
  return `meeting-note:${documentId}:${hash}`;
}

/**
 * Build identifier for Slack messages
 * @param channelId - Slack channel ID
 * @param messageTs - Slack message timestamp
 * @returns Composite identifier: slack:{channelId}:{messageTs}
 */
export function buildSlackId(channelId: string, messageTs: string): string {
  return `slack:${channelId}:${messageTs}`;
}

