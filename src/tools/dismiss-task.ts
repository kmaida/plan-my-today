import { z } from "zod/v3";
import { markActionComplete as storeDismiss } from "../services/action-completion-store";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import type { ActionSource } from "../utils/action-identifiers";

/**
 * Input schema for the dismiss-task tool
 */
const dismissTaskInputSchema = {
  source: z
    .enum(["meeting-note", "slack", "adhoc", "github"])
    .describe(
      "The source type of the action item: 'meeting-note' for meeting notes from Google Docs, 'slack' for Slack messages (mentions, DMs, threads only - not emoji-saved), 'adhoc' for custom tasks, or 'github' for GitHub PRs and issues"
    ),
  identifier: z
    .string()
    .describe(
      "The unique identifier for this action. Format varies by source: " +
        "meeting-note uses '{docId}' or '{docId}:{hash}', " +
        "slack uses '{channelId}:{messageTs}' (e.g., 'C0123ABCDEF:1234567890.123456'), " +
        "github uses '{owner}/{repo}#{number}' (e.g., 'myorg/myrepo#42'), " +
        "adhoc uses any custom ID"
    ),
  slackType: z
    .enum(["mention", "thread", "dm", "saved"])
    .describe(
      "Required when source is 'slack'. The Slack message type from the task data. " +
        "Only 'mention', 'thread', and 'dm' can be dismissed. " +
        "'saved' (emoji-bookmarked) messages must be managed in Slack by removing the emoji."
    )
    .optional(),
  metadata: z
    .record(z.any())
    .describe("Optional metadata to store with the dismissal (e.g., title, context)")
    .optional(),
};

/**
 * Registers the dismiss-task tool with the MCP server
 *
 * This tool dismisses action items from the dashboard by storing them in a local JSON file.
 * Dismissed items are automatically filtered from task lists and auto-pruned after 30 days.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerDismissTaskTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "dismiss-task",
    {
      title: "Dismiss Task",
      description:
        "Dismiss an action item from the dashboard. This works for meeting notes from Google Docs, Slack messages (mentions, DMs, threads; requires slackType field; rejects emoji-saved), GitHub PRs and issues, and ad-hoc tasks that don't have native completion tracking. Google Drive items are not dismissable — they auto-clear when resolved in the source document. Dismissed items are filtered from your todo lists and auto-pruned after 30 days. No authentication required - stores dismissal state locally.",
      inputSchema: dismissTaskInputSchema,
    },
    (async (args, _extra) => {
      try {
        const source = args.source as ActionSource;
        const identifier = args.identifier;

        // Reject emoji-saved Slack messages: those are dismissed in Slack
        // itself by removing the emoji reaction, not via local completion state.
        if (source === "slack") {
          if (!args.slackType) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: slackType is required when source is 'slack'. Pass the message's type field (mention, thread, dm, or saved).",
                },
              ],
              isError: true,
            };
          }
          if (args.slackType === "saved") {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: Emoji-saved Slack messages cannot be dismissed here. The user must remove the emoji reaction in Slack to dismiss this message.",
                },
              ],
              isError: true,
            };
          }
        }

        await storeDismiss(source, identifier, args.metadata);

        const text = `Task dismissed: ${source}:${identifier}`;

        return {
          content: [{ type: "text", text }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof dismissTaskInputSchema>
  );
}
