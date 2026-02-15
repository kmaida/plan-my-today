/**
 * Type definitions for the today-todos tool
 */

import type { PriorityMetadata } from "./priority-utils";

/**
 * Dependency metadata for tasks (what blocks/is blocked by this item)
 */
export interface DependencyMetadata {
  blockedBy: string[]; // Issue IDs that block this item (e.g., ["ABC-123", "PROJ-456"])
  blocks: string[]; // Issue IDs that this item blocks (computed from reverse lookup)
  waitingOn: string[]; // People we're waiting on (e.g., ["user@email.com"])
  blockedByExternal: boolean; // True if blocked by person/external factor (not another issue)
}

/**
 * A related Linear issue reference from the API
 */
export interface LinearRelatedIssueRef {
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: string } | null;
}

/**
 * Linear relation types as returned by the API.
 * "blocks" = this issue blocks the related issue (directional)
 * "duplicate" = this issue is a duplicate of the related issue
 * "related" = general relationship
 */
export type LinearRelationType = "blocks" | "duplicate" | "related";

/**
 * A single Linear issue relation
 */
export interface LinearRelation {
  type: LinearRelationType;
  relatedIssue: LinearRelatedIssueRef;
}

/**
 * Aggregated relation metadata for a Linear issue.
 * Built from the GraphQL parent/children/relations fields at fetch time.
 */
export interface LinearRelationMetadata {
  parent: LinearRelatedIssueRef | null;
  children: LinearRelatedIssueRef[];
  relations: LinearRelation[];
}

/**
 * Cross-reference metadata (same item mentioned across multiple sources)
 */
export interface CrossReferenceMetadata {
  mentionedIn: string[]; // Sources where this item is mentioned (e.g., ["linear", "email", "slack"])
  relatedItems: Array<{
    source: string; // Source type ("gmail" | "slack" | "meeting-notes")
    id: string; // Item ID from that source
    snippet: string; // Brief context where mentioned (truncated to 100 chars)
    url?: string; // Direct link to the referenced item
  }>;
  totalMentions: number; // Total count of references (including origin)
}

/**
 * Meeting context metadata (cross-references for calendar events)
 */
export interface MeetingContextMetadata {
  relatedIssues: Array<{
    identifier: string; // Linear issue identifier
    title: string; // Issue title
    reason: string; // Match reason ("keyword_match" | "project_match" | "attendee_match")
  }>;
  relatedPRs: Array<{
    number: number; // PR number
    repo: string; // Repository name
    title: string; // PR title
    reason: string; // Match reason
  }>;
  relatedGitHubIssues: Array<{
    number: number; // Issue number
    repo: string; // Repository name
    title: string; // Issue title
    reason: string; // Match reason
  }>;
  relatedEmails: Array<{
    id: string; // Gmail message ID
    subject: string; // Email subject
    from: string; // Sender email
    reason: string; // Relation reason ("attendee_needs_action" | "topic_match")
  }>;
  attendeeContext: Array<{
    email: string; // Attendee email
    pendingItems: number; // Count of items involving this person
  }>;
  hasSummary: boolean; // True if matching meeting summary/recording exists
  summaryLink?: string; // Link to meeting summary/recording (if available)
}

/**
 * Calendar event with full details
 */
export interface CalendarEventDetail {
  id?: string; // Google Calendar event ID
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  eventType?: string; // Google Calendar API: "default" | "focusTime" | "outOfOffice" | "workingLocation" | "birthday" | "fromGmail"
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string;
      uri?: string;
    }>;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    self?: boolean;
  }>;
  priorityMetadata?: PriorityMetadata;
  meetingContextMetadata?: MeetingContextMetadata;
}

/**
 * Linear issue with full details
 */
export interface LinearIssueDetail {
  identifier: string;
  title: string;
  priority: number;
  priorityLabel: string;
  url: string;
  state: { name: string; type: string } | null;
  dueDate: string | null;
  estimate: number | null;
  project: { name: string } | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  priorityMetadata?: PriorityMetadata;
  dependencyMetadata?: DependencyMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
  relationMetadata?: LinearRelationMetadata;
}

/**
 * Gmail message detail
 */
export interface GmailMessageDetail {
  id: string;
  threadId?: string; // Gmail thread ID — shared by all messages in a conversation
  subject: string;
  from: string;
  link: string;
  snippet?: string; // First ~100 chars of email body (from Gmail API)
  timestamp?: number; // Internal date from Gmail (Unix timestamp in milliseconds)
  isImportant?: boolean; // Whether the email is marked as important
  isStarred?: boolean; // Whether the email is starred
  isFromIndividual?: boolean; // Whether the email is from an individual (not automated)
  needsReply?: boolean; // Whether the email likely needs a reply
  hasActionItems?: boolean; // Whether the email contains action items
  threadMessageCount?: number; // Number of messages collapsed from this thread
  threadParticipants?: string[]; // Deduplicated sender names from all messages in the thread
  priorityMetadata?: PriorityMetadata;
}

/**
 * Meeting summary detail (from Zoom, Google Meet, etc.)
 */
