// TypeScript interfaces for Todo MCP Server data model

// ===== Task Sources =====

export type TaskSource =
  | "linear"
  | "gmail"
  | "github"
  | "slack"
  | "calendar"
  | "docs"
  | "meeting-notes"
  | "github-issue";

// ===== Priority Metadata =====

export type PriorityCategory = "critical" | "high" | "medium" | "low";

export interface PriorityMetadata {
  score: number; // 0-300 scale
  category: PriorityCategory;
  signals: string[]; // Factors affecting priority
  reasons: string; // Human-readable explanation
}

// ===== Dependency Metadata (for Linear) =====

export interface DependencyMetadata {
  blockedBy?: string[]; // Issue IDs that block this item
  blocks?: string[]; // Reverse lookup - what this item blocks
  waitingOn?: string[]; // People we're waiting on
  blockedByExternal?: boolean; // Boolean for external/person blocking
}

// ===== Cross-Reference Metadata =====

export interface RelatedItem {
  source: TaskSource;
  id: string;
  snippet?: string;
  url?: string;
}

export interface CrossReferenceMetadata {
  mentionedIn?: TaskSource[]; // Sources where mentioned
  relatedItems?: RelatedItem[]; // Array of related items
  totalMentions?: number; // Count of total references
}

// ===== Meeting Context Metadata =====

export interface AttendeeContext {
  email: string;
  pendingItemsCount: number;
}

export interface MeetingContextMetadata {
  relatedIssues?: Array<{ identifier: string; title: string }>;
  relatedPRs?: Array<{ number: number; title: string; repo: string }>;
  relatedEmails?: Array<{ subject: string; from: string }>;
  attendeeContext?: AttendeeContext[];
  hasSummary?: boolean;
}

// ===== Task Type Definitions =====

export interface LinearTask {
  source: "linear";
  taskId: string;
  identifier: string; // e.g., "KIM-123"
  title: string;
  priority?: number; // Linear's own priority value
  url: string;
  state?: string;
  dueDate?: string;
  estimate?: number;
  project?: string;
  completedAt?: string;

  // Enrichment
  priorityMetadata: PriorityMetadata;
  dependencies?: DependencyMetadata;
  crossReferences?: CrossReferenceMetadata;
}

export interface GmailTask {
  source: "gmail";
  taskId: string;
  id: string;
  subject: string;
  from: string;
  link: string;
  timestamp: string;
  isImportant?: boolean;
  isStarred?: boolean;
  needsReply?: boolean;

  // Thread collapsing — present when multiple messages share a threadId
  threadMessageCount?: number; // Total messages collapsed into this card
  threadParticipants?: string[]; // Deduplicated sender display names

  // Enrichment
  priorityMetadata: PriorityMetadata;
  crossReferences?: CrossReferenceMetadata;
}

export interface GitHubTask {
  source: "github" | "github-issue";
  taskId: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  type: "assigned" | "review";
  isDraft?: boolean;
  labels?: string[];

  // Enrichment
  priorityMetadata: PriorityMetadata;
  crossReferences?: CrossReferenceMetadata;
}

export interface SlackTask {
  source: "slack";
  taskId: string;
  text: string;
  title?: string;
  timestamp: string;
  channel: string;
  user: string;
  type: "mention" | "thread" | "dm" | "saved";
  link?: string;
  dismissalId?: string; // Stable completion identifier: "{channelId}:{ts}"

  // Enrichment
  priorityMetadata: PriorityMetadata;
  crossReferences?: CrossReferenceMetadata;
}

export interface CalendarTask {
  source: "calendar";
  taskId: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  eventType?: string; // Google Calendar: "default" | "focusTime" | "outOfOffice" | "workingLocation" | "birthday" | "fromGmail"
  attendees?: Array<{ email: string; responseStatus?: string }>;
  htmlLink: string;

  // Enrichment
  priorityMetadata: PriorityMetadata;
  meetingContext?: MeetingContextMetadata;
  crossReferences?: CrossReferenceMetadata;
}

export interface DocsActionTask {
  source: "docs";
  taskId: string;
  fileTitle: string;
  actionType: string;
  fileLink: string;
  timestamp: string;

  // Enrichment
  priorityMetadata: PriorityMetadata;
  crossReferences?: CrossReferenceMetadata;
}

export interface MeetingNotesTask {
  source: "meeting-notes";
  taskId: string;
  documentId: string;
  actionItem: string;
  assignee?: string;
  isUrgent?: boolean;
  timestamp: string;
  documentTitle?: string;
  documentLink?: string;

  // Enrichment
  priorityMetadata: PriorityMetadata;
  crossReferences?: CrossReferenceMetadata;
}

// ===== Union Type for All Tasks =====

export type Task =
  | LinearTask
  | GmailTask
  | GitHubTask
  | SlackTask
  | CalendarTask
  | DocsActionTask
  | MeetingNotesTask;

