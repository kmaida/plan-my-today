import type { SlackMessageDetail } from "./types";

/**
 * Slack Search API response structure
 */
interface SlackSearchResponse {
  ok: boolean;
  error?: string;
  messages?: {
    matches?: Array<{
      type: string;
      user: string;
      username?: string;
      ts: string;
      text: string;
      channel?: {
        id: string;
        name: string;
      };
      permalink?: string;
      thread_ts?: string;
    }>;
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
 * Execute a Slack search query
 */
async function searchMessages(
  accessToken: string,
  query: string
): Promise<Array<{
  type: string;
  user: string;
  username?: string;
  ts: string;
  text: string;
  channel?: { id: string; name: string };
  permalink?: string;
  thread_ts?: string;
}>> {
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
  mentions: Array<{
    type: string;
    user: string;
    username?: string;
    ts: string;
    text: string;
    channel?: { id: string; name: string };
    permalink?: string;
    thread_ts?: string;
  }>,
  threads: Array<{
    type: string;
    user: string;
    username?: string;
    ts: string;
    text: string;
    channel?: { id: string; name: string };
    permalink?: string;
    thread_ts?: string;
  }>,
  dms: Array<{
    type: string;
    user: string;
    username?: string;
    ts: string;
    text: string;
    channel?: { id: string; name: string };
    permalink?: string;
    thread_ts?: string;
  }>,
  userId: string
): SlackMessageDetail[] {
  const seen = new Set<string>();
  const results: SlackMessageDetail[] = [];

  // Process @mentions first (highest priority)
  for (const msg of mentions) {
    const key = msg.thread_ts || msg.ts;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      text: msg.text || "",
      timestamp: msg.ts,
      channel: msg.channel?.id || "",
      channelName: msg.channel?.name,
      user: msg.user,
      userName: msg.username,
      permalink: msg.permalink,
      threadTs: msg.thread_ts,
      type: "mention",
    });
  }

  // Process threads where user participated
  for (const msg of threads) {
    // Skip if user is the only one in thread (not interesting)
    if (msg.user === userId) {
      const key = msg.thread_ts || msg.ts;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        text: msg.text || "",
        timestamp: msg.ts,
        channel: msg.channel?.id || "",
        channelName: msg.channel?.name,
        user: msg.user,
        userName: msg.username,
        permalink: msg.permalink,
        threadTs: msg.thread_ts,
        type: "thread",
        replyCount: 1, // Simplified: actual count would need conversations.replies
      });
    }
  }

  // Process DMs
  for (const msg of dms) {
    const key = msg.thread_ts || msg.ts;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      text: msg.text || "",
      timestamp: msg.ts,
      channel: msg.channel?.id || "",
      channelName: msg.channel?.name,
      user: msg.user,
      userName: msg.username,
      permalink: msg.permalink,
      threadTs: msg.thread_ts,
      type: "dm",
    });
  }

  // Sort by timestamp descending (most recent first)
  results.sort((a, b) => parseFloat(b.timestamp) - parseFloat(a.timestamp));

  return results;
}

/**
 * Calculates a priority score for Slack messages based on content and urgency
 * Higher score = higher priority
 */
export function calculateSlackPriority(
  message: SlackMessageDetail,
  now: Date
): number {
  let score = 0;
  const text = message.text.toLowerCase();

  // Base priority by type
  if (message.type === "mention") {
    score += 90; // @mentions are high priority - someone directly addressed you
  } else if (message.type === "dm") {
    score += 70; // DMs are important but slightly lower than @mentions
  }

  // Analyze message content for urgency signals
  const urgentKeywords = [
    "urgent", "asap", "immediately", "critical", "emergency", "blocker", "blocked",
    "help", "stuck", "broken", "down", "failing", "issue", "problem"
  ];

  const questionKeywords = [
    "?", "can you", "could you", "would you", "please", "need", "help",
    "quick question", "wondering if", "do you know"
  ];

  const actionKeywords = [
    "review", "approve", "merge", "deploy", "fix", "update", "check",
    "look at", "take a look", "feedback", "thoughts"
  ];

  // Boost for urgent language
  for (const keyword of urgentKeywords) {
    if (text.includes(keyword)) {
      score += 80; // Very high boost for urgent language
      break; // Only count once
    }
  }

  // Boost for questions (likely needs response)
  for (const keyword of questionKeywords) {
    if (text.includes(keyword)) {
      score += 40;
      break;
    }
  }

  // Boost for action requests
  for (const keyword of actionKeywords) {
    if (text.includes(keyword)) {
      score += 50;
      break;
    }
  }

  // Recency boost: more recent = higher priority
  const msgTime = new Date(parseFloat(message.timestamp) * 1000);
  const hoursAgo = (now.getTime() - msgTime.getTime()) / (1000 * 60 * 60);

  if (hoursAgo < 1) {
    score += 50; // Very recent
  } else if (hoursAgo < 4) {
    score += 30;
  } else if (hoursAgo < 12) {
    score += 15;
  } else if (hoursAgo < 24) {
    score += 5;
  }

  return score;
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
  } = {}
): Promise<SlackMessageDetail[]> {
  // Defaults: 1 day back, 5 messages max (for backward compatibility)
  const { daysBack = 1, maxMessages = 5 } = options;

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

  // Execute searches in parallel: @mentions and DMs only
  const [mentions, dms] = await Promise.all([
    searchMessages(accessToken, `<@${userId}> after:${timeFilter}`),
    searchMessages(accessToken, `in:dm after:${timeFilter}`),
  ]);

  // Deduplicate and group results, limit to configured max
  const allMessages = deduplicateAndGroup(mentions, [], dms, userId);
  return allMessages.slice(0, maxMessages);
}
