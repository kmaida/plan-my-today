import { exchangeToken } from "../services/keycard-client";
import type { AuthenticatedToolHandlerNoArgs, McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";
import { calculateSlackPriority, fetchSlackMessages } from "./today-todos/slack-utils";

const SLACK_RESOURCE = "https://slack.com/api";
const SLACK_SCOPES = [
  "search:read",
  "reactions:read",
  "users:read",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
];

/**
 * Formats relative time from timestamp
 */
function formatRelativeTime(timestamp: string): string {
  const msgTime = new Date(parseFloat(timestamp) * 1000);
  const now = new Date();
  const diffMs = now.getTime() - msgTime.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor(diffMs / (1000 * 60));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else {
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }
}

/**
 * Truncates text with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength - 3)}...`;
}

/**
 * Registers the list-slack-todos tool with the MCP server
 *
 * This tool fetches recent @mentions and DMs from Slack with priority analysis.
 * Uses Keycard token exchange for Slack API access.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerSlackListTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-slack-todos",
    {
      title: "List Slack Todos",
      description:
        "Get recent @mentions, DMs, and saved messages (marked with your custom emoji) from Slack with priority analysis. Shows the 5 most recent messages. Use this when the user asks about their Slack messages or what needs attention on Slack.",
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: MCP tool handler — auth, API call, response formatting
    async ({ authInfo }: AuthenticatedToolHandlerNoArgs) => {
      if (!authInfo) {
        return {
          content: [
            {
              type: "text",
              text: "❌ No authentication information available. Please ensure you're properly authenticated.",
            },
          ],
          isError: true,
        };
      }

      try {
        // Exchange user's JWT for a Slack access token via Keycard
        const tokenResponse = await exchangeToken(authInfo, SLACK_RESOURCE, SLACK_SCOPES);
        const messages = await fetchSlackMessages(tokenResponse.accessToken);

        if (messages.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "💬 No @mentions, DMs, or saved messages found.",
              },
            ],
          };
        }

        // Calculate priorities
        const now = new Date();
        const messagesWithPriority = messages.map((msg) => ({
          message: msg,
          priority: calculateSlackPriority(msg, now),
        }));

        // Sort by priority (highest first)
        messagesWithPriority.sort((a, b) => b.priority - a.priority);

        // Build output
        const lines: string[] = [
          `💬 **Slack - Recent Messages (Last 24h)**\n`,
          `Found ${messages.length} message${messages.length > 1 ? "s" : ""}\n`,
        ];

        for (const { message, priority } of messagesWithPriority) {
          const typeEmoji =
            message.type === "mention"
              ? "💬 @mention"
              : message.type === "saved"
                ? "💾 Saved"
                : "💬 DM";
          const channelInfo = message.channelName || message.channel;
          const sender = message.userName || message.user;
          const time = formatRelativeTime(message.timestamp);
          const truncatedText = truncateText(message.text, 120);
          const priorityLabel =
            priority >= 150 ? "🔴 HIGH" : priority >= 100 ? "🟠 MEDIUM" : "🟢 LOW";

          lines.push(`**${typeEmoji}** ${priorityLabel} (score: ${priority})`);
          if (message.type === "mention") {
            lines.push(`Channel: #${channelInfo}`);
          }
          lines.push(`From: ${sender} • ${time}`);
          lines.push(`"${truncatedText}"`);

          if (message.permalink) {
            lines.push(`🔗 [View in Slack](${message.permalink})`);
          }

          lines.push(""); // Empty line between messages
        }

        lines.push("");
        lines.push("**Priority Scoring:**");
        lines.push("• Base: Saved (100 pts), @mentions (90 pts), DMs (70 pts)");
        lines.push("• Urgent keywords (+80 pts): urgent, asap, critical, blocker, help");
        lines.push("• Questions (+40 pts): ?, can you, need help");
        lines.push("• Action requests (+50 pts): review, approve, merge, fix");
        lines.push("• Recency: <1h (+50), <4h (+30), <12h (+15), <24h (+5)");

        const output = lines.join("\n");

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, "slack", SLACK_RESOURCE, SLACK_SCOPES);
      }
    }
  );
}
