import { TIME_WINDOWS } from "../../constants";
import { getLogger } from "../../observability/logger";
import { AuthenticationError } from "../../utils/error-utils";
import type { DocCommentEmail } from "./drive-comments-utils";
import { getUnresolvedComments, verifyAndEnrichDocComments } from "./drive-comments-utils";
import { calculateRecencyBoost, categorizeScore, type PriorityMetadata } from "./priority-utils";
import type { AssignedActionDetail } from "./types";

/** Optional context for enriching results with Gmail-discovered doc comments */
export interface CommentEmailContext {
  docCommentEmails: DocCommentEmail[];
  driveToken: string;
}

// ── Drive v3 file list response types ────────────────────────────────────────

interface DriveFileItem {
  id?: string;
  name?: string;
  webViewLink?: string;
  modifiedTime?: string;
}

interface DriveFilesListResponse {
  files?: DriveFileItem[];
}

/**
 * Fetches Google Drive files that need the user's action via Drive v3.
 *
 * Primary query: `files.list` with `q='followup:actionitems'` — a Drive search
 * operator that returns files where the authenticated user has unresolved
 * assigned comments. This is a single API call.
 *
 * Fallback (if the primary query returns an HTTP error — not just empty):
 * Scans recently modified owned files and checks each for unresolved comments
 * via `getUnresolvedComments`. This is 1 + N API calls (N = files checked).
 *
 * @param driveToken - Google Drive v3 access token (drive.readonly scope)
 * @returns Array of assigned actions (files with action items for this user)
 */
export async function fetchDriveActionItems(driveToken: string): Promise<AssignedActionDetail[]> {
  const logger = getLogger().withOperation("drive_utils");

  // ── Primary: followup:actionitems ───────────────────────────────────────
  const primaryResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
      q: "followup:actionitems",
      pageSize: "20",
      orderBy: "modifiedTime desc",
      fields: "files(id,name,webViewLink,modifiedTime)",
    })}`,
    {
      headers: { Authorization: `Bearer ${driveToken}` },
    }
  );

  if (primaryResponse.ok) {
    const data = (await primaryResponse.json()) as DriveFilesListResponse;
    const files = data.files || [];

    logger.info("Drive v3 followup:actionitems", { fileCount: files.length });

    return files
      .filter((f) => f.id && (f.name || f.webViewLink))
      .map((f) => ({
        fileTitle: f.name || "Document",
        fileId: f.id,
        actionType: "assigned to you",
        fileLink: f.webViewLink || `https://drive.google.com/open?id=${f.id}`,
        timestamp: f.modifiedTime,
        isAssignment: true,
        driveType: "assignment" as const,
      }));
  }

  // Auth errors should propagate
  if (primaryResponse.status === 401 || primaryResponse.status === 403) {
    throw new AuthenticationError("Google Drive", primaryResponse.status);
  }

  // ── Fallback: owned files → per-file comment check ──────────────────────
  logger.warn("Drive followup:actionitems failed — falling back to owned-files scan", {
    status: primaryResponse.status,
  });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TIME_WINDOWS.DEFAULT_DAYS_BACK);

  const fallbackResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
      q: `'me' in owners AND modifiedTime > '${cutoff.toISOString()}' AND trashed = false AND (mimeType='application/vnd.google-apps.document' OR mimeType='application/vnd.google-apps.spreadsheet' OR mimeType='application/vnd.google-apps.presentation')`,
      pageSize: "10",
      orderBy: "modifiedTime desc",
      fields: "files(id,name,webViewLink,modifiedTime)",
    })}`,
    {
      headers: { Authorization: `Bearer ${driveToken}` },
    }
  );

  if (!fallbackResponse.ok) {
    if (fallbackResponse.status === 401 || fallbackResponse.status === 403) {
      throw new AuthenticationError("Google Drive", fallbackResponse.status);
    }
    logger.warn("Drive fallback files.list also failed — returning empty", {
      status: fallbackResponse.status,
    });
    return [];
  }

  const fallbackData = (await fallbackResponse.json()) as DriveFilesListResponse;
  const ownedFiles = (fallbackData.files || []).filter((f) => !!f.id);

  // Check each file for unresolved comments in parallel
  const results = await Promise.all(
    ownedFiles.map(async (f): Promise<AssignedActionDetail | null> => {
      const comments = await getUnresolvedComments(f.id!, driveToken);
      if (comments.length === 0) return null;

      return {
        fileTitle: f.name || "Document",
        fileId: f.id,
        actionType: `has ${comments.length} unresolved comment${comments.length !== 1 ? "s" : ""}`,
        fileLink: f.webViewLink || `https://drive.google.com/open?id=${f.id}`,
        timestamp: comments[0]?.createdTime || f.modifiedTime,
        isAssignment: false,
        commentCount: comments.length,
        driveType: "unresolved-comment" as const,
      };
    })
  );

  const actionItems = results.filter((r): r is AssignedActionDetail => r !== null);
  logger.info("Drive fallback results", {
    filesChecked: ownedFiles.length,
    actionItems: actionItems.length,
  });
  return actionItems;
}

