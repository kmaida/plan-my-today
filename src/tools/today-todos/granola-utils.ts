import { config } from "../../config";
import { FETCH_LIMITS } from "../../constants";
import { getLogger } from "../../observability/logger";
import { getCompletedBySource } from "../../services/action-completion-store";
import {
  type ExtractionCacheData,
  getCachedItems,
  loadCache,
  pruneCacheEntries,
  saveCache,
  setCachedItems,
} from "../../services/llm-cache";
import { hashActionText } from "../../utils/action-identifiers";
import { isWithinBusinessDays, parseDateFromFilename } from "../../utils/date-utils";
import { containsExactToken } from "./cross-reference-utils";
import {
  extractActionItemsWithLlmChunked,
  shouldUseLlmExtraction,
} from "./llm-extraction";
import { calculateRecencyBoost, categorizeScore, type PriorityMetadata } from "./priority-utils";
import type { MeetingNoteActionDetail } from "./types";

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
}

const DEFAULT_MAX_RESULTS = FETCH_LIMITS.MEETINGS;

/** Max meeting age for LLM extraction (business days). Older docs get regex-only —
 *  by then, action items are likely captured in Linear. Cache hits still return
 *  LLM-extracted items from when the doc was recent. */
const LLM_RECENCY_BUSINESS_DAYS = 3;

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

  const data = (await response.json()) as DriveFilesResponse;
  return data.files || [];
}

/**
 * Exports a Google Doc as plain text
 */