export interface MeetingSummaryDetail {
  platform: "zoom" | "google-meet" | "teams" | "other"; // Meeting platform
  meetingTitle: string | null; // Extracted meeting title
  subject: string; // Original email subject
  timestamp: number; // Unix timestamp in milliseconds
  hasActionItems: boolean; // Whether action items detected in summary
  snippet: string; // Email snippet/preview text
  link: string; // Link to email in Gmail
  recordingLink: string | null; // Link to meeting recording (if available)
  from: string; // Email sender (e.g., no-reply@zoom.us)
  priorityMetadata?: PriorityMetadata;
  relatedMeetingNotes?: Array<{
    documentId: string;
    documentTitle: string;
    documentLink: string;
  }>;
  relatedCalendarEvent?: {
    summary: string;
    htmlLink?: string;
  };
}

/**
 * Assigned action detail
 */
export interface AssignedActionDetail {
  fileTitle: string;
  fileId?: string; // Google Drive file ID
  actionType: string;
  fileLink: string | null;
  timestamp?: string; // When the comment/assignment was created
  isAssignment?: boolean; // True if assigned, false if just mentioned
  commentCount?: number; // Number of unresolved comments (for comment-email items)
  docsType?: "mention" | "assignment" | "unresolved-comment"; // Discriminator for UI warnings
  priorityMetadata?: PriorityMetadata;
}

/**
 * GitHub PR detail
 */
export interface GitHubPRDetail {
  id: number;
  number: number;
  title: string;
  url: string;
  repo: string;
  type: "assigned" | "review";
  updatedAt: string;
  isDraft: boolean;
  priorityMetadata?: PriorityMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}

/**
 * GitHub Issue detail
 */
export interface GitHubIssueDetail {
  id: number;
  number: number;
  title: string;
  url: string;
  repo: string;
  updatedAt: string;
  labels?: string[];
  priorityMetadata?: PriorityMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}

/**
 * Slack message detail
 */
export interface SlackMessageDetail {
  text: string;
  title?: string; // Short summary extracted from message text for UI display
  timestamp: string; // Message timestamp
  channel: string; // Channel ID
  channelName?: string; // Human-readable channel name
  user: string; // User who posted
  userName?: string; // Human-readable user name
  permalink?: string; // Slack permalink to message
  dismissalId?: string; // Stable completion identifier: "{channelId}:{ts}"
  threadTs?: string; // Thread identifier
  type: "mention" | "thread" | "dm" | "saved"; // Message type
  replyCount?: number; // For threads
  priorityMetadata?: PriorityMetadata;
}

/**
 * Meeting note action item detail (from Granola notes synced to Google Drive)
 */
export interface MeetingNoteActionDetail {
  documentId: string; // Google Drive file ID
  documentTitle: string; // Document name
  documentLink: string; // Link to Google Doc
  actionItem: string; // The extracted action item text
  assignee?: string; // @mention or "assigned to" target
  isUrgent: boolean; // Contains urgent/asap/today markers
  timestamp: number; // Document modified time (Unix timestamp in ms)
  meetingDate?: Date; // Parsed meeting date from filename
  priorityMetadata?: PriorityMetadata;
}

// ── Enriched types (after taskId + priority assignment in list-all-tasks-today) ──

/** Fields added to every item during enrichment */
export type Enriched<T> = T & {
  taskId: string;
  stableId: string;
  priorityMetadata: PriorityMetadata;
};

export type EnrichedCalendarEvent = Enriched<CalendarEventDetail>;
export type EnrichedLinearIssue = Enriched<LinearIssueDetail>;
export type EnrichedGmailMessage = Enriched<GmailMessageDetail>;
export type EnrichedMeetingSummary = Enriched<MeetingSummaryDetail>;
export type EnrichedAssignedAction = Enriched<AssignedActionDetail>;
export type EnrichedGitHubPR = Enriched<GitHubPRDetail>;
export type EnrichedGitHubIssue = Enriched<GitHubIssueDetail>;
export type EnrichedSlackMessage = Enriched<SlackMessageDetail>;
export type EnrichedMeetingNote = Enriched<MeetingNoteActionDetail>;

/** Full response shape from list-all-tasks-today */
export interface ListAllTasksResponse {
  calendar: EnrichedCalendarEvent[];
  linear: EnrichedLinearIssue[];
  gmail: EnrichedGmailMessage[];
  meetingSummaries: EnrichedMeetingSummary[];
  docs: EnrichedAssignedAction[];
  github: { prs: EnrichedGitHubPR[]; issues: EnrichedGitHubIssue[] };
  slack: EnrichedSlackMessage[];
  meetingNotes: EnrichedMeetingNote[];
  metadata: { fetched_at: string; date: string; errors?: string[] };
}

/**
 * Lookahead item with text and optional link
 */
export interface LookaheadItem {
  text: string;
  link?: string;
  linkText?: string; // Custom text for the link (e.g., issue ID or email subject)
}

/**
 * Timeline item for unified calendar view
 */
export interface TimelineItem {
  start: Date;
  end: Date;
  type: "meeting" | "focus" | "work" | "email" | "action" | "slack";
  title: string;
  description?: string;
  durationMinutes?: number;
  links: {
    calendar?: string;
    zoom?: string;
    linear?: string;
    gmail?: string;
    docs?: string;
    github?: string;
    slack?: string;
  };
}

/**
 * Categorized Linear issues by urgency
 */
export interface CategorizedIssues {
  overdue: LinearIssueDetail[];
  dueToday: LinearIssueDetail[];
  dueThisWeek: LinearIssueDetail[];
  noDueDate: LinearIssueDetail[];
  highPriority: LinearIssueDetail[];
}
