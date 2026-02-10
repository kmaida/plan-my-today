import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod/v3";
import {
  markActionComplete as storeMarkComplete,
  markActionIncomplete as storeMarkIncomplete,
} from "../services/action-completion-store";
import type { ActionSource } from "../utils/action-identifiers";

/**
 * Input schema for the mark-action-complete tool
 */
const markActionCompleteInputSchema = {
  source: z
    .enum(["meeting-note", "docs", "adhoc"])
    .describe(
      "The source type of the action item: 'meeting-note' for meeting notes from Google Docs, 'docs' for Google Docs assigned actions/mentions, or 'adhoc' for custom tasks"
    ),
  identifier: z
    .string()
    .describe(
      "The unique identifier for this action. Format varies by source: " +
        "meeting-note uses '{docId}' or '{docId}:{hash}', docs uses the file link or file title, adhoc uses any custom ID"
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
        "Mark an action item as complete (or incomplete). This works for meeting notes from Google Docs, Google Docs assigned actions/mentions, and ad-hoc tasks that don't have native completion tracking. Completed items are filtered from your todo lists and auto-pruned after 30 days. No authentication required - stores completion state locally.",
      inputSchema: markActionCompleteInputSchema,
    },
    (async (args, _extra) => {
      try {
        const source = args.source as ActionSource;
        const identifier = args.identifier;
        const shouldComplete = args.complete ?? true;

        if (shouldComplete) {
          await storeMarkComplete(source, identifier, args.metadata);

          return {
            content: [
              {
                type: "text",
                text: `Action marked as complete: ${source}:${identifier}`,
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
