import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod/v3";
import { keycardClient } from "../services/keycard-client";
import { fetchMeetingNoteActions } from "./today-todos/granola-utils";
import { handleToolError } from "../utils/tool-error-utils";
import type { MeetingNoteActionDetail } from "./today-todos/types";

const DRIVE_RESOURCE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

/**
 * Input schema for the list-meeting-notes-actions tool
 */
const meetingNotesInputSchema = {
  daysBack: z.number()
    .describe("Number of days to look back for meeting notes (default: 7)")
    .optional(),
  maxResults: z.number()
    .describe("Maximum number of documents to process (default: 10)")
    .optional(),
  folderName: z.string()
    .describe("Google Drive folder name containing meeting notes (default: 'Meeting Notes')")
    .optional(),
};

/**
 * Formats document date for display
 */
function formatDocDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) {
    return "Just now";
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

/**
 * Formats priority category for display
 */
function formatPriorityBadge(category: string | undefined): string {
  switch (category) {
    case "critical":
      return "[CRITICAL]";
    case "high":
      return "[HIGH]";
    case "medium":
      return "[MEDIUM]";
    default:
      return "";
  }
}

/**
 * Registers the list-meeting-notes-actions tool with the MCP server
 *
 * This tool extracts action items from Granola meeting notes synced to Google Drive.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerMeetingNotesTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-meeting-notes-actions",
    {
      title: "List Meeting Notes Action Items",
      description: "Extract action items from Granola meeting notes synced to Google Drive. Searches for documents with meeting dates in the filename from the last 10 business days (weekdays only). Searches a specified folder (default: 'Meeting Notes') for recent documents and extracts todos, action items, and assignments. Use this when the user asks about action items from meetings, follow-ups from calls, or todos from meeting notes.",
      inputSchema: meetingNotesInputSchema,
    },
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [{
            type: "text",
            text: "No authentication information available. Please ensure you're properly authenticated."
          }]
        };
      }

      try {
        // Exchange user's JWT for a Drive access token
        const tokenResponse = await keycardClient.exchange(
          authInfo,
          DRIVE_RESOURCE,
          DRIVE_SCOPES
        );

        const daysBack = args.daysBack || 21; // Increased to ~3 weeks to ensure 10 business days coverage
        const maxResults = args.maxResults || 10;
        const folderName = args.folderName || "Meeting Notes";

        // Fetch and process meeting notes
        const actionItems = await fetchMeetingNoteActions(tokenResponse.access_token, {
          daysBack,
          maxResults,
          folderName,
        });

        if (actionItems.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No action items found in meeting notes from the "${folderName}" folder in the last ${daysBack} days.\n\nThis could mean:\n- The folder doesn't exist or is named differently\n- No meeting notes have been added recently\n- The notes don't contain recognizable action items (checkboxes, "Action Items:" sections, TODO markers, etc.)`
            }]
          };
        }

        // Group action items by document
        const byDocument = new Map<string, MeetingNoteActionDetail[]>();
        for (const item of actionItems) {
          const existing = byDocument.get(item.documentId) || [];
          existing.push(item);
          byDocument.set(item.documentId, existing);
        }

        // Build output
        const lines: string[] = [`**Meeting Notes Action Items** (${actionItems.length} items from ${byDocument.size} notes)\n`];

        // Show urgent items first
        const urgentItems = actionItems.filter(item => item.isUrgent);
        if (urgentItems.length > 0) {
          lines.push(`**Urgent** (${urgentItems.length}):\n`);
          for (const item of urgentItems) {
            const badge = formatPriorityBadge(item.priorityMetadata?.category);
            lines.push(`- ${badge} ${item.actionItem}`);
            lines.push(`  From: ${item.documentTitle} | ${item.documentLink}\n`);
          }
        }

        // Show items grouped by document
        lines.push(`**By Meeting**:\n`);
        for (const [docId, items] of byDocument) {
          const firstItem = items[0];
          const date = formatDocDate(firstItem.timestamp);
          lines.push(`**${firstItem.documentTitle}** (${date})`);
          lines.push(`${firstItem.documentLink}\n`);

          for (const item of items) {
            if (!item.isUrgent) { // Skip urgent items (already shown above)
              const assigneeNote = item.assignee ? ` (@${item.assignee})` : "";
              lines.push(`- ${item.actionItem}${assigneeNote}`);
            }
          }
          lines.push("");
        }

        return {
          content: [{
            type: "text",
            text: lines.join('\n')
          }]
        };

      } catch (error) {
        return handleToolError(error, DRIVE_RESOURCE, DRIVE_SCOPES, [
          "Ensure your Google Drive credential provider is configured in Keycard.",
        ]);
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof meetingNotesInputSchema>
  );
}