// ===== Server Response Types (from list-all-tasks-today MCP tool) =====

/** Raw server response — data grouped by source */
export interface ServerTasksResponse {
  calendar: ServerCalendarEvent[];
  linear: ServerLinearIssue[];
  gmail: ServerGmailMessage[];
  meetingSummaries: unknown[];
  docs: ServerDocsAction[];
  github: {
    prs: ServerGitHubPR[];
    issues: ServerGitHubIssue[];
  };
  slack: ServerSlackMessage[];
  meetingNotes: ServerMeetingNote[];
  metadata: {
    fetched_at: string;
    date: string;
    errors?: string[];
  };
}

export interface ServerPriorityMetadata {
  score: number;
  category: PriorityCategory;
  signals: Record<string, unknown>;
  reasons: string[];
}

export interface ServerLinearIssue {
  taskId?: string;
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
  priorityMetadata?: ServerPriorityMetadata;
  dependencyMetadata?: DependencyMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}

export interface ServerGmailMessage {
  taskId?: string;
  id: string;
  subject: string;
  from: string;
  link: string;
  timestamp?: number;
  isImportant?: boolean;
  isStarred?: boolean;
  needsReply?: boolean;
  threadMessageCount?: number;
  threadParticipants?: string[];
  priorityMetadata?: ServerPriorityMetadata;
}

export interface ServerGitHubPR {
  taskId?: string;
  id: number;
  number: number;
  title: string;
  url: string;
  repo: string;
  type: "assigned" | "review";
  updatedAt: string;
  isDraft: boolean;
  priorityMetadata?: ServerPriorityMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}

export interface ServerGitHubIssue {
  taskId?: string;
  id: number;
  number: number;
  title: string;
  url: string;
  repo: string;
  updatedAt: string;
  labels?: string[];
  priorityMetadata?: ServerPriorityMetadata;
  crossReferenceMetadata?: CrossReferenceMetadata;
}

export interface ServerSlackMessage {
  taskId?: string;
  text: string;
  title?: string;
  timestamp: string;
  channel: string;
  channelName?: string;
  user: string;
  userName?: string;
  permalink?: string;
  dismissalId?: string; // Stable completion identifier: "{channelId}:{ts}"
  threadTs?: string;
  type: "mention" | "thread" | "dm" | "saved";
  replyCount?: number;
  priorityMetadata?: ServerPriorityMetadata;
}

export interface ServerCalendarEvent {
  taskId?: string;
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  eventType?: string; // Google Calendar: "default" | "focusTime" | "outOfOffice" | "workingLocation" | "birthday" | "fromGmail"
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean }>;
  priorityMetadata?: ServerPriorityMetadata;
  meetingContextMetadata?: MeetingContextMetadata;
}

export interface ServerDocsAction {
  taskId?: string;
  fileTitle: string;
  fileId?: string;
  actionType: string;
  fileLink: string | null;
  timestamp?: string;
  isAssignment?: boolean;
  priorityMetadata?: ServerPriorityMetadata;
}

export interface ServerMeetingNote {
  taskId?: string;
  documentId: string;
  documentTitle: string;
  documentLink: string;
  actionItem: string;
  assignee?: string;
  isUrgent: boolean;
  timestamp: number;
  meetingDate?: string;
  priorityMetadata?: ServerPriorityMetadata;
}

// ===== API Response Types =====

export interface MarkCompleteResponse {
  success: boolean;
  message?: string;
}

// ===== View Modes =====

export type ViewMode = "priority" | "source";

// ===== Filter State =====

export interface FilterState {
  search: string;
  sources: TaskSource[];
  priorities: PriorityCategory[];
  timeFilter: "today" | "week" | "later" | "no-due" | "overdue" | "all";
  showCompleted: boolean;
}

export const DEFAULT_FILTERS: FilterState = {
  search: "",
  sources: [],
  priorities: [],
  timeFilter: "all",
  showCompleted: false,
};

// ===== Grouped Tasks =====

export interface TaskGroup {
  label: string;
  count: number;
  tasks: Task[];
  collapsed?: boolean;
}

// ===== Helper Type Guards =====

export function isLinearTask(task: Task): task is LinearTask {
  return task.source === "linear";
}

export function isGmailTask(task: Task): task is GmailTask {
  return task.source === "gmail";
}

export function isGitHubTask(task: Task): task is GitHubTask {
  return task.source === "github" || task.source === "github-issue";
}

export function isSlackTask(task: Task): task is SlackTask {
  return task.source === "slack";
}

export function isCalendarTask(task: Task): task is CalendarTask {
  return task.source === "calendar";
}

export function isDocsActionTask(task: Task): task is DocsActionTask {
  return task.source === "docs";
}

export function isMeetingNotesTask(task: Task): task is MeetingNotesTask {
  return task.source === "meeting-notes";
}
