import type { SlackMessageDetail } from "./types";
import { PriorityMetadata, categorizeScore, calculateRecencyBoost } from "./priority-utils";
import { getLogger } from "../../observability/logger";
import { isActionCompleted } from "../../services/action-completion-store";

import { SLACK_SAVED_MESSAGES } from "../../constants";

/**
 * Shape of a raw Slack message from the Search/Reactions APIs.
 * Defined once here and reused across fetchSlackSavedMessages,
 * searchMessages, deduplicateAndGroup, and fetchSlackMessages.
 */
interface SlackRawMessage {
  type: string;
  user: string;
  username?: string;
  ts: string;
  text: string;
  channel?: { id: string; name: string };
  permalink?: string;
  thread_ts?: string;
}

/**
 * Slack Search API response structure
 */
interface SlackSearchResponse {
  ok: boolean;
  error?: string;
  messages?: {
    matches?: SlackRawMessage[];
  };
}

/**
 * Slack auth.test API response
 */
interface SlackAuthResponse {
  ok: boolean;
  user_id?: string;
  error?: string;
}

/**
 * Slack reactions.list API response structure
 */
interface SlackReactionsResponse {
  ok: boolean;
  error?: string;
  items?: Array<{
    type: "message" | "file" | "file_comment";
    channel?: string;
    message?: {
      type: string;
      user: string;
      username?: string;
      ts: string;
      text: string;
      permalink?: string;
      thread_ts?: string;
      reactions?: Array<{
        name: string;
        users: string[];
      }>;
    };
  }>;
}

/**
 * Get the authenticated user's Slack ID
 */
async function getUserId(accessToken: string): Promise<string> {
  const response = await fetch("https://slack.com/api/auth.test", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status}`);
  }

  const data = (await response.json()) as SlackAuthResponse;

  if (!data.ok || !data.user_id) {
    throw new Error(data.error || "Failed to get user ID");
  }

  return data.user_id;
}

/**
 * Fetch messages the user has saved with a specific emoji reaction
 * Uses reactions.list API to get all reactions, then filters by emoji
 */
/**
 * Fetches messages that the user has bookmarked with a specific emoji reaction
 *
 * @param accessToken - Slack user token with reactions:read scope
 * @param userId - Slack user ID
 * @param emojiName - Name of the emoji to filter by (without colons)
 * @param daysBack - Number of days to look back
 * @param maxResults - Maximum number of messages to return
 * @returns Array of saved messages matching the criteria
 */
async function fetchSlackSavedMessages(
  accessToken: string,
  userId: string,
  emojiName: string,
  daysBack: number,
  maxResults: number
): Promise<SlackRawMessage[]> {
  const url = new URL("https://slack.com/api/reactions.list");
  url.searchParams.set("limit", "100");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Slack reactions.list API error: ${response.status}`);
  }

  const data = (await response.json()) as SlackReactionsResponse;

  if (!data.ok) {
    throw new Error(data.error || "Reactions fetch failed");
  }

  const items = data.items || [];
  const cutoffTime = Date.now() / 1000 - daysBack * 24 * 60 * 60;
  const filtered: SlackRawMessage[] = [];

  for (const item of items) {
    // Only process message items (skip files, file comments, etc.)
    if (item.type !== "message" || !item.message) continue;

    // Skip messages outside the time window
    const msgTs = parseFloat(item.message.ts);
    if (msgTs < cutoffTime) continue;

    // Check if this message has the target emoji reaction from the authenticated user
    const reactions = item.message.reactions || [];
    const hasTargetEmoji = reactions.some(
      (r) => r.name === emojiName && r.users.includes(userId)
    );

    if (!hasTargetEmoji) continue;

    filtered.push({
      type: item.message.type,
      user: item.message.user,
      username: item.message.username,
      ts: item.message.ts,
      text: item.message.text || "",
      channel: item.channel ? { id: item.channel, name: "" } : undefined,
      permalink: item.message.permalink,
      thread_ts: item.message.thread_ts,
    });

    if (filtered.length >= maxResults) break;
  }

  return filtered;
}

