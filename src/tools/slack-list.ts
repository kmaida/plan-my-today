import type { McpServer, AuthenticatedToolHandlerNoArgs } from "../types/index";
import { config } from "../config";
import { fetchSlackMessages, calculateSlackPriority } from "./today-todos/slack-utils";
import type { SlackMessageDetail } from "./today-todos/types";

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
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Registers the list-slack-todos tool with the MCP server
 *
 * This tool fetches recent @mentions and DMs from Slack with priority analysis.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerSlackListTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-slack-todos",
    {
      title: "List Slack Todos",
      description: "Get recent @mentions and DMs from Slack with priority analysis. Shows the 5 most recent messages from the last 24 hours. Use this when the user asks about their Slack messages or what needs attention on Slack.",
    },
    async ({ authInfo }: AuthenticatedToolHandlerNoArgs) => {
      if (!authInfo) {
        return {
          content: [{
            type: "text",
            text: "❌ No authentication information available. Please ensure you're properly authenticated."
          }]
        };
      }

      if (!config.slackUserToken) {
        return {
          content: [{
            type: "text",
            text: [
              "❌ Slack not configured.",
              "",
              "To use this tool, set SLACK_USER_TOKEN in your .env file"
            ].join("\n")
          }]
        };
      }

      try {
        // Fetch Slack messages
        const messages = await fetchSlackMessages(config.slackUserToken);

        if (messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: "💬 No @mentions or DMs found in the last 24 hours."
            }]
          };
        }

        // Calculate priorities
        const now = new Date();
        const messagesWithPriority = messages.map(msg => ({
          message: msg,
          priority: calculateSlackPriority(msg, now)
        }));

        // Sort by priority (highest first)
        messagesWithPriority.sort((a, b) => b.priority - a.priority);

        // Build output
        const lines: string[] = [
          `💬 **Slack - Recent Messages (Last 24h)**\n`,
          `Found ${messages.length} message${messages.length > 1 ? 's' : ''}\n`
        ];

        for (const { message, priority } of messagesWithPriority) {
          const typeEmoji = message.type === "mention" ? "💬 @mention" : "💬 DM";
          const channelInfo = message.channelName || message.channel;
          const sender = message.userName || message.user;
          const time = formatRelativeTime(message.timestamp);
          const truncatedText = truncateText(message.text, 120);
          const priorityLabel = priority >= 150 ? "🔴 HIGH" : priority >= 100 ? "🟠 MEDIUM" : "🟢 LOW";

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
        lines.push("• Base: @mentions (90 pts), DMs (70 pts)");
        lines.push("• Urgent keywords (+80 pts): urgent, asap, critical, blocker, help");
        lines.push("• Questions (+40 pts): ?, can you, need help");
        lines.push("• Action requests (+50 pts): review, approve, merge, fix");
        lines.push("• Recency: <1h (+50), <4h (+30), <12h (+15), <24h (+5)");

        const output = lines.join('\n');

        return {
          content: [{
            type: "text",
            text: output
          }]
        };

      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{
            type: "text",
            text: `❌ Error fetching Slack messages: ${message}`
          }]
        };
      }
    }
  );
}
