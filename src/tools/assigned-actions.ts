import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod/v3";
import { keycardClient } from "../services/keycard-client";
import { fetchAssignedActions } from "./today-todos/docs-utils";
import { handleToolError } from "../utils/tool-error-utils";
import type { AssignedActionDetail } from "./today-todos/types";

const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];

/**
 * Input schema for the list-assigned-actions tool
 */
const assignedActionsInputSchema = {
  daysBack: z.number()
    .describe("Number of days to look back for assignments (default: 7)")
    .optional(),
  maxResults: z.number()
    .describe("Maximum number of action items to return (default: 20)")
    .optional(),
};

/**
 * Formats an assigned action detail for display
 */
function formatActionDetail(action: AssignedActionDetail): string {
  let output = `• **${action.fileTitle}**\n`;
  output += `  ${action.actionType}`;

  if (action.timestamp) {
    const date = new Date(action.timestamp);
    const dateStr = date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
    output += ` • ${dateStr}`;
  }

  if (action.fileLink) {
    output += `\n  📎 ${action.fileLink}`;
  }

  return output;
}

/**
 * Registers the list-assigned-actions tool with the MCP server
 *
 * This tool queries the Google Drive Activity API to find action items
 * assigned to the current user via @mentions and comment assignments.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerAssignedActionsTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-assigned-actions",
    {
      title: "List Assigned Actions",
      description: "Get action items assigned to you in Google Docs via @mentions and comment assignments. Use this when the user asks about their action items, assignments, things assigned to them, or tasks from Google Docs.",
      inputSchema: assignedActionsInputSchema,
    },
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [{
            type: "text",
            text: "❌ No authentication information available. Please ensure you're properly authenticated."
          }]
        };
      }

      try {
        // Exchange user's JWT for a Drive Activity access token
        const tokenResponse = await keycardClient.exchange(
          authInfo,
          DRIVE_ACTIVITY_RESOURCE,
          DRIVE_ACTIVITY_SCOPES
        );

        // Calculate time filter
        const daysBack = args.daysBack || 7;
        const maxResults = args.maxResults || 20;

        // Fetch assigned actions using utility function
        const actions = await fetchAssignedActions(
          tokenResponse.access_token,
          daysBack
        );

        // Apply maxResults limit
        const limitedActions = actions.slice(0, maxResults);

        // Format action items
        const actionItems = limitedActions.map(formatActionDetail);

        if (actionItems.length === 0) {
          return {
            content: [{
              type: "text",
              text: `📋 No action items assigned to you in the last ${daysBack} days.`
            }]
          };
        }

        const output = `📋 **Action Items Assigned to You** (${actionItems.length}):\n\n${actionItems.join("\n\n")}`;

        return {
          content: [{
            type: "text",
            text: output
          }]
        };

      } catch (error) {
        return handleToolError(error, DRIVE_ACTIVITY_RESOURCE, DRIVE_ACTIVITY_SCOPES);
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof assignedActionsInputSchema>
  );
}