/**
 * Execute a Slack search query
 */
async function searchMessages(
  accessToken: string,
  query: string
): Promise<SlackRawMessage[]> {
  const url = new URL("https://slack.com/api/search.messages");
  url.searchParams.set("query", query);
  url.searchParams.set("count", "100"); // Max results per query

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Slack search API error: ${response.status}`);
  }

  const data = (await response.json()) as SlackSearchResponse;

  if (!data.ok) {
    throw new Error(data.error || "Search failed");
  }

  return data.messages?.matches || [];
}

/**
 * Deduplicate and group search results
 */
function deduplicateAndGroup(
  mentions: SlackRawMessage[],
  threads: SlackRawMessage[],
  dms: SlackRawMessage[],
  saved: SlackRawMessage[],
  userId: string
): SlackMessageDetail[] {
  const seen = new Set<string>();
  const results: SlackMessageDetail[] = [];

  /**
   * Helper to add a message if not already seen
   * Returns true if added, false if duplicate
   */
  const addIfNew = (
    msg: SlackRawMessage,
    messageType: "saved" | "mention" | "thread" | "dm",
    additionalFields?: Partial<SlackMessageDetail>
  ): boolean => {
    const key = msg.thread_ts || msg.ts;
    if (seen.has(key)) return false;
    seen.add(key);

    const channelId = msg.channel?.id || "";
    results.push({
      text: msg.text || "",
      timestamp: msg.ts,
      channel: channelId,
      channelName: msg.channel?.name,
      user: msg.user,
      userName: msg.username,
      permalink: msg.permalink,
      dismissalId: channelId && msg.ts ? `${channelId}:${msg.ts}` : undefined,
      threadTs: msg.thread_ts,
      type: messageType,
      ...additionalFields,
    });

    return true;
  };

  // Process in priority order: saved > mentions > threads > DMs
  // First occurrence wins due to deduplication
  saved.forEach((msg) => addIfNew(msg, "saved"));
  mentions.forEach((msg) => addIfNew(msg, "mention"));
  threads.forEach((msg) => {
    // Only include threads where user participated (not self-threads)
    if (msg.user !== userId) {
      addIfNew(msg, "thread", { replyCount: 1 });
    }
  });
  dms.forEach((msg) => addIfNew(msg, "dm"));

  // Sort by timestamp descending (most recent first)
  results.sort((a, b) => parseFloat(b.timestamp) - parseFloat(a.timestamp));

  return results;
}

/** Priority scoring constants */
const PRIORITY_WEIGHTS = {
  TYPE: {
    SAVED: 100,    // User explicitly bookmarked
    MENTION: 90,   // Direct @mention
    DM: 70,        // Direct message
  },
  CONTENT: {
    URGENT: 80,    // Urgent keywords
    ACTION: 50,    // Action request
    QUESTION: 40,  // Question or request
  },
  RECENCY: {
    VERY_RECENT: 50,  // < 1 hour
    RECENT: 30,       // < 4 hours
    MODERATE: 15,     // < 12 hours
    STALE: 5,         // < 24 hours
  },
} as const;

const URGENCY_KEYWORDS = [
  "urgent", "asap", "immediately", "critical", "emergency", "blocker", "blocked",
  "help", "stuck", "broken", "down", "failing", "issue", "problem"
] as const;

const QUESTION_KEYWORDS = [
  "?", "can you", "could you", "would you", "please", "need", "help",
  "quick question", "wondering if", "do you know"
] as const;

const ACTION_KEYWORDS = [
  "review", "approve", "merge", "deploy", "fix", "update", "check",
  "look at", "take a look", "feedback", "thoughts"
] as const;

/**
 * Shared analysis for Slack priority scoring.
 * Computes keyword matches, score, and age once — avoids duplicating
 * toLowerCase() + keyword scans across the score-only and metadata paths.
 */
function analyzeSlackMessage(message: SlackMessageDetail, now: Date) {
  const text = message.text.toLowerCase();

  const hasKeyword = (keywords: readonly string[]) =>
    keywords.some(keyword => text.includes(keyword));

  const hasUrgentKeywords = hasKeyword(URGENCY_KEYWORDS);
  const hasQuestion = hasKeyword(QUESTION_KEYWORDS);
  const hasActionRequest = hasKeyword(ACTION_KEYWORDS);

  const ageHours = (now.getTime() - parseFloat(message.timestamp) * 1000) / (1000 * 60 * 60);

  // Compute score
  let score = 0;
  const typeScores: Record<string, number> = {
    saved: PRIORITY_WEIGHTS.TYPE.SAVED,
    mention: PRIORITY_WEIGHTS.TYPE.MENTION,
    dm: PRIORITY_WEIGHTS.TYPE.DM,
  };
  score += typeScores[message.type] || 0;

  if (hasUrgentKeywords) score += PRIORITY_WEIGHTS.CONTENT.URGENT;
  else if (hasQuestion) score += PRIORITY_WEIGHTS.CONTENT.QUESTION;
  else if (hasActionRequest) score += PRIORITY_WEIGHTS.CONTENT.ACTION;

  if (ageHours < 1) score += PRIORITY_WEIGHTS.RECENCY.VERY_RECENT;
  else if (ageHours < 4) score += PRIORITY_WEIGHTS.RECENCY.RECENT;
  else if (ageHours < 12) score += PRIORITY_WEIGHTS.RECENCY.MODERATE;
  else if (ageHours < 24) score += PRIORITY_WEIGHTS.RECENCY.STALE;

  return { score, ageHours, hasUrgentKeywords, hasQuestion, hasActionRequest };
}

/**
 * Calculates a priority score for Slack messages based on type, content, and recency.
 * Higher score = higher priority.
 *
 * @param message - The Slack message to score
 * @param now - Current timestamp for recency calculation
 * @returns Priority score (0-300+ scale)
 */
export function calculateSlackPriority(
  message: SlackMessageDetail,
  now: Date
): number {
  return analyzeSlackMessage(message, now).score;
}

/**
 * Calculates priority metadata for Slack messages.
 * Returns the score plus structured signals and human-readable reasons.
 *
 * @param message - The Slack message to score
 * @param now - Current timestamp for recency calculation
 * @returns Priority metadata with score, category, signals, and human-readable reasons
 */
export function calculateSlackPriorityWithMetadata(
  message: SlackMessageDetail,
  now: Date
): PriorityMetadata {
  const { score, ageHours, hasUrgentKeywords, hasQuestion, hasActionRequest } =
    analyzeSlackMessage(message, now);

  const reasons: string[] = [];
  if (message.type === "saved") reasons.push("Saved with emoji");
  if (message.type === "mention") reasons.push("@Mention");
  if (message.type === "dm") reasons.push("Direct message");
  if (hasUrgentKeywords) reasons.push("Urgent keywords");
  if (hasQuestion) reasons.push("Question");
  if (hasActionRequest) reasons.push("Action requested");
  if (ageHours < 1) reasons.push("Very recent");

  return {
    score,
    category: categorizeScore(score),
    signals: {
      type: message.type,
      hasUrgentKeywords,
      hasQuestion,
      hasActionRequest,
      ageHours,
      recencyBoost: calculateRecencyBoost(ageHours)
    },
    reasons
  };
}

/**
 * Fetches a permalink for a Slack message using the chat.getPermalink API
 */
async function getPermalink(
  accessToken: string,
  channel: string,
  timestamp: string
): Promise<string | undefined> {
  try {
    const url = new URL("https://slack.com/api/chat.getPermalink");
    url.searchParams.set("channel", channel);
    url.searchParams.set("message_ts", timestamp);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { ok: boolean; permalink?: string };

    if (data.ok && data.permalink) {
      return data.permalink;
    }

    return undefined;
  } catch (error) {
    const logger = getLogger().withOperation("slack_utils");
    logger.debug('Failed to fetch Slack permalink', {
      channel,
      timestamp,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

/**
 * Resolve channel IDs to human-readable names for messages missing channelName.
 * Uses conversations.info API. DMs (D-prefixed channels) are resolved to the
 * other user's display name via users.info.
 */
async function resolveChannelNames(
  accessToken: string,
  messages: SlackMessageDetail[]
): Promise<SlackMessageDetail[]> {
  // Collect unique channel IDs that need resolution
  const idsToResolve = new Set<string>();
  for (const msg of messages) {
    if (!msg.channelName && msg.channel) {
      idsToResolve.add(msg.channel);
    }
  }

  if (idsToResolve.size === 0) return messages;

  const nameCache = new Map<string, string>();
  const logger = getLogger().withOperation("slack_utils");

  await Promise.all(
    Array.from(idsToResolve).map(async (channelId) => {
      try {
        if (channelId.startsWith("D")) {
          // DM channel — resolve via conversations.info to get the user, then users.info for name
          const convResponse = await fetch(
            `https://slack.com/api/conversations.info?channel=${channelId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const convData = (await convResponse.json()) as {
            ok: boolean;
            channel?: { user?: string };
          };
          if (convData.ok && convData.channel?.user) {
            const userResponse = await fetch(
              `https://slack.com/api/users.info?user=${convData.channel.user}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const userData = (await userResponse.json()) as {
              ok: boolean;
              user?: { real_name?: string; profile?: { display_name?: string }; name?: string };
            };
            if (userData.ok && userData.user) {
              const name =
                userData.user.profile?.display_name ||
                userData.user.real_name ||
                userData.user.name;
              nameCache.set(channelId, name ? `DM: ${name}` : "DM");
            } else {
              nameCache.set(channelId, "DM");
            }
          } else {
            // conversations.info succeeded but no user field (e.g., group DM)
            nameCache.set(channelId, "DM");
          }
        } else {
          // Regular channel
          const response = await fetch(
            `https://slack.com/api/conversations.info?channel=${channelId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const data = (await response.json()) as {
            ok: boolean;
            channel?: { name?: string };
            error?: string;
          };
          if (data.ok && data.channel?.name) {
            nameCache.set(channelId, data.channel.name);
          } else {
            logger.debug("conversations.info returned no name", {
              channelId,
              ok: data.ok,
              error: data.error,
            });
          }
        }
      } catch (error) {
        logger.debug("Failed to resolve channel name", {
          channelId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Fallback: use "DM" for DM channels so raw IDs don't leak to the UI
        if (channelId.startsWith("D")) {
          nameCache.set(channelId, "DM");
        }
      }
    })
  );

  return messages.map((msg) => {
    if (!msg.channelName && nameCache.has(msg.channel)) {
      return { ...msg, channelName: nameCache.get(msg.channel) };
    }
    // Final fallback: DM channels that weren't resolved at all
    if (!msg.channelName && msg.channel.startsWith("D")) {
      return { ...msg, channelName: "DM" };
    }
    return msg;
  });
}

