/**
 * Type definitions for the today-todos tool
 */

/**
 * Calendar event with full details
 */
export interface CalendarEventDetail {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
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
}

/**
 * Gmail message detail
 */
export interface GmailMessageDetail {
  id: string;
  subject: string;
  from: string;
  link: string;
  timestamp?: number; // Internal date from Gmail (Unix timestamp in milliseconds)
  isImportant?: boolean; // Whether the email is marked as important
  isFromIndividual?: boolean; // Whether the email is from an individual (not automated)
  needsReply?: boolean; // Whether the email likely needs a reply
  hasActionItems?: boolean; // Whether the email contains action items
}

/**
 * Assigned action detail
 */
export interface AssignedActionDetail {
  fileTitle: string;
  actionType: string;
  fileLink: string | null;
  timestamp?: string; // When the comment/assignment was created
  isAssignment?: boolean; // True if assigned, false if just mentioned
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
}

/**
 * Time block for work suggestions
 */
export interface TimeBlock {
  start: Date;
  end: Date;
  durationMinutes: number;
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
  type: "meeting" | "focus" | "work" | "email" | "action";
  title: string;
  description?: string;
  links: {
    calendar?: string;
    zoom?: string;
    linear?: string;
    gmail?: string;
    docs?: string;
    github?: string;
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
