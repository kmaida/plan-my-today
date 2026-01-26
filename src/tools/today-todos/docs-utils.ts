import type { AssignedActionDetail } from "./types";

/**
 * Fetches assigned actions from Google Docs
 */
export async function fetchAssignedActions(accessToken: string): Promise<AssignedActionDetail[]> {
  const daysBack = 7;
  const maxResults = 20;
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - daysBack);

  const response = await fetch(
    "https://driveactivity.googleapis.com/v2/activity:query",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pageSize: maxResults,
        filter: `time >= "${startTime.toISOString()}" AND detail.action_detail_case:COMMENT`,
      }),
    }
  );

  if (!response.ok) {
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

  const data = await response.json() as DriveActivityResponse;

  const activities = data.activities || [];
  const actionItems: AssignedActionDetail[] = [];

  for (const activity of activities) {
    const comment = activity.primaryActionDetail?.comment;
    if (!comment) continue;

    const wasAssigned = comment.assignment?.assignedUser?.knownUser?.isCurrentUser;
    const wasMentioned = comment.mentionedUsers?.some(u => u.knownUser?.isCurrentUser);

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
        actionType,
        fileLink,
        timestamp: activity.timestamp,
        isAssignment: !!comment.assignment,
      });
    }
  }

  return actionItems;
}