/**
 * Ensures all messages have permalinks by fetching missing ones
 */
async function ensurePermalinks(
  accessToken: string,
  messages: SlackMessageDetail[]
): Promise<SlackMessageDetail[]> {
  const messagesWithPermalinks = await Promise.all(
    messages.map(async (msg) => {
      // If permalink already exists, return as-is
      if (msg.permalink) {
        return msg;
      }

      // Fetch permalink if missing
      const permalink = await getPermalink(accessToken, msg.channel, msg.timestamp);

      return {
        ...msg,
        permalink,
      };
    })
  );

  return messagesWithPermalinks;
}

/**
 * Fetch recent Slack messages (@mentions and DMs only)
 *
 * @param accessToken - Slack access token
 * @param options - Optional configuration
 * @param options.daysBack - Number of days to look back (default: 1 for 24 hours)
 * @param options.maxMessages - Maximum messages to return (default: 5)
 * @returns Array of Slack messages sorted by priority
 */
export async function fetchSlackMessages(
  accessToken: string,
  options: {
    daysBack?: number;
    maxMessages?: number;
    savedMessagesDaysBack?: number;
  } = {}
): Promise<SlackMessageDetail[]> {
  // Defaults: 1 day back, 5 messages max (for backward compatibility)
  const {
    daysBack = 1,
    maxMessages = 5,
    savedMessagesDaysBack = SLACK_SAVED_MESSAGES.DAYS_BACK
  } = options;

  // Get user ID
  const userId = await getUserId(accessToken);

  // Build time filter based on daysBack
  // Slack search uses "after:YYYY-MM-DD" or relative terms like "yesterday", "2 days ago"
  const timeFilter = daysBack === 1
    ? 'yesterday'
    : daysBack === 2
      ? '2 days ago'
      : daysBack === 3
        ? '3 days ago'
        : `${daysBack} days ago`;

  // Execute searches in parallel: @mentions, DMs, and saved messages
  let mentions: SlackRawMessage[];
  let dms: SlackRawMessage[];
  let saved: SlackRawMessage[];

  try {
    [mentions, dms, saved] = await Promise.all([
      searchMessages(accessToken, `<@${userId}> after:${timeFilter}`),
      searchMessages(accessToken, `in:dm after:${timeFilter}`),
      fetchSlackSavedMessages(
        accessToken,
        userId,
        SLACK_SAVED_MESSAGES.EMOJI_NAME,
        savedMessagesDaysBack,
        SLACK_SAVED_MESSAGES.MAX_RESULTS
      ),
    ]);
  } catch (error) {
    const logger = getLogger().withOperation("slack_utils");
    logger.warn("Failed to fetch saved messages - continuing with mentions/DMs only", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fallback: fetch only mentions and DMs
    [mentions, dms] = await Promise.all([
      searchMessages(accessToken, `<@${userId}> after:${timeFilter}`),
      searchMessages(accessToken, `in:dm after:${timeFilter}`),
    ]);
    saved = [];
  }

  // Deduplicate and group results, limit to configured max
  const allMessages = deduplicateAndGroup(mentions, [], dms, saved, userId);
  const limitedMessages = allMessages.slice(0, maxMessages);

  // Ensure all messages have permalinks and channel names
  const [messagesWithPermalinks] = await Promise.all([
    ensurePermalinks(accessToken, limitedMessages),
  ]);
  const enrichedMessages = await resolveChannelNames(accessToken, messagesWithPermalinks);

  // Filter out non-emoji messages that have been locally dismissed.
  // Uses dismissalId (channel:ts) as the stable identifier — unlike permalinks,
  // this never changes across fetches even when different thread messages are returned.
  // Emoji-saved messages are excluded from filtering because those are
  // dismissed in Slack itself (by removing the emoji reaction).
  const filteredMessages: SlackMessageDetail[] = [];
  for (const msg of enrichedMessages) {
    if (msg.type !== "saved") {
      if (msg.dismissalId && await isActionCompleted("slack", msg.dismissalId)) {
        continue;
      }
      // Backward compat: check legacy permalink-based key for entries created
      // before the switch to channel:ts identifiers. Will auto-expire via 30-day prune.
      if (msg.permalink && await isActionCompleted("slack", msg.permalink)) {
        continue;
      }
    }
    filteredMessages.push(msg);
  }

  return filteredMessages;
}
