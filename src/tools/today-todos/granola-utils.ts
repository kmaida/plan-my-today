import type { MeetingNoteActionDetail } from "./types";
import { PriorityMetadata, categorizeScore, calculateRecencyBoost } from "./priority-utils";
import { PRIORITY_THRESHOLDS, TIME_WINDOWS, FETCH_LIMITS } from "../../constants";
import { isActionCompleted } from "../../services/action-completion-store";
import { buildMeetingNoteId } from "../../utils/action-identifiers";

/**
 * Google Drive API types
 */
interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

interface DriveFilesResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

/**
 * Extracted action item from document content
 */
interface ExtractedActionItem {
  text: string;
  assignee?: string;
  isUrgent: boolean;
}

/**
 * Options for fetching meeting notes
 */
export interface FetchMeetingNotesOptions {
  daysBack?: number;
  maxResults?: number;
  folderName?: string;
}

const DEFAULT_FOLDER_NAME = "Meeting Notes";
const DEFAULT_DAYS_BACK = TIME_WINDOWS.DEFAULT_DAYS_BACK;
const DEFAULT_MAX_RESULTS = FETCH_LIMITS.MEETINGS;

/**
 * Finds the ID of a folder by name in Google Drive
 */
export async function findFolderByName(
  accessToken: string,
  folderName: string
): Promise<string | null> {
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?` +
    new URLSearchParams({
      q: query,
      fields: "files(id,name)",
      pageSize: "1",
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to search for folder: ${response.status} ${errorText}`);
  }

  const data = await response.json() as DriveFilesResponse;
  return data.files?.[0]?.id || null;
}

/**
 * Fetches recent Google Docs from a folder
 */
export async function fetchDocsFromFolder(
  accessToken: string,
  folderId: string,
  daysBack: number,
  maxResults: number
): Promise<DriveFile[]> {
  const modifiedAfter = new Date();
  modifiedAfter.setDate(modifiedAfter.getDate() - daysBack);

  const query = `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and modifiedTime>'${modifiedAfter.toISOString()}' and trashed=false`;

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?` +
    new URLSearchParams({
      q: query,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      pageSize: String(maxResults),
      orderBy: "modifiedTime desc",
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list files: ${response.status} ${errorText}`);
  }

  const data = await response.json() as DriveFilesResponse;
  return data.files || [];
}

/**
 * Exports a Google Doc as plain text
 */
export async function exportDocAsText(
  accessToken: string,
  fileId: string
): Promise<string> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?` +
    new URLSearchParams({
      mimeType: "text/plain",
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to export document: ${response.status} ${errorText}`);
  }

  return response.text();
}

/**
 * Extracts action items from document content using regex patterns
 */
export function extractActionItemsFromContent(content: string): ExtractedActionItem[] {
  const actionItems: ExtractedActionItem[] = [];
  const seenItems = new Set<string>();

  // Urgency detection pattern
  const urgencyPattern = /\b(urgent|asap|today|immediately|critical|eod|end of day)\b/i;

  // Pattern 1: Checkbox items [ ] or - [ ]
  const checkboxPattern = /^[\s-]*\[\s?\]\s*(.+)$/gm;
  let match;
  while ((match = checkboxPattern.exec(content)) !== null) {
    const text = match[1].trim();
    if (text && !seenItems.has(text.toLowerCase())) {
      seenItems.add(text.toLowerCase());
      const assignee = extractAssignee(text);
      actionItems.push({
        text,
        assignee,
        isUrgent: urgencyPattern.test(text),
      });
    }
  }

  // Pattern 2: Action Items section header followed by bullet points
  const sectionPattern = /action items?:?\s*\n((?:[\s]*[-•*]\s*.+\n?)+)/gi;
  while ((match = sectionPattern.exec(content)) !== null) {
    const section = match[1];
    const bulletPattern = /[-•*]\s*(.+)/g;
    let bulletMatch;
    while ((bulletMatch = bulletPattern.exec(section)) !== null) {
      const text = bulletMatch[1].trim();
      // Skip if it's a checkbox item (already captured)
      if (text && !text.startsWith("[") && !seenItems.has(text.toLowerCase())) {
        seenItems.add(text.toLowerCase());
        const assignee = extractAssignee(text);
        actionItems.push({
          text,
          assignee,
          isUrgent: urgencyPattern.test(text),
        });
      }
    }
  }

  // Pattern 3: TODO/ACTION/FIXME markers
  const todoPattern = /(?:TODO|ACTION|FIXME):\s*(.+)/gi;
  while ((match = todoPattern.exec(content)) !== null) {
    const text = match[1].trim();
    if (text && !seenItems.has(text.toLowerCase())) {
      seenItems.add(text.toLowerCase());
      const assignee = extractAssignee(text);
      actionItems.push({
        text,
        assignee,
        isUrgent: urgencyPattern.test(text),
      });
    }
  }

  // Pattern 4: @mentions followed by action verbs
  const mentionActionPattern = /@(\w+)\s+(?:please|should|will|needs? to|to)\s+(.+?)(?:\.|$)/gi;
  while ((match = mentionActionPattern.exec(content)) !== null) {
    const assignee = match[1];
    const action = match[2].trim();
    const text = `@${assignee} ${action}`;
    if (action && !seenItems.has(text.toLowerCase())) {
      seenItems.add(text.toLowerCase());
      actionItems.push({
        text,
        assignee,
        isUrgent: urgencyPattern.test(action),
      });
    }
  }

  // Pattern 5: Next steps section
  const nextStepsPattern = /next steps?:?\s*\n((?:[\s]*[-•*\d.]\s*.+\n?)+)/gi;
  while ((match = nextStepsPattern.exec(content)) !== null) {
    const section = match[1];
    const stepPattern = /[-•*\d.]\s*(.+)/g;
    let stepMatch;
    while ((stepMatch = stepPattern.exec(section)) !== null) {
      const text = stepMatch[1].trim();
      if (text && !seenItems.has(text.toLowerCase())) {
        seenItems.add(text.toLowerCase());
        const assignee = extractAssignee(text);
        actionItems.push({
          text,
          assignee,
          isUrgent: urgencyPattern.test(text),
        });
      }
    }
  }

  return actionItems;
}

