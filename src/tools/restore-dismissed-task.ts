import { z } from "zod/v3";
import { markActionIncomplete as storeRestore } from "../services/action-completion-store";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import type { ActionSource } from "../utils/action-identifiers";

/**
 * Input schema for the restore-dismissed-task tool
 */
const restoreDismissedTaskInputSchema = {
  source: z
    .enum(["meeting-note", "slack", "docs", "adhoc"])
    .describe(
      "The source type of the action item: 'meeting-note', 'slack', 'docs', or 'adhoc'"
    ),
  identifier: z
    .string()
    .describe(
      "The unique identifier for this action (same identifier used when dismissing)"
    ),
};

/**
 * Registers the restore-dismissed-task tool with the MCP server
 *
 * This tool restores a previously dismissed action item so it reappears in
 * the task list on the next fetch. Useful for undoing accidental dismissals.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerRestoreDismissedTaskTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "restore-dismissed-task",
    {
      title: "Restore Dismissed Task",
      description:
        "Restore a previously dismissed action item so it reappears in the dashboard on the next fetch. Use this when a task was dismissed by mistake. No authentication required - modifies local dismissal state only.",
      inputSchema: restoreDismissedTaskInputSchema,
    },
    (async (args, _extra) => {
      try {
        const source = args.source as ActionSource;
        const identifier = args.identifier;

        await storeRestore(source, identifier);

        return {
          content: [
            {
              type: "text",
              text: `Task restored: ${source}:${identifier}. It will reappear on the dashboard after the next fetch.`,
            },
          ],
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
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof restoreDismissedTaskInputSchema>
  );
}