export async function exportDocAsText(accessToken: string, fileId: string): Promise<string> {
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
 * Action text must be 3+ chars and contain at least one letter.
 * Filters out junk like "--" or "-" captured from separator lines.
 */
function isValidActionText(text: string): boolean {
  return text.length >= 3 && /[a-zA-Z]/.test(text);
}

/**
 * Extracts action items from document content using regex patterns
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-pattern regex extraction
export function extractActionItemsFromContent(content: string): ExtractedActionItem[] {
  const actionItems: ExtractedActionItem[] = [];
  const seenItems = new Set<string>();

  // Urgency detection pattern
  const urgencyPattern = /\b(urgent|asap|today|immediately|critical|eod|end of day)\b/i;

  // Pattern 1: Checkbox items [ ] or - [ ]
  const checkboxPattern = /^[\s-]*\[\s?\]\s*(.+)$/gm;
  let match: RegExpExecArray | null = checkboxPattern.exec(content);
  while (match !== null) {
    const text = match[1].trim();
    if (text && isValidActionText(text) && !seenItems.has(text.toLowerCase())) {
      seenItems.add(text.toLowerCase());
      const assignee = extractAssignee(text);
      actionItems.push({
        text,
        assignee,
        isUrgent: urgencyPattern.test(text),
      });
    }
    match = checkboxPattern.exec(content);
  }

  // Pattern 2: Action Items section header followed by bullet points
  const sectionPattern = /action items?:?\s*\n((?:[\s]*[-•*]\s*.+\n?)+)/gi;
  match = sectionPattern.exec(content);
  while (match !== null) {
    const section = match[1];
    const bulletPattern = /[-•*]\s*(.+)/g;
    let bulletMatch: RegExpExecArray | null = bulletPattern.exec(section);
    while (bulletMatch !== null) {
      const text = bulletMatch[1].trim();
      // Skip if it's a checkbox item (already captured)
      if (
        text &&
        isValidActionText(text) &&
        !text.startsWith("[") &&
        !seenItems.has(text.toLowerCase())
      ) {
        seenItems.add(text.toLowerCase());
        const assignee = extractAssignee(text);
        actionItems.push({
          text,
          assignee,
          isUrgent: urgencyPattern.test(text),
        });
      }
      bulletMatch = bulletPattern.exec(section);
    }
    match = sectionPattern.exec(content);
  }

  // Pattern 3: TODO/ACTION/FIXME markers
  const todoPattern = /(?:TODO|ACTION|FIXME):\s*(.+)/gi;
  match = todoPattern.exec(content);
  while (match !== null) {
    const text = match[1].trim();
    if (text && isValidActionText(text) && !seenItems.has(text.toLowerCase())) {
      seenItems.add(text.toLowerCase());
      const assignee = extractAssignee(text);
      actionItems.push({
        text,
        assignee,
        isUrgent: urgencyPattern.test(text),
      });
    }
    match = todoPattern.exec(content);
  }

  // Pattern 4: @mentions followed by action verbs
  const mentionActionPattern = /@(\w+)\s+(?:please|should|will|needs? to|to)\s+(.+?)(?:\.|$)/gi;
  match = mentionActionPattern.exec(content);
  while (match !== null) {
    const assignee = match[1];
    const action = match[2].trim();
    const text = `@${assignee} ${action}`;
    if (action && isValidActionText(action) && !seenItems.has(text.toLowerCase())) {
      seenItems.add(text.toLowerCase());
      actionItems.push({
        text,
        assignee,
        isUrgent: urgencyPattern.test(action),
      });
    }
    match = mentionActionPattern.exec(content);
  }

  // Pattern 5: Next steps section
  const nextStepsPattern = /next steps?:?\s*\n((?:[\s]*[-•*\d.]\s*.+\n?)+)/gi;
  match = nextStepsPattern.exec(content);
  while (match !== null) {
    const section = match[1];
    const stepPattern = /[-•*\d.]\s*(.+)/g;
    let stepMatch: RegExpExecArray | null = stepPattern.exec(section);
    while (stepMatch !== null) {
      const text = stepMatch[1].trim();
      if (text && isValidActionText(text) && !seenItems.has(text.toLowerCase())) {
        seenItems.add(text.toLowerCase());
        const assignee = extractAssignee(text);
        actionItems.push({
          text,
          assignee,
          isUrgent: urgencyPattern.test(text),
        });
      }
      stepMatch = stepPattern.exec(section);
    }
    match = nextStepsPattern.exec(content);
  }

  return actionItems;
}

/** Common label words that can start a line with a colon but aren't people names. */
const NON_NAME_PREFIXES = new Set([
  "note",
  "action",
  "todo",
  "fixme",
  "update",
  "important",
  "reminder",
  "context",
  "background",
  "summary",
  "decision",
  "question",
  "example",
]);

/**
 * Extracts an assignee from text.
 * Checks (in order): @mentions, "Name:" prefix (Granola convention),
 * and explicit "assigned to Name" phrasing.
 * The old "for Name" pattern was removed because it false-positived on
 * phrases like "for topic brainstorming" or "for new features".
 */
function extractAssignee(text: string): string | undefined {
  // Pattern: @username or @name
  const atMentionMatch = text.match(/@(\w+)/);
  if (atMentionMatch) {
    return atMentionMatch[1];
  }

  // Pattern: "Name:" prefix (Granola uses "Kim: do the thing", "All: do the thing").
  const prefixMatch = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?):\s/);
  if (prefixMatch && !NON_NAME_PREFIXES.has(prefixMatch[1].toLowerCase())) {
    return prefixMatch[1];
  }

  // Pattern: "assigned to Name" (no "for" — too many false positives)
  const assignedToMatch = text.match(/assigned to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
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
  const signals: Record<string, string | number | boolean | null> = {};

  // Recency boost - use meetingDate if available, otherwise fall back to timestamp
  const relevantTimestamp = actionItem.meetingDate
    ? actionItem.meetingDate.getTime()
    : actionItem.timestamp;

  const ageHours = (now.getTime() - relevantTimestamp) / (1000 * 60 * 60);
  signals.ageHours = Math.round(ageHours * 10) / 10;
  signals.usedMeetingDate = !!actionItem.meetingDate;
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
 * Builds MeetingNoteActionDetail objects from extracted items, applying
 * user-name filtering and priority scoring. Used by both the cache-hit
 * and cache-miss paths to keep the logic DRY.
 */
export function buildActionDetails(
  extractedItems: ExtractedActionItem[],
  doc: DriveFile,
  timestamp: number,
  meetingDate: Date | null,
  now: Date
): MeetingNoteActionDetail[] {
  // Filter to items relevant to the current user (if configured)
  const userNames = config.userDisplayNames;
  const relevantItems =
    userNames.length > 0
      ? extractedItems.filter((item) => {
          if (!item.assignee) return false; // Unassigned = not attributable to user
          const assigneeLower = item.assignee.toLowerCase();
          const textLower = item.text.toLowerCase();
          return userNames.some(
            (name) =>
              containsExactToken(assigneeLower, name) || containsExactToken(textLower, name)
          );
        })
      : extractedItems;

  return relevantItems.map((item) => {
    const actionDetail: MeetingNoteActionDetail = {
      documentId: doc.id!,
      documentTitle: doc.name!,
      documentLink: doc.webViewLink || `https://docs.google.com/document/d/${doc.id}`,
      actionItem: item.text,
      assignee: item.assignee,
      isUrgent: item.isUrgent,
      timestamp,
      meetingDate: meetingDate || undefined,
    };
    actionDetail.priorityMetadata = calculateMeetingNotePriority(actionDetail, now);
    return actionDetail;
  });
}

/**
 * Fetches and processes meeting notes from Google Drive
 */
export async function fetchMeetingNoteActions(
  accessToken: string,
  options: FetchMeetingNotesOptions = {}
): Promise<MeetingNoteActionDetail[]> {
  const {
    daysBack = 7,
    maxResults = DEFAULT_MAX_RESULTS,
  } = options;

  // Folder ID is configured via MEETING_NOTES_FOLDER_ID env var
  const folderId = config.meetingNotesFolderId;
  if (!folderId) {
    return []; // No folder configured, return empty
  }

  // Fetch recent documents from the folder
  const docs = await fetchDocsFromFolder(accessToken, folderId, daysBack, maxResults);
  if (docs.length === 0) {
    return [];
  }

  const now = new Date();
  const eligibleDocs = docs.filter((doc) => !!doc.name);

  if (eligibleDocs.length === 0) {
    return [];
  }

  const logger = getLogger().withOperation("meeting_notes");
  const allActionItems: MeetingNoteActionDetail[] = [];

  // Load cache once — all lookups and writes happen in-memory to avoid
  // race conditions when multiple docs are processed concurrently.
  const cache: ExtractionCacheData = await loadCache().catch(() => ({ entries: {} }));
  let cacheModified = false;

  // Prune stale cache entries for docs no longer in the eligible window
  const eligibleDocIds = new Set(eligibleDocs.map((d) => d.id).filter(Boolean) as string[]);
  const pruned = pruneCacheEntries(cache, eligibleDocIds);
  if (pruned > 0) cacheModified = true;

  // Process all docs in a single concurrent batch — FETCH_LIMITS.MEETINGS caps
  // the eligible list at 5, and the LLM recency gate ensures only 1-2 docs
  // actually hit the API. No need for sequential batching.
  const batchResults = await Promise.all(
    eligibleDocs.map(async (doc) => {
      if (!doc.id || !doc.name) return [];

      // Parse meeting date from filename
      const meetingDate = parseDateFromFilename(doc.name);

      try {
        // Check extraction cache — meeting docs are write-once, so cached
        // results are valid indefinitely until the doc leaves the lookback window.
        const cached = getCachedItems(cache, doc.id);
        if (cached) {
          logger.info(`Cache hit for document ${doc.name}`);
          const timestamp = doc.modifiedTime ? new Date(doc.modifiedTime).getTime() : now.getTime();
          return buildActionDetails(cached, doc, timestamp, meetingDate, now);
        }

        // Cache miss — full extraction pipeline
        logger.info(`Cache miss for document ${doc.name}, running extraction`);
        const content = await exportDocAsText(accessToken, doc.id);
        const regexItems = extractActionItemsFromContent(content);

        // LLM is the authoritative relevance filter: it reviews regex items
        // for user relevance AND discovers additional implicit commitments.
        // Only runs for recent docs (≤ 3 business days) — older meetings
        // likely have action items in Linear already.
        // Cache hits bypass this gate — they return whatever was cached
        // when the doc was first processed (including LLM results).
        const dateForRecency = meetingDate
          ?? (doc.modifiedTime ? new Date(doc.modifiedTime) : null);
        const isRecentEnough = dateForRecency
          ? isWithinBusinessDays(dateForRecency, LLM_RECENCY_BUSINESS_DAYS, now)
          : true;

        let extractedItems: ExtractedActionItem[];
        if (isRecentEnough && shouldUseLlmExtraction(content)) {
          const llmItems = await extractActionItemsWithLlmChunked(
            content,
            regexItems.map((item) => item.text),
            config.userDisplayNames
          );
          // LLM results are canonical — they include confirmed regex items
          // plus new discoveries, already filtered for user relevance.
          extractedItems = llmItems;

          if (llmItems.length === 0 && regexItems.length > 0) {
            logger.info(
              `LLM returned 0 items for "${doc.name}" (regex found ${regexItems.length}) — trusting LLM relevance judgment`
            );
          }
        } else {
          extractedItems = regexItems;
        }

        // Store results in the in-memory cache.
        // setCachedItems is synchronous — no race condition between
        // concurrent docs in the same Promise.all batch.
        setCachedItems(cache, doc.id, extractedItems);
        cacheModified = true;

        const timestamp = doc.modifiedTime ? new Date(doc.modifiedTime).getTime() : now.getTime();
        return buildActionDetails(extractedItems, doc, timestamp, meetingDate, now);
      } catch (error) {
        // Skip documents that fail to export
        logger.error(`Failed to process document ${doc.name}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    })
  );

  allActionItems.push(...batchResults.flat());

  // Persist cache to disk once after all processing is complete
  if (cacheModified) {
    await saveCache(cache).catch((err) => {
      logger.warn("Failed to write extraction cache", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Sort by priority score (highest first)
  allActionItems.sort((a, b) => {
    const scoreA = a.priorityMetadata?.score || 0;
    const scoreB = b.priorityMetadata?.score || 0;
    return scoreB - scoreA;
  });

  // Filter out completed actions (1 file read → Set for O(1) lookups).
  // The identifier may be just the documentId (dismisses all actions from
  // that doc) or documentId:hash (specific action).
  const completedSet = await getCompletedBySource("meeting-note");
  const filteredActions = allActionItems.filter((action) => {
    if (completedSet.has(action.documentId)) return false;
    const specificId = `${action.documentId}:${hashActionText(action.actionItem)}`;
    return !completedSet.has(specificId);
  });

  // Cap total meeting note actions — items are already sorted by priority,
  // so slicing keeps the most important ones and avoids dashboard overload.
  return filteredActions.slice(0, FETCH_LIMITS.MEETING_NOTE_ACTIONS);
}
