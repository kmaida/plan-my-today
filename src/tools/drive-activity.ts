import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod";
import { stsClient } from "../services/sts-client";

const DRIVE_RESOURCE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

/**
 * Input schema for the list-drive-activity tool
 */
const driveActivityInputSchema = {
  daysBack: z.number()
    .describe("Number of days to look back for activity (default: 7)")
    .optional(),
  maxResults: z.number()
    .describe("Maximum number of files to return (default: 10)")
    .optional(),
  fileType: z.enum(["all", "documents", "spreadsheets", "presentations"])
    .describe("Filter by file type (default: all)")
    .optional(),
  includeComments: z.boolean()
    .describe("Include unresolved comments on files (default: true)")
    .optional(),
  ownedOnly: z.boolean()
    .describe("Only show files owned by you (default: true)")
    .optional(),
};

/**
 * Google Drive API response types
 */
interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

interface DriveFilesResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface DriveComment {
  id?: string;
  content?: string;
  author?: { displayName?: string };
  createdTime?: string;
  resolved?: boolean;
  quotedFileContent?: { value?: string };
}

interface DriveCommentsResponse {
  comments?: DriveComment[];
  nextPageToken?: string;
}

/**
 * Maps file type filter to Google Drive MIME types
 */
function getMimeTypeQuery(fileType: string): string {
  switch (fileType) {
    case "documents":
      return "mimeType='application/vnd.google-apps.document'";
    case "spreadsheets":
      return "mimeType='application/vnd.google-apps.spreadsheet'";
    case "presentations":
      return "mimeType='application/vnd.google-apps.presentation'";
    default:
      // All Google Workspace files
      return "(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.presentation')";
  }
}

/**
 * Formats a file's MIME type into a readable label
 */
function formatFileType(mimeType?: string): string {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "📄 Doc";
    case "application/vnd.google-apps.spreadsheet":
      return "📊 Sheet";
    case "application/vnd.google-apps.presentation":
      return "📽️ Slides";
    default:
      return "📁 File";
  }
}

/**
 * Fetches unresolved comments for a file
 */
async function getUnresolvedComments(
  fileId: string,
  accessToken: string
): Promise<DriveComment[]> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/comments?` +
    new URLSearchParams({
      fields: "comments(id,content,author/displayName,createdTime,resolved,quotedFileContent/value)",
      pageSize: "10",
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as DriveCommentsResponse;
  // Filter to only unresolved comments
  return (data.comments || []).filter(c => !c.resolved);
}

/**
 * Formats a comment for display
 */
function formatComment(comment: DriveComment): string {
  const author = comment.author?.displayName || "Unknown";
  const content = comment.content || "(no content)";
  const date = comment.createdTime 
    ? new Date(comment.createdTime).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "";
  
  let output = `    💬 ${author}`;
  if (date) output += ` (${date})`;
  output += `: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`;
  
  return output;
}

/**
 * Registers the list-drive-activity tool with the MCP server
 *
 * This tool queries the Google Drive API to find recently modified files
 * and their unresolved comments/suggestions.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerDriveActivityTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-drive-activity",
    {
      title: "List Drive Activity",
      description: "Get recently modified Google Drive files you own and their unresolved comments. Use this when the user asks about recent documents, active files, or wants to see what's been worked on recently.",
      inputSchema: driveActivityInputSchema,
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
        // Exchange user's JWT for a Drive access token
        const tokenResponse = await stsClient.exchange(
          authInfo,
          DRIVE_RESOURCE,
          DRIVE_SCOPES
        );

        // Build query parameters
        const daysBack = args.daysBack || 7;
        const maxResults = args.maxResults || 10;
        const fileType = args.fileType || "all";
        const includeComments = args.includeComments !== false; // default true
        const ownedOnly = args.ownedOnly !== false; // default true

        const modifiedAfter = new Date();
        modifiedAfter.setDate(modifiedAfter.getDate() - daysBack);

        const mimeTypeQuery = getMimeTypeQuery(fileType);
        const ownerFilter = ownedOnly ? " and 'me' in owners" : "";
        const query = `${mimeTypeQuery} and modifiedTime > '${modifiedAfter.toISOString()}' and trashed = false${ownerFilter}`;

        // Query Drive API for recently modified files
        const filesResponse = await fetch(
          `https://www.googleapis.com/drive/v3/files?` +
          new URLSearchParams({
            q: query,
            pageSize: maxResults.toString(),
            orderBy: "modifiedTime desc",
            fields: "files(id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser/displayName)",
          }),
          {
            headers: {
              Authorization: `Bearer ${tokenResponse.access_token}`,
            },
          }
        );

        if (!filesResponse.ok) {
          const error = await filesResponse.text();
          return {
            content: [{
              type: "text",
              text: `❌ Google Drive API error: ${filesResponse.status} - ${error}`
            }]
          };
        }

        const data = await filesResponse.json() as DriveFilesResponse;
        const files = data.files || [];

        if (files.length === 0) {
          const ownershipText = ownedOnly ? "that you own " : "";
          return {
            content: [{
              type: "text",
              text: `📁 No ${fileType === "all" ? "" : fileType + " "}files ${ownershipText}modified in the last ${daysBack} days.`
            }]
          };
        }

        // Build output with optional comments
        const outputParts: string[] = [];

        for (const file of files) {
          const typeLabel = formatFileType(file.mimeType);
          const modifiedDate = file.modifiedTime
            ? new Date(file.modifiedTime).toLocaleDateString("en-US", { 
                weekday: "short", 
                month: "short", 
                day: "numeric" 
              })
            : "";
          const modifier = file.lastModifyingUser?.displayName || "";

          let fileOutput = `• ${typeLabel} **${file.name}**\n`;
          fileOutput += `  Modified: ${modifiedDate}`;
          if (modifier) fileOutput += ` by ${modifier}`;
          if (file.webViewLink) fileOutput += `\n  📎 ${file.webViewLink}`;

          // Fetch unresolved comments if requested
          if (includeComments && file.id) {
            const comments = await getUnresolvedComments(file.id, tokenResponse.access_token);
            if (comments.length > 0) {
              fileOutput += `\n  **${comments.length} unresolved comment${comments.length > 1 ? "s" : ""}:**`;
              for (const comment of comments.slice(0, 3)) { // Limit to 3 comments per file
                fileOutput += `\n${formatComment(comment)}`;
              }
              if (comments.length > 3) {
                fileOutput += `\n    ... and ${comments.length - 3} more`;
              }
            }
          }

          outputParts.push(fileOutput);
        }

        const header = `📁 **Recently Modified Files** (${files.length}):\n\n`;
        const output = header + outputParts.join("\n\n");

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
                `  resource: ${DRIVE_RESOURCE}`,
                `  scope: ${DRIVE_SCOPES.join(" ")}`,
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
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof driveActivityInputSchema>
  );
}
