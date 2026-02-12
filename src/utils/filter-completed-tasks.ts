import { getCompletedBySources } from "../services/action-completion-store";
import { hashActionText } from "./action-identifiers";

/**
 * Shape of a cached/live task list. Loose types so this works with
 * both raw parsed JSON and strongly-typed enriched responses.
 * Uses `| null` alongside `| undefined` because enriched types
 * (e.g. EnrichedAssignedAction) use null for absent values.
 */
export interface CachedTaskData {
  slack?: Array<{
    type?: string | null;
    dismissalId?: string | null;
    permalink?: string | null;
  }>;
  docs?: Array<{
    fileLink?: string | null;
    fileTitle?: string | null;
  }>;
  meetingNotes?: Array<{
    documentId?: string | null;
    actionItem?: string | null;
  }>;
}

/**
 * Filter completed/dismissed items from cached task data.
 * Checks all dismissable sources (slack, docs, meeting-notes) against the
 * completion store. Mutates the data object in place for efficiency.
 *
 * Uses a single file read via `getCompletedBySources` to load all
 * dismissable source completions at once.
 */
export async function filterCompletedTasks(data: CachedTaskData): Promise<void> {
  const completed = await getCompletedBySources(["slack", "docs", "meeting-note"] as const);
  const slackCompleted = completed.get("slack")!;
  const docsCompleted = completed.get("docs")!;
  const meetingNoteCompleted = completed.get("meeting-note")!;

  // Filter Slack: remove non-saved messages that have been dismissed
  if (Array.isArray(data.slack)) {
    data.slack = data.slack.filter((msg) => {
      if (msg.type === "saved") return true;
      // Check stable dismissalId first, then legacy permalink
      if (msg.dismissalId && slackCompleted.has(msg.dismissalId)) return false;
      if (msg.permalink && slackCompleted.has(msg.permalink)) return false;
      return true;
    });
  }

  // Filter Docs: remove completed assigned actions
  if (Array.isArray(data.docs)) {
    data.docs = data.docs.filter((action) => {
      const id = action.fileLink || action.fileTitle || "";
      return !id || !docsCompleted.has(id);
    });
  }

  // Filter Meeting Notes: check both doc-level and action-level dismissal
  if (Array.isArray(data.meetingNotes)) {
    data.meetingNotes = data.meetingNotes.filter((note) => {
      if (!note.documentId) return true;
      // Doc-level dismissal
      if (meetingNoteCompleted.has(note.documentId)) return false;
      // Action-level dismissal (documentId:hash)
      if (note.actionItem) {
        const hash = hashActionText(note.actionItem);
        if (meetingNoteCompleted.has(`${note.documentId}:${hash}`)) return false;
      }
      return true;
    });
  }
}
