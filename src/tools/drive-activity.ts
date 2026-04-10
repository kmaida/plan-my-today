import { z } from "zod/v3";
import { exchangeToken } from "../services/keycard-client";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";
import { type DriveComment, getUnresolvedComments } from "./today-todos/drive-comments-utils";

const DRIVE_RESOURCE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];

/**
 * Input schema for the list-drive-activity tool
 */
const driveActivityInputSchema = {
  daysBack: z.number().describe("Number of days to look back for activity (default: 7)").optional(),
  maxResults: z.number().describe("Maximum number of files to return (default: 10)").optional(),
  fileType: z
    .enum(["all", "documents", "spreadsheets", "presentations"])
    .describe("Filter by file type (default: all)")
    .optional(),
  includeComments: z
    .boolean()
    .describe("Include unresolved comments on files (default: true)")
    .optional(),
  ownedOnly: z.boolean().describe("Only show files owned by you (default: true)").optional(),
};

/**
 * Google Drive API response types (local to this tool — not shared)
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

/**
 * Drive Activity API response types for mentions
 */
interface DriveActivityTarget {
  driveItem?: {
    name?: string;
    title?: string;
  };
}

interface DriveActivity {
  primaryActionDetail?: {
    comment?: {
      mentionedUsers?: Array<{ knownUser?: { isCurrentUser?: boolean } }>;
    };
  };
  targets?: DriveActivityTarget[];
  timestamp?: string;
}

