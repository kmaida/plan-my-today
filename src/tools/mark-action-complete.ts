import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod/v3";
import {
  markActionComplete as storeMarkComplete,
  markActionIncomplete as storeMarkIncomplete,
} from "../services/action-completion-store";
import type { ActionSource } from "../utils/action-identifiers";
import { removeSlackReaction } from "./today-todos/slack-utils";
import { SLACK_SAVED_MESSAGES } from "../constants";
import { config } from "../config";
import { getLogger } from "../observability/logger";

/**
 * Input schema for the mark-action-complete tool
 */
const markActionCompleteInputSchema = {
  source: z
    .enum(["meeting-note", "slack", "adhoc"])
    .describe(
      "The source type of the action item: 'meeting-note' for meeting notes from Google Docs, 'slack' for Slack messages, or 'adhoc' for custom tasks"
    ),
  identifier: z
    .string()
    .describe(
      "The unique identifier for this action. Format varies by source: " +
        "meeting-note uses '{docId}:{hash}', slack uses '{channelId}:{messageTs}', adhoc uses any custom ID"
    ),
  complete: z
    .boolean()
    .describe("Set to true to mark complete, false to unmark (default: true)")
    .optional(),
  metadata: z
    .record(z.any())
    .describe(
      "Optional metadata to store with the completion (e.g., title, context)"
    )
    .optional(),
};

/**
 * Registers the mark-action-complete tool with the MCP server
 *
 * This tool marks action items as complete by storing them in a local JSON file.
 * Completed items are automatically filtered from task lists and auto-pruned after 30 days.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerMarkActionCompleteTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "mark-action-complete",
    {
      title: "Mark Action Complete",
      description:
        "Mark an action item as complete (or incomplete). This works for meeting notes from Google Docs, Slack messages, and ad-hoc tasks that don't have native completion tracking. For Slack saved messages, this also removes the emoji reaction. Completed items are filtered from your todo lists and auto-pruned after 30 days. No authentication required - stores completion state locally.",
      inputSchema: markActionCompleteInputSchema,
    },
    (async (args, _extra) => {
      try {
        const source = args.source as ActionSource;
        const identifier = args.identifier;
        const shouldComplete = args.complete ?? true;

        if (shouldComplete) {
          await storeMarkComplete(source, identifier, args.metadata);

          // If this is a Slack message, also remove the emoji reaction
          if (source === "slack") {
            try {
              if (config.slackUserToken) {
                // Parse identifier: format is "channelId:messageTs"
                const [channel, timestamp] = identifier.split(":");
                if (channel && timestamp) {
                  await removeSlackReaction(
                    config.slackUserToken,
                    channel,
                    timestamp,
                    SLACK_SAVED_MESSAGES.EMOJI_NAME
                  );
                }
              }
            } catch (error) {
              // Log but don't fail - completion tracking still works
              const logger = getLogger().withOperation("mark_action_complete");
              logger.warn("Failed to remove Slack emoji reaction", {
                error: error instanceof Error ? error.message : String(error),
                identifier,
              });
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Action marked as complete: ${source}:${identifier}${
                  source === "slack" ? " (emoji removed from Slack)" : ""
                }`,
              },
            ],
          };
        } else {
          await storeMarkIncomplete(source, identifier);
          return {
            content: [
              {
                type: "text",
                text: `Action unmarked as complete: ${source}:${identifier}`,
              },
            ],
          };
        }
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
    }) satisfies AuthenticatedToolHandlerWithArgs<
      typeof markActionCompleteInputSchema
    >
  );
}
