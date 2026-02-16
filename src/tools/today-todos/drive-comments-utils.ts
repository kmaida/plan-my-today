/**
 * Shared utilities for fetching and verifying Google Drive comments.
 *
 * Extracted from drive-activity.ts so both the standalone drive-activity tool
 * and the daily task aggregation pipeline can reuse comment-fetching logic.
 */

import type { AssignedActionDetail } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DriveComment {
  id?: string;
  content?: string;
  author?: { displayName?: string };
  createdTime?: string;
  resolved?: boolean;
  quotedFileContent?: { value?: string };
}

export interface DriveCommentsResponse {
  comments?: DriveComment[];
  nextPageToken?: string;
}

/** Shape of a doc comment email extracted from Gmail */
export interface DocCommentEmail {
  fileId: string;
  fileTitle: string;
  commentUrl: string;
  emailTimestamp?: number;
}

// ── Functions ────────────────────────────────────────────────────────────────

/**
 * Fetches unresolved comments for a single Google Drive file.
 *
 * Uses the Drive v3 `/files/{id}/comments` endpoint. Returns up to 10
 * comments per file (the API's page size limit per call). Only unresolved
 * comments are returned.
 *
 * @param fileId - Google Drive file ID
 * @param accessToken - Drive v3 access token (requires `drive.readonly` scope)
 * @returns Array of unresolved comments, empty on error
 */
export async function getUnresolvedComments(
  fileId: string,
  accessToken: string
): Promise<DriveComment[]> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/comments?` +
      new URLSearchParams({
        fields:
          "comments(id,content,author/displayName,createdTime,resolved,quotedFileContent/value)",
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

  const data = (await response.json()) as DriveCommentsResponse;
  return (data.comments || []).filter((c) => !c.resolved);
}

/**
 * Verify Gmail-discovered doc comment emails against the Drive v3 API and
 * return enriched AssignedActionDetail items.
 *
 * For each doc that had a comment notification email:
 * 1. Skip if fileId is in excludeFileIds (already surfaced via @mention/assignment)
 * 2. Query Drive v3 for unresolved comments on that file
 * 3. If all comments are resolved → suppress (don't return the item)
 * 4. Otherwise → return an AssignedActionDetail with comment count and direct link
 *
 * This approach makes only N API calls where N = number of docs with comment
 * emails (typically 3-5), rather than scanning all owned files.
 *
 * @param docCommentEmails - Doc comment emails extracted from Gmail
 * @param driveToken - Drive v3 access token
 * @param excludeFileIds - File IDs already surfaced via @mention/assignment (dedup)
 * @returns Verified AssignedActionDetail items for docs with unresolved comments
 */
export async function verifyAndEnrichDocComments(
  docCommentEmails: DocCommentEmail[],
  driveToken: string,
  excludeFileIds: Set<string>
): Promise<AssignedActionDetail[]> {
  // Filter out docs already surfaced via Drive Activity API (@mentions/assignments)
  const toVerify = docCommentEmails.filter((e) => !excludeFileIds.has(e.fileId));

  if (toVerify.length === 0) {
    return [];
  }

  // Verify each doc has unresolved comments (parallel, bounded by input size)
  const results = await Promise.all(
    toVerify.map(async (email): Promise<AssignedActionDetail | null> => {
      const unresolvedComments = await getUnresolvedComments(email.fileId, driveToken);

      // All comments resolved → suppress this item
      if (unresolvedComments.length === 0) {
        return null;
      }

      const count = unresolvedComments.length;
      const latestComment = unresolvedComments[0]; // API returns most recent first

      return {
        fileTitle: email.fileTitle,
        fileId: email.fileId,
        actionType: `has ${count} unresolved comment${count !== 1 ? "s" : ""}`,
        fileLink: email.commentUrl,
        timestamp:
          latestComment?.createdTime ||
          (email.emailTimestamp ? new Date(email.emailTimestamp).toISOString() : undefined),
        isAssignment: false,
        commentCount: count,
        driveType: "unresolved-comment" as const,
      };
    })
  );

  return results.filter((r): r is AssignedActionDetail => r !== null);
}
