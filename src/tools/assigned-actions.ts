import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod";
import { stsClient } from "../services/sts-client";

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
 * Drive Activity API response types
 */
interface DriveActivityAction {
  detail?: {
    comment?: {
      mentionedUsers?: Array<{ knownUser?: { personName?: string } }>;
      assignment?: {
        assignedUser?: { knownUser?: { personName?: string } };
      };
    };
  };
}

interface DriveActivityTarget {
  driveItem?: {
    name?: string;
    title?: string;
    driveFile?: Record<string, unknown>;
    driveFolder?: Record<string, unknown>;
  };
}

interface DriveActivityActor {
  user?: {
    knownUser?: {
      personName?: string;
      isCurrentUser?: boolean;
    };
  };
}

interface DriveActivity {
  primaryActionDetail?: {
    comment?: {
      mentionedUsers?: Array<{ knownUser?: { personName?: string; isCurrentUser?: boolean } }>;
      assignment?: {
        subtype?: string;
        assignedUser?: { knownUser?: { personName?: string; isCurrentUser?: boolean } };
      };
      post?: {
        subtype?: string;
      };
      suggestion?: {
        subtype?: string;
      };
    };
  };
  actions?: DriveActivityAction[];
  targets?: DriveActivityTarget[];
  actors?: DriveActivityActor[];
  timestamp?: string;
  timeRange?: {
    startTime?: string;
    endTime?: string;
  };
}

interface DriveActivityResponse {
  activities?: DriveActivity[];
  nextPageToken?: string;
}

/**
 * Extracts the file ID from a Drive Activity item name
 * Format: "items/ITEM_ID"
 */
function extractFileId(itemName?: string): string | null {
  if (!itemName) return null;
  const match = itemName.match(/^items\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Formats a Drive Activity into a readable action item
 */
function formatActionItem(activity: DriveActivity): string | null {
  const target = activity.targets?.[0];
  const actor = activity.actors?.[0];
  const primaryAction = activity.primaryActionDetail;
  const timestamp = activity.timestamp || activity.timeRange?.startTime;

  if (!target?.driveItem || !primaryAction?.comment) {
    return null;
  }

  const fileTitle = target.driveItem.title || "Untitled";
  const fileId = extractFileId(target.driveItem.name);
  const fileLink = fileId ? `https://docs.google.com/document/d/${fileId}` : null;
  const actorName = actor?.user?.knownUser?.personName || "Someone";
  const isCurrentUserActor = actor?.user?.knownUser?.isCurrentUser;

  // Determine the type of action
  const comment = primaryAction.comment;
  let actionType = "";
  
  if (comment.assignment) {
    const subtype = comment.assignment.subtype;
    if (subtype === "ADDED") {
      actionType = "assigned to you";
    } else if (subtype === "REASSIGNED") {
      actionType = "reassigned to you";
    } else {
      actionType = "assignment updated";
    }
  } else if (comment.mentionedUsers?.some(u => u.knownUser?.isCurrentUser)) {
    actionType = "mentioned you";
  } else if (comment.post) {
    actionType = "commented";
  } else if (comment.suggestion) {
    actionType = "suggested an edit";
  } else {
    return null; // Not an action we care about
  }

  // Format the timestamp
  let dateStr = "";
  if (timestamp) {
    const date = new Date(timestamp);
    dateStr = date.toLocaleDateString("en-US", { 
      weekday: "short", 
      month: "short", 
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  // Build the output
  const actorDisplay = isCurrentUserActor ? "You" : actorName;
  let output = `• **${fileTitle}**\n`;
  output += `  ${actorDisplay} ${actionType}`;
  if (dateStr) {
    output += ` • ${dateStr}`;
  }
  if (fileLink) {
    output += `\n  📎 ${fileLink}`;
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
        const tokenResponse = await stsClient.exchange(
          authInfo,
          DRIVE_ACTIVITY_RESOURCE,
          DRIVE_ACTIVITY_SCOPES
        );

        // Calculate time filter
        const daysBack = args.daysBack || 7;
        const maxResults = args.maxResults || 20;
        const startTime = new Date();
        startTime.setDate(startTime.getDate() - daysBack);

        // Query Drive Activity API for comment-related activities
        // This includes @mentions, assignments, and suggestions
        const activityResponse = await fetch(
          "https://driveactivity.googleapis.com/v2/activity:query",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokenResponse.access_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              pageSize: maxResults,
              filter: `time >= "${startTime.toISOString()}" AND detail.action_detail_case:COMMENT`,
            }),
          }
        );

        if (!activityResponse.ok) {
          const error = await activityResponse.text();
          return {
            content: [{
              type: "text",
              text: `❌ Drive Activity API error: ${activityResponse.status} - ${error}`
            }]
          };
        }

        const data = await activityResponse.json() as DriveActivityResponse;
        const activities = data.activities || [];

        // Filter for activities where the current user was assigned or mentioned
        const actionItems: string[] = [];
        for (const activity of activities) {
          const comment = activity.primaryActionDetail?.comment;
          if (!comment) continue;

          // Check if current user was assigned or mentioned
          const wasAssigned = comment.assignment?.assignedUser?.knownUser?.isCurrentUser;
          const wasMentioned = comment.mentionedUsers?.some(u => u.knownUser?.isCurrentUser);

          if (wasAssigned || wasMentioned) {
            const formatted = formatActionItem(activity);
            if (formatted) {
              actionItems.push(formatted);
            }
          }
        }

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
        const message = error instanceof Error ? error.message : "Unknown error";
        const normalizedMessage = message.toLowerCase();
        const isInvalidGrant = normalizedMessage.includes("invalid_grant")
          || normalizedMessage.includes("not allowed to exchange token");

        if (isInvalidGrant) {
          return {
            content: [{
              type: "text",
              text: [
                `❌ Error: ${message}`,
                "",
                "Possible fixes:",
                "- Verify KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET are set for this server.",
                "- Confirm the Keycard client is allowed to exchange tokens for:",
                `  resource: ${DRIVE_ACTIVITY_RESOURCE}`,
                `  scope: ${DRIVE_ACTIVITY_SCOPES.join(" ")}`,
                "- Ensure the STS issuer/zone matches the one that issued your MCP token."
              ].join("\n")
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `❌ Error: ${message}`
          }]
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof assignedActionsInputSchema>
  );
}
