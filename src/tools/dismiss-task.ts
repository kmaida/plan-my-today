import { z } from "zod/v3";
import { markActionComplete as storeDismiss } from "../services/action-completion-store";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import type { ActionSource } from "../utils/action-identifiers";

/**
 * Input schema for the dismiss-task tool
 */
const dismissTaskInputSchema = {
  source: z
    .enum(["meeting-note", "slack", "docs", "adhoc"])
    .describe(
      "The source type of the action item: 'meeting-note' for meeting notes from Google Docs, 'slack' for Slack messages (mentions, DMs, threads only - not emoji-saved), 'docs' for Google Docs @mentions and comment assignments (local dismissal only - does not resolve comments in Google Docs), or 'adhoc' for custom tasks"
    ),
  identifier: z
    .string()
    .describe(
      "The unique identifier for this action. Format varies by source: " +
        "meeting-note uses '{docId}' or '{docId}:{hash}', " +
        "slack uses '{channelId}:{messageTs}' (e.g., 'C0123ABCDEF:1234567890.123456'), " +
        "docs uses the file link or file title, adhoc uses any custom ID"
    ),
  slackType: z
    .enum(["mention", "thread", "dm", "saved"])
    .describe(
      "Required when source is 'slack'. The Slack message type from the task data. " +
        "Only 'mention', 'thread', and 'dm' can be dismissed. " +
        "'saved' (emoji-bookmarked) messages must be managed in Slack by removing the emoji."
    )
    .optional(),
  docsType: z
    .enum(["mention", "assignment", "unresolved-comment"])
    .describe(
      "Optional when source is 'docs'. The Google Docs task type from the task data. " +
        "When 'unresolved-comment', a warning is returned suggesting the user resolve comments in Google Docs."
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
        "Dismiss an action item from the dashboard. This works for meeting notes from Google Docs, Slack messages (mentions, DMs, threads; requires slackType field; rejects emoji-saved), Google Docs @mentions and comment assignments, and ad-hoc tasks that don't have native completion tracking. Dismissed items are filtered from your todo lists and auto-pruned after 30 days. No authentication required - stores dismissal state locally.",
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

        let text = `Task dismissed: ${source}:${identifier}`;
        if (source === "docs" && args.docsType === "unresolved-comment") {
          text +=
            "\n\nNote: This item has unresolved comments. Suggest the user resolve them directly in Google Docs — once resolved, the item will disappear from the dashboard automatically on the next fetch.";
        }

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