/**
 * Fetches assigned actions from Google Drive.
 *
 * Uses the Drive Activity API for @mentions and assignments. When
 * commentEmailContext is provided, also verifies Gmail-discovered doc comment
 * emails against the Drive v3 API to surface unresolved comments on owned docs
 * (even when the user wasn't explicitly @mentioned).
 *
 * @param accessToken - Google Drive Activity access token
 * @param daysBack - Number of days to look back (default: 7, agent: 14)
 * @param commentEmailContext - Optional: Gmail doc comment emails + Drive v3 token
 * @returns Array of assigned actions (mentions, assignments, and unresolved comments)
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrates Drive Activity API calls and response parsing
export async function fetchAssignedActions(
  accessToken: string,
  daysBack: number = 7,
  commentEmailContext?: CommentEmailContext
): Promise<AssignedActionDetail[]> {
  const maxResults = 20;
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - daysBack);

  const response = await fetch("https://driveactivity.googleapis.com/v2/activity:query", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pageSize: maxResults,
      filter: `time >= "${startTime.toISOString()}" AND detail.action_detail_case:COMMENT`,
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError("Google Drive Activity", response.status);
    }
    getLogger()
      .withOperation("drive_utils")
      .warn("Drive Activity API error — returning empty results", {
        status: response.status,
        statusText: response.statusText,
      });
    return [];
  }

  type KnownUser = { isCurrentUser?: boolean };
  type CommentMention = { knownUser?: KnownUser };
  type CommentAssignment = { assignedUser?: { knownUser?: KnownUser } };
  type Comment = {
    mentionedUsers?: CommentMention[];
    assignment?: CommentAssignment;
  };
  type DriveItem = {
    title?: string;
    name?: string;
  };
  type Activity = {
    primaryActionDetail?: {
      comment?: Comment;
    };
    actors?: Array<{
      user?: { knownUser?: KnownUser };
    }>;
    targets?: Array<{
      driveItem?: DriveItem;
    }>;
    timestamp?: string;
  };
  type DriveActivityResponse = {
    activities?: Activity[];
  };

  const data = (await response.json()) as DriveActivityResponse;

  const activities = data.activities || [];
  const actionItems: AssignedActionDetail[] = [];
  const logger = getLogger().withOperation("drive_utils");

  logger.info("Drive Activity API response", {
    totalActivities: activities.length,
    daysBack,
  });

  for (const activity of activities) {
    const comment = activity.primaryActionDetail?.comment;
    if (!comment) continue;

    const wasAssigned = comment.assignment?.assignedUser?.knownUser?.isCurrentUser;
    const wasMentioned = comment.mentionedUsers?.some((u) => u.knownUser?.isCurrentUser);
    // Self-assignment: actor is current user + assignment exists but assignedUser flag wasn't set
    const actorIsSelf = activity.actors?.some((a) => a.user?.knownUser?.isCurrentUser);
    const isSelfAssignment = actorIsSelf && !!comment.assignment && !wasAssigned;

    if (wasAssigned || wasMentioned || isSelfAssignment) {
      const target = activity.targets?.[0];
      const rawTitle = target?.driveItem?.title;
      const fileId = target?.driveItem?.name?.match(/^items\/(.+)$/)?.[1];
      const fileLink = fileId ? `https://drive.google.com/open?id=${fileId}` : null;

      // Skip items with no title and no link — they'd show as unactionable "Untitled"
      if (!rawTitle && !fileLink) continue;
      const fileTitle = rawTitle || "Document";

      let actionType = "";
      if (comment.assignment) {
        actionType = "assigned to you";
      } else if (wasMentioned) {
        actionType = "mentioned you";
      }

      actionItems.push({
        fileTitle,
        fileId,
        actionType,
        fileLink,
        timestamp: activity.timestamp,
        isAssignment: !!comment.assignment,
        driveType: comment.assignment ? "assignment" : "mention",
      });
    } else {
      logger.debug("Drive activity filtered out", {
        hasAssignment: !!comment.assignment,
        assignedUserIsCurrentUser: comment.assignment?.assignedUser?.knownUser?.isCurrentUser,
        mentionedUsersCount: comment.mentionedUsers?.length ?? 0,
        actorIsSelf,
        targetTitle: activity.targets?.[0]?.driveItem?.title,
      });
    }
  }

  logger.info("Drive Activity filter results", {
    totalActivities: activities.length,
    passedFilter: actionItems.length,
    filteredOut: activities.length - actionItems.length,
  });

  // Enrich with Gmail-discovered doc comment emails (if context provided)
  if (commentEmailContext && commentEmailContext.docCommentEmails.length > 0) {
    // Build set of fileIds already surfaced via @mention/assignment (dedup)
    const existingFileIds = new Set(
      actionItems.map((a) => a.fileId).filter((id): id is string => !!id)
    );

    const verifiedComments = await verifyAndEnrichDocComments(
      commentEmailContext.docCommentEmails,
      commentEmailContext.driveToken,
      existingFileIds
    );

    actionItems.push(...verifiedComments);
  }

  return actionItems;
}

/**
 * Calculates priority metadata for Google Drive assigned actions.
 *
 * Priority tiers:
 * - Assignments: base 140 (direct request for action)
 * - Mentions: base 100 (explicit attention request)
 * - Unresolved comments: base 80 (needs attention, less urgent than mention)
 *   + bonus if 3+ comments: +15 (multiple people waiting)
 *
 * Recency boosts apply to all types:
 * - <1 hour: +50 | <4 hours: +30 | <24 hours: +10
 *
 * @param item - Assigned action detail
 * @param now - Current date/time for recency calculations
 * @returns Priority metadata
 */
export function calculateDrivePriority(item: AssignedActionDetail, now: Date): PriorityMetadata {
  let score: number;
  const reasons: string[] = [];

  if (item.isAssignment) {
    score = 140;
    reasons.push("Assigned to you");
  } else if (item.commentCount != null) {
    // Unresolved comments on owned doc (discovered via Gmail comment email)
    score = 80;
    reasons.push("Unresolved comments on your doc");
    if (item.commentCount >= 3) {
      score += 15;
      reasons.push("Multiple comments waiting");
    }
  } else {
    score = 100;
    reasons.push("Mentioned you");
  }

  const timestamp = item.timestamp ? new Date(item.timestamp) : null;
  const ageHours = timestamp ? (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60) : 999;

  if (ageHours < 1) {
    score += 50;
    reasons.push("Very recent");
  } else if (ageHours < 4) {
    score += 30;
    reasons.push("Recent");
  } else if (ageHours < 24) {
    score += 10;
  }

  return {
    score,
    category: categorizeScore(score),
    signals: {
      isAssignment: item.isAssignment ?? false,
      commentCount: item.commentCount ?? 0,
      ageHours,
      recencyBoost: calculateRecencyBoost(ageHours),
    },
    reasons,
  };
}
