import { z } from "zod/v3";
import { exchangeToken } from "../services/keycard-client";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";
import { type CommentEmailContext, fetchAssignedActions } from "./today-todos/drive-utils";
import { fetchGmailTodos } from "./today-todos/email-utils";
import type { AssignedActionDetail } from "./today-todos/types";

const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];
const GMAIL_RESOURCE = "https://gmail.googleapis.com";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const DRIVE_RESOURCE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

/**
 * Input schema for the list-assigned-actions tool
 */
const assignedActionsInputSchema = {
  daysBack: z
    .number()
    .describe("Number of days to look back for assignments (default: 7)")
    .optional(),
  maxResults: z
    .number()
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
      minute: "2-digit",
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
 * assigned to the current user via @mentions, comment assignments, and
 * unresolved comments on owned files (discovered via Gmail notifications).
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerAssignedActionsTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-assigned-actions",
    {
      title: "List Assigned Actions",
      description:
        "Get action items assigned to you in Google Drive via @mentions, comment assignments, and unresolved comments on files you own. Use this when the user asks about their action items, assignments, things assigned to them, or tasks from Google Drive.",
      inputSchema: assignedActionsInputSchema,
    },
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [
            {
              type: "text",
              text: "❌ No authentication information available. Please ensure you're properly authenticated.",
            },
          ],
        };
      }

      try {
        const daysBack = args.daysBack || 7;
        const maxResults = args.maxResults || 20;

        // Exchange tokens in parallel: Drive Activity (required), Gmail + Drive v3 (optional)
        const [activityToken, gmailToken, driveToken] = await Promise.all([
          exchangeToken(authInfo, DRIVE_ACTIVITY_RESOURCE, DRIVE_ACTIVITY_SCOPES),
          exchangeToken(authInfo, GMAIL_RESOURCE, GMAIL_SCOPES).catch(() => null),
          exchangeToken(authInfo, DRIVE_RESOURCE, DRIVE_SCOPES).catch(() => null),
        ]);

        // Build comment email context if Gmail + Drive tokens are available
        let commentEmailContext: CommentEmailContext | undefined;
        if (gmailToken && driveToken) {
          const gmailResult = await fetchGmailTodos(gmailToken.accessToken, {
            daysBack,
            maxResults: 20,
            includeRead: false,
            strictFiltering: true,
          });
          if (gmailResult.docCommentEmails.length > 0) {
            commentEmailContext = {
              docCommentEmails: gmailResult.docCommentEmails,
              driveToken: driveToken.accessToken,
            };
          }
        }

        // Fetch assigned actions (mentions/assignments + optional comment email enrichment)
        const actions = await fetchAssignedActions(
          activityToken.accessToken,
          daysBack,
          commentEmailContext
        );

        // Apply maxResults limit
        const limitedActions = actions.slice(0, maxResults);

        // Format action items
        const actionItems = limitedActions.map(formatActionDetail);

        if (actionItems.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `📋 No action items assigned to you in the last ${daysBack} days.`,
              },
            ],
          };
        }

        const output = `📋 **Action Items** (${actionItems.length}):\n\n${actionItems.join("\n\n")}`;

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      } catch (error) {
        return handleToolError(
          error,
          "assigned-actions",
          [DRIVE_ACTIVITY_RESOURCE, GMAIL_RESOURCE, DRIVE_RESOURCE],
          [DRIVE_ACTIVITY_SCOPES, GMAIL_SCOPES, DRIVE_SCOPES]
        );
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof assignedActionsInputSchema>
  );
}