interface DriveActivityResponse {
  activities?: DriveActivity[];
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
 * Formats a comment for display
 */
function formatComment(comment: DriveComment, isMentioned: boolean = false): string {
  const author = comment.author?.displayName || "Unknown";
  const content = comment.content || "(no content)";
  const date = comment.createdTime
    ? new Date(comment.createdTime).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "";

  const mentionPrefix = isMentioned ? "🔔 " : "";
  let output = `    ${mentionPrefix}💬 ${author}`;
  if (date) output += ` (${date})`;
  if (isMentioned) output += ` **mentioned you**`;
  output += `: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`;

  return output;
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
 * Finds files owned by the user that have unresolved comments
 */
async function findFilesWithUnresolvedComments(
  driveToken: string,
  fileType: string,
  ownedOnly: boolean,
  maxFilesToCheck: number = 50
): Promise<DriveFile[]> {
  const mimeTypeQuery = getMimeTypeQuery(fileType);
  const ownerFilter = ownedOnly ? " and 'me' in owners" : "";
  const query = `${mimeTypeQuery} and trashed = false${ownerFilter}`;

  // Query for files the user owns (most recently modified first)
  const filesResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files?` +
      new URLSearchParams({
        q: query,
        pageSize: maxFilesToCheck.toString(),
        orderBy: "modifiedTime desc",
        fields: "files(id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser/displayName)",
      }),
    {
      headers: {
        Authorization: `Bearer ${driveToken}`,
      },
    }
  );

  if (!filesResponse.ok) {
    return [];
  }

  const data = (await filesResponse.json()) as DriveFilesResponse;
  const allFiles = data.files || [];

  // Check each file for unresolved comments in parallel
  const filesWithCommentsPromises = allFiles.map(async (file) => {
    if (!file.id) return null;
    const comments = await getUnresolvedComments(file.id, driveToken);
    return comments.length > 0 ? file : null;
  });

  const results = await Promise.all(filesWithCommentsPromises);
  return results.filter((f): f is DriveFile => f !== null);
}

/**
 * Fetches files where the user was mentioned in comments
 */
async function getFilesWithMentions(
  accessToken: string,
  daysBack: number,
  _fileType: string
): Promise<Map<string, { fileId: string; fileTitle: string; mentionedAt: string }>> {
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - daysBack);

  const response = await fetch("https://driveactivity.googleapis.com/v2/activity:query", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pageSize: 50,
      filter: `time >= "${startTime.toISOString()}" AND detail.action_detail_case:COMMENT`,
    }),
  });

  if (!response.ok) {
    return new Map();
  }

  const data = (await response.json()) as DriveActivityResponse;
  const activities = data.activities || [];
  const mentionedFiles = new Map<
    string,
    { fileId: string; fileTitle: string; mentionedAt: string }
  >();

  for (const activity of activities) {
    const comment = activity.primaryActionDetail?.comment;
    if (!comment) continue;

    // Check if current user was mentioned
    const wasMentioned = comment.mentionedUsers?.some((u) => u.knownUser?.isCurrentUser);
    if (!wasMentioned) continue;

    const target = activity.targets?.[0];
    if (!target?.driveItem) continue;

    const fileId = extractFileId(target.driveItem.name);
    const fileTitle = target.driveItem.title || "Untitled";
    const timestamp = activity.timestamp || "";

    if (fileId) {
      // Only include if it matches the file type filter
      // We'll filter by MIME type after fetching file details
      mentionedFiles.set(fileId, { fileId, fileTitle, mentionedAt: timestamp });
    }
  }

  return mentionedFiles;
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
      description:
        "Get Google Drive files you own with unresolved comments, including recently modified files, files where you were mentioned in comments, and files with unresolved comments. Use this when the user asks about recent documents, active files, or wants to see what's been worked on recently.",
      inputSchema: driveActivityInputSchema,
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: MCP tool handler — auth, API call, response formatting
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
        // Exchange user's JWT for Drive and Drive Activity access tokens
        const [tokenResponse, activityTokenResponse] = await Promise.all([
          exchangeToken(authInfo, DRIVE_RESOURCE, DRIVE_SCOPES),
          exchangeToken(authInfo, DRIVE_ACTIVITY_RESOURCE, DRIVE_ACTIVITY_SCOPES)
            .catch(() => null),
        ]);

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
              fields:
                "files(id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser/displayName)",
            }),
          {
            headers: {
              Authorization: `Bearer ${tokenResponse.accessToken}`,
            },
          }
        );

        if (!filesResponse.ok) {
          const error = await filesResponse.text();
          return {
            content: [
              {
                type: "text",
                text: `❌ Google Drive API error: ${filesResponse.status} - ${error}`,
              },
            ],
          };
        }

        const data = (await filesResponse.json()) as DriveFilesResponse;
        const files = data.files || [];

        // Get files where user was mentioned in comments
        const mentionedFilesMap = activityTokenResponse
          ? await getFilesWithMentions(activityTokenResponse.accessToken, daysBack, fileType)
          : new Map();

        // Find files with unresolved comments (even if not recently modified)
        const filesWithUnresolvedComments =
          includeComments && ownedOnly
            ? await findFilesWithUnresolvedComments(
                tokenResponse.accessToken,
                fileType,
                ownedOnly,
                Math.max(maxResults * 3, 50) // Check more files to find ones with comments
              )
            : [];

        // Fetch file details for mentioned files that aren't already in the list
        const existingFileIds = new Set(files.map((f) => f.id));
        const mentionedFileIds = Array.from(mentionedFilesMap.keys()).filter(
          (id) => !existingFileIds.has(id)
        );

        if (mentionedFileIds.length > 0) {
          // Fetch file details for mentioned files
          const mentionedFilesPromises = mentionedFileIds.map(async (fileId) => {
            try {
              const fileResponse = await fetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?` +
                  new URLSearchParams({
                    fields:
                      "id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser/displayName",
                  }),
                {
                  headers: {
                    Authorization: `Bearer ${tokenResponse.accessToken}`,
                  },
                }
              );

              if (fileResponse.ok) {
                const file = (await fileResponse.json()) as DriveFile;
                // Check if file type matches filter
                const mimeTypes = {
                  documents: "application/vnd.google-apps.document",
                  spreadsheets: "application/vnd.google-apps.spreadsheet",
                  presentations: "application/vnd.google-apps.presentation",
                };
                if (
                  fileType === "all" ||
                  (fileType in mimeTypes &&
                    file.mimeType === mimeTypes[fileType as keyof typeof mimeTypes])
                ) {
                  return file;
                }
              }
            } catch {
              // Ignore errors fetching individual files
            }
            return null;
          });

          const mentionedFiles = (await Promise.all(mentionedFilesPromises)).filter(
            (f): f is DriveFile => f !== null
          );
          files.push(...mentionedFiles);
        }

        // Add files with unresolved comments that aren't already in the list
        for (const fileWithComments of filesWithUnresolvedComments) {
          if (fileWithComments.id && !existingFileIds.has(fileWithComments.id)) {
            files.push(fileWithComments);
            existingFileIds.add(fileWithComments.id);
          }
        }

        if (files.length === 0) {
          const ownershipText = ownedOnly ? "that you own " : "";
          return {
            content: [
              {
                type: "text",
                text: `📁 No ${fileType === "all" ? "" : `${fileType} `}files ${ownershipText}modified in the last ${daysBack} days.`,
              },
            ],
          };
        }

        // Build output with optional comments
        const outputParts: string[] = [];
        const filesWithMentions = new Set(mentionedFilesMap.keys());
        const filesWithCommentsSet = new Set(filesWithUnresolvedComments.map((f) => f.id));

        // Sort files: recently modified first, then files with comments, then mentioned files
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-criteria file sort comparator
        const sortedFiles = [...files].sort((a, b) => {
          const aIsRecent = a.modifiedTime && new Date(a.modifiedTime) > modifiedAfter;
          const bIsRecent = b.modifiedTime && new Date(b.modifiedTime) > modifiedAfter;
          if (aIsRecent && !bIsRecent) return -1;
          if (!aIsRecent && bIsRecent) return 1;

          const aHasComments = a.id && filesWithCommentsSet.has(a.id);
          const bHasComments = b.id && filesWithCommentsSet.has(b.id);
          if (aHasComments && !bHasComments) return -1;
          if (!aHasComments && bHasComments) return 1;

          return 0;
        });

        for (const file of sortedFiles) {
          const typeLabel = formatFileType(file.mimeType);
          const modifiedDate = file.modifiedTime
            ? new Date(file.modifiedTime).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })
            : "";
          const modifier = file.lastModifyingUser?.displayName || "";
          const hasMentions = !!(file.id && filesWithMentions.has(file.id));
          const hasUnresolvedComments = !!(file.id && filesWithCommentsSet.has(file.id));
          const isRecentlyModified = !!(
            file.modifiedTime && new Date(file.modifiedTime) > modifiedAfter
          );

          let fileOutput = `• ${typeLabel} **${file.name}**`;
          if (hasMentions) {
            fileOutput += ` 🔔 *mentioned in comments*`;
          }
          if (hasUnresolvedComments && !isRecentlyModified) {
            fileOutput += ` 💬 *has unresolved comments*`;
          }
          fileOutput += `\n`;
          fileOutput += `  Modified: ${modifiedDate}`;
          if (modifier) fileOutput += ` by ${modifier}`;
          if (file.webViewLink) fileOutput += `\n  📎 ${file.webViewLink}`;

          // Fetch unresolved comments if requested
          if (includeComments && file.id) {
            const comments = await getUnresolvedComments(file.id, tokenResponse.accessToken);
            if (comments.length > 0) {
              fileOutput += `\n  **${comments.length} unresolved comment${comments.length > 1 ? "s" : ""}:**`;
              for (const comment of comments.slice(0, 3)) {
                // Limit to 3 comments per file
                // Mark comments where user was mentioned
                const isMentioned = hasMentions; // Simplified: if file has mentions, mark all comments
                // In a more sophisticated implementation, we could check individual comments
                fileOutput += `\n${formatComment(comment, isMentioned)}`;
              }
              if (comments.length > 3) {
                fileOutput += `\n    ... and ${comments.length - 3} more`;
              }
            }
          }

          outputParts.push(fileOutput);
        }

        const mentionCount = filesWithMentions.size;
        const commentsCount = filesWithCommentsSet.size;
        let header = `📁 **Drive Files** (${files.length}`;
        const headerParts: string[] = [];
        if (mentionCount > 0) headerParts.push(`${mentionCount} with mentions`);
        if (commentsCount > 0) headerParts.push(`${commentsCount} with unresolved comments`);
        if (headerParts.length > 0) {
          header += `, ${headerParts.join(", ")})`;
        }
        header += `:\n\n`;
        const output = header + outputParts.join("\n\n");

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
          [DRIVE_RESOURCE, DRIVE_ACTIVITY_RESOURCE],
          [DRIVE_SCOPES, DRIVE_ACTIVITY_SCOPES]
        );
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof driveActivityInputSchema>
  );
}
