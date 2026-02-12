import { isActionCompleted } from "../../services/action-completion-store";
import { AuthenticationError } from "../../utils/error-utils";
import type { DocCommentEmail } from "./drive-comments-utils";
import { verifyAndEnrichDocComments } from "./drive-comments-utils";
import { calculateRecencyBoost, categorizeScore, type PriorityMetadata } from "./priority-utils";
import type { AssignedActionDetail } from "./types";

/** Optional context for enriching results with Gmail-discovered doc comments */
export interface CommentEmailContext {
  docCommentEmails: DocCommentEmail[];
  driveToken: string;
}

/**
 * Fetches assigned actions from Google Docs.
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

  for (const activity of activities) {
    const comment = activity.primaryActionDetail?.comment;
    if (!comment) continue;

    const wasAssigned = comment.assignment?.assignedUser?.knownUser?.isCurrentUser;
    const wasMentioned = comment.mentionedUsers?.some((u) => u.knownUser?.isCurrentUser);

    if (wasAssigned || wasMentioned) {
      const target = activity.targets?.[0];
      const fileTitle = target?.driveItem?.title || "Untitled";
      const fileId = target?.driveItem?.name?.match(/^items\/(.+)$/)?.[1];
      const fileLink = fileId ? `https://docs.google.com/document/d/${fileId}` : null;

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
      });
    }
  }

  // Filter out completed actions
  // The identifier used by mark-action-complete is the fileLink URL or fileTitle
  const filteredActions: AssignedActionDetail[] = [];
  for (const action of actionItems) {
    const identifier = action.fileLink || action.fileTitle;
    if (identifier && (await isActionCompleted("docs", identifier))) {
      continue;
    }
    filteredActions.push(action);
  }

  // Enrich with Gmail-discovered doc comment emails (if context provided)
  if (commentEmailContext && commentEmailContext.docCommentEmails.length > 0) {
    // Build set of fileIds already surfaced via @mention/assignment (dedup)
    const existingFileIds = new Set(
      filteredActions.map((a) => a.fileId).filter((id): id is string => !!id)
    );

    const verifiedComments = await verifyAndEnrichDocComments(
      commentEmailContext.docCommentEmails,
      commentEmailContext.driveToken,
      existingFileIds
    );

    // Filter out completed comment items
    for (const item of verifiedComments) {
      const identifier = item.fileLink || item.fileTitle;
      if (identifier && (await isActionCompleted("docs", identifier))) {
        continue;
      }
      filteredActions.push(item);
    }
  }

  return filteredActions;
}

/**
 * Calculates priority metadata for Google Docs assigned actions.
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
export function calculateDocsPriority(item: AssignedActionDetail, now: Date): PriorityMetadata {
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