/**
 * Extracts an assignee from text (looks for @mentions or "assigned to" patterns)
 */
function extractAssignee(text: string): string | undefined {
  // Pattern: @username or @name
  const atMentionMatch = text.match(/@(\w+)/);
  if (atMentionMatch) {
    return atMentionMatch[1];
  }

  // Pattern: "assigned to Name" or "for Name"
  const assignedToMatch = text.match(/(?:assigned to|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (assignedToMatch) {
    return assignedToMatch[1];
  }

  return undefined;
}

/**
 * Calculates priority for a meeting note action item
 */
export function calculateMeetingNotePriority(
  actionItem: MeetingNoteActionDetail,
  now: Date
): PriorityMetadata {
  let score = 80; // Base score for meeting notes (inherently actionable)
  const reasons: string[] = [];
  const signals: Record<string, any> = {};

  // Recency boost
  const ageHours = (now.getTime() - actionItem.timestamp) / (1000 * 60 * 60);
  signals.ageHours = Math.round(ageHours * 10) / 10;
  signals.recencyBoost = calculateRecencyBoost(ageHours);

  if (ageHours < 1) {
    score += 50;
    reasons.push("Very recent meeting notes");
  } else if (ageHours < 4) {
    score += 30;
    reasons.push("Recent meeting notes");
  } else if (ageHours < 24) {
    score += 10;
    reasons.push("From today");
  }

  // Urgency markers
  signals.isUrgent = actionItem.isUrgent;
  if (actionItem.isUrgent) {
    score += 40;
    reasons.push("Marked as urgent");
  }

  // Assignee present (indicates explicit delegation)
  signals.hasAssignee = !!actionItem.assignee;
  if (actionItem.assignee) {
    score += 20;
    reasons.push(`Assigned to ${actionItem.assignee}`);
    signals.assignee = actionItem.assignee;
  }

  return {
    score: Math.min(score, 300), // Cap at 300
    category: categorizeScore(score),
    signals,
    reasons,
  };
}

/**
 * Fetches and processes meeting notes from Google Drive
 */
export async function fetchMeetingNoteActions(
  accessToken: string,
  options: FetchMeetingNotesOptions = {}
): Promise<MeetingNoteActionDetail[]> {
  const {
    daysBack = DEFAULT_DAYS_BACK,
    maxResults = DEFAULT_MAX_RESULTS,
    folderName = DEFAULT_FOLDER_NAME,
  } = options;

  // Find the Meeting Notes folder
  const folderId = await findFolderByName(accessToken, folderName);
  if (!folderId) {
    return []; // Folder not found, return empty
  }

  // Fetch recent documents from the folder
  const docs = await fetchDocsFromFolder(accessToken, folderId, daysBack, maxResults);
  if (docs.length === 0) {
    return [];
  }

  const allActionItems: MeetingNoteActionDetail[] = [];
  const now = new Date();

  // Process each document (with concurrency limit)
  const concurrencyLimit = 3;
  for (let i = 0; i < docs.length; i += concurrencyLimit) {
    const batch = docs.slice(i, i + concurrencyLimit);
    const batchResults = await Promise.all(
      batch.map(async (doc) => {
        if (!doc.id || !doc.name) return [];

        try {
          const content = await exportDocAsText(accessToken, doc.id);
          const extractedItems = extractActionItemsFromContent(content);
          const timestamp = doc.modifiedTime
            ? new Date(doc.modifiedTime).getTime()
            : now.getTime();

          return extractedItems.map((item) => {
            const actionDetail: MeetingNoteActionDetail = {
              documentId: doc.id!,
              documentTitle: doc.name!,
              documentLink: doc.webViewLink || `https://docs.google.com/document/d/${doc.id}`,
              actionItem: item.text,
              assignee: item.assignee,
              isUrgent: item.isUrgent,
              timestamp,
            };
            actionDetail.priorityMetadata = calculateMeetingNotePriority(actionDetail, now);
            return actionDetail;
          });
        } catch (error) {
          // Skip documents that fail to export
          console.error(`Failed to process document ${doc.name}:`, error);
          return [];
        }
      })
    );

    allActionItems.push(...batchResults.flat());
  }

  // Sort by priority score (highest first)
  allActionItems.sort((a, b) => {
    const scoreA = a.priorityMetadata?.score || 0;
    const scoreB = b.priorityMetadata?.score || 0;
    return scoreB - scoreA;
  });

  // Filter out completed actions
  const filteredActions: MeetingNoteActionDetail[] = [];
  for (const action of allActionItems) {
    const actionId = buildMeetingNoteId(action.documentId, action.actionItem);
    const completed = await isActionCompleted("meeting-note", actionId);
    if (!completed) {
      filteredActions.push(action);
    }
  }

  return filteredActions;
}
