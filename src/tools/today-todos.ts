import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod";
import { stsClient } from "../services/sts-client";

const CALENDAR_RESOURCE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];
const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];
const GITHUB_RESOURCE = "https://api.github.com";
const GITHUB_SCOPES = ["repo", "read:org"];

/**
 * Input schema for the list-today-todos tool
 */
const todayTodosInputSchema = {
  includeCalendar: z.boolean()
    .describe("Include calendar events (default: true)")
    .optional(),
  includeLinear: z.boolean()
    .describe("Include Linear issues (default: true)")
    .optional(),
  includeGmail: z.boolean()
    .describe("Include Gmail todos (default: true)")
    .optional(),
  includeAssignedActions: z.boolean()
    .describe("Include assigned actions from Google Docs (default: true)")
    .optional(),
  includeGithub: z.boolean()
    .describe("Include GitHub PRs and issues (default: true)")
    .optional(),
  showOnlyRemaining: z.boolean()
    .describe("Show only items that haven't passed yet based on current time (default: false). Use this when asking 'what do I have left to do?' or 'what's remaining?'")
    .optional(),
};

/**
 * Calendar event with full details
 */
interface CalendarEventDetail {
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
 * Fetches today's calendar events with full details
 */
async function fetchTodayCalendarEvents(accessToken: string): Promise<CalendarEventDetail[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    new URLSearchParams({
      maxResults: "20",
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
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

  const data = await response.json() as { items?: CalendarEventDetail[] };
  return data.items || [];
}

/**
 * Linear issue with full details
 */
interface LinearIssueDetail {
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
 * Fetches Linear issues assigned to the user (due within 7 days or without due dates)
 */
async function fetchLinearIssues(accessToken: string, dueByDate: Date): Promise<LinearIssueDetail[]> {
  const query = `
    query MyIssues($first: Int, $filter: IssueFilter) {
      viewer {
        assignedIssues(first: $first, filter: $filter) {
          nodes {
            id
            identifier
            title
            priority
            priorityLabel
            url
            state {
              name
              type
            }
            dueDate
            estimate
            project {
              name
            }
          }
        }
      }
    }
  `;

  const filter = {
    state: { type: { nin: ["completed", "canceled"] } }
  };

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query,
      variables: { first: 50, filter }, // Get more to filter by date
    }),
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as {
    data?: {
      viewer?: {
        assignedIssues?: {
          nodes: LinearIssueDetail[];
        };
      };
    };
  };

  const issues = data.data?.viewer?.assignedIssues?.nodes || [];
  
  // Filter for issues due within 7 days, overdue, or without due dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  return issues.filter(issue => {
    if (!issue.dueDate) return true; // Include issues without due dates
    const dueDate = new Date(issue.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    return dueDate <= dueByDate; // Include next 7 days or overdue
  });
}

/**
 * Gmail message detail
 */
interface GmailMessageDetail {
  id: string;
  subject: string;
  from: string;
  link: string;
  timestamp?: number; // Internal date from Gmail (Unix timestamp in milliseconds)
  isImportant?: boolean; // Whether the email is marked as important
}

/**
 * Fetches Gmail todos
 */
async function fetchGmailTodos(accessToken: string): Promise<GmailMessageDetail[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const afterDate = Math.floor(today.getTime() / 1000);
  
  const query = `(is:unread OR is:important) after:${afterDate}`;

  const messagesResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?` +
    new URLSearchParams({
      q: query,
      maxResults: "10",
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!messagesResponse.ok) {
    return [];
  }

  const messagesData = await messagesResponse.json() as { messages?: Array<{ id: string }> };
  if (!messagesData.messages || messagesData.messages.length === 0) {
    return [];
  }

  // Fetch message details
  const messagePromises = messagesData.messages.slice(0, 10).map(msg =>
    fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    ).then(r => r.ok ? r.json() : null)
  );

  const messages = (await Promise.all(messagePromises)).filter(Boolean) as Array<{
    payload?: {
      headers?: Array<{ name?: string; value?: string }>;
    };
    snippet?: string;
    id: string;
    internalDate?: string;
    labelIds?: string[];
  }>;

  return messages.map(message => {
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) => 
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;
    
    return {
      id: message.id,
      subject: getHeader("subject") || "(No subject)",
      from: getHeader("from") || "Unknown",
      link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
      timestamp: message.internalDate ? parseInt(message.internalDate, 10) : undefined,
      isImportant: message.labelIds?.includes("IMPORTANT") ?? false,
    };
  });
}

/**
 * Assigned action detail
 */
interface AssignedActionDetail {
  fileTitle: string;
  actionType: string;
  fileLink: string | null;
  timestamp?: string; // When the comment/assignment was created
  isAssignment?: boolean; // True if assigned, false if just mentioned
}

/**
 * GitHub PR detail
 */
interface GitHubPRDetail {
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
interface GitHubIssueDetail {
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
interface TimeBlock {
  start: Date;
  end: Date;
  durationMinutes: number;
}

/**
 * Analyzes calendar events to find available time blocks
 */
function findAvailableTimeBlocks(
  calendarEvents: CalendarEventDetail[],
  workStartHour: number = 9,
  workEndHour: number = 17
): TimeBlock[] {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), workStartHour, 0);
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), workEndHour, 0);

  // Sort events by start time
  const sortedEvents = calendarEvents
    .filter(e => e.start?.dateTime && e.end?.dateTime) // Only timed events with both start and end
    .map(e => ({
      start: new Date(e.start!.dateTime!),
      end: new Date(e.end!.dateTime!),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const blocks: TimeBlock[] = [];
  let currentTime = startOfDay;

  for (const event of sortedEvents) {
    // If there's a gap before this event
    if (currentTime < event.start) {
      const durationMinutes = Math.floor((event.start.getTime() - currentTime.getTime()) / (1000 * 60));
      if (durationMinutes >= 15) { // Only suggest blocks of 15+ minutes
        blocks.push({
          start: new Date(currentTime),
          end: new Date(event.start),
          durationMinutes,
        });
      }
    }
    // Move current time to end of this event
    currentTime = event.end > currentTime ? event.end : currentTime;
  }

  // Check for time after last event
  if (currentTime < endOfDay) {
    const durationMinutes = Math.floor((endOfDay.getTime() - currentTime.getTime()) / (1000 * 60));
    if (durationMinutes >= 15) {
      blocks.push({
        start: new Date(currentTime),
        end: new Date(endOfDay),
        durationMinutes,
      });
    }
  }

  return blocks;
}

/**
 * Categorizes Linear issues by urgency and priority
 */
function categorizeIssues(issues: LinearIssueDetail[], today: Date) {
  const overdue: LinearIssueDetail[] = [];
  const dueToday: LinearIssueDetail[] = [];
  const dueThisWeek: LinearIssueDetail[] = [];
  const noDueDate: LinearIssueDetail[] = [];
  const highPriority: LinearIssueDetail[] = [];

  for (const issue of issues) {
    if (issue.dueDate) {
      const due = new Date(issue.dueDate);
      due.setHours(0, 0, 0, 0);
      const daysUntilDue = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      
      if (daysUntilDue < 0) {
        overdue.push(issue);
      } else if (daysUntilDue === 0) {
        dueToday.push(issue);
      } else if (daysUntilDue <= 7) {
        dueThisWeek.push(issue);
      }
    } else {
      noDueDate.push(issue);
    }

    // High priority (Urgent or High)
    if (issue.priority <= 2) {
      highPriority.push(issue);
    }
  }

  return { overdue, dueToday, dueThisWeek, noDueDate, highPriority };
}

/**
 * Detects themes/focus areas from meetings and tasks
 * Merges similar themes to avoid duplication
 */
function detectThemes(
  calendarEvents: CalendarEventDetail[],
  linearIssues: LinearIssueDetail[]
): { theme: string; items: string[]; isMainFocus: boolean }[] {
  const themes: Map<string, Set<string>> = new Map();
  
  // Common keywords to look for (lowercase)
  const keywordPatterns = [
    { pattern: /messaging\s*framework/i, theme: "Messaging Framework" },
    { pattern: /marketing/i, theme: "Marketing" },
    { pattern: /sso|auth|oauth|identity/i, theme: "SSO/Identity" },
    { pattern: /onboarding/i, theme: "Onboarding" },
    { pattern: /workshop/i, theme: "Workshop" },
    { pattern: /sync|standup|stand-up|1:1|1-1/i, theme: "Syncs & 1:1s" },
    { pattern: /docs|documentation/i, theme: "Documentation" },
    { pattern: /rsa|conference|booth/i, theme: "RSA Conference" },
  ];
  
  // Helper to check if text matches any keyword pattern
  const matchesKeywordPattern = (text: string): boolean => {
    return keywordPatterns.some(({ pattern }) => pattern.test(text));
  };
  
  // Scan calendar events
  for (const event of calendarEvents) {
    const title = event.summary || "";
    for (const { pattern, theme } of keywordPatterns) {
      if (pattern.test(title)) {
        if (!themes.has(theme)) themes.set(theme, new Set());
        themes.get(theme)!.add(`📅 ${title}`);
      }
    }
  }
  
  // Scan Linear issues
  for (const issue of linearIssues) {
    const text = `${issue.title} ${issue.project?.name || ""}`;
    let matchedKeyword = false;
    
    for (const { pattern, theme } of keywordPatterns) {
      if (pattern.test(text)) {
        if (!themes.has(theme)) themes.set(theme, new Set());
        themes.get(theme)!.add(`📋 ${issue.identifier}: ${issue.title}`);
        matchedKeyword = true;
      }
    }
    
    // Only add project theme if it doesn't overlap with keyword patterns
    // This prevents "Messaging Framework v0.1" duplicating "Messaging Framework"
    if (issue.project?.name && !matchesKeywordPattern(issue.project.name)) {
      const projectTheme = issue.project.name;
      if (!themes.has(projectTheme)) themes.set(projectTheme, new Set());
      themes.get(projectTheme)!.add(`📋 ${issue.identifier}: ${issue.title}`);
    }
  }
  
  // Convert to array and sort by item count
  const themeArray = Array.from(themes.entries())
    .map(([theme, items]) => ({
      theme,
      items: Array.from(items),
      isMainFocus: items.size >= 2, // 2+ items = significant theme
    }))
    .sort((a, b) => b.items.length - a.items.length);
  
  return themeArray;
}

/**
 * Generates productivity insights based on schedule patterns
 */
function generateProductivityInsights(
  calendarEvents: CalendarEventDetail[],
  timeBlocks: TimeBlock[],
  linearIssues: LinearIssueDetail[],
  categorizedIssues: ReturnType<typeof categorizeIssues>
): string[] {
  const insights: string[] = [];
  const now = new Date();
  const currentHour = now.getHours();
  
  // Filter to timed events only
  const timedEvents = calendarEvents.filter(e => e.start?.dateTime);
  
  // Analyze meeting density by time of day
  const morningMeetings = timedEvents.filter(e => {
    const hour = new Date(e.start!.dateTime!).getHours();
    return hour >= 9 && hour < 12;
  });
  const afternoonMeetings = timedEvents.filter(e => {
    const hour = new Date(e.start!.dateTime!).getHours();
    return hour >= 12 && hour < 17;
  });
  
  // Meeting density insight
  if (morningMeetings.length >= 3 && afternoonMeetings.length < morningMeetings.length) {
    insights.push("🌅 Morning is meeting-heavy. Save deep work for afternoon when you have more focus time.");
  } else if (afternoonMeetings.length >= 3 && morningMeetings.length < afternoonMeetings.length) {
    insights.push("☀️ Afternoon is packed with meetings. Tackle important tasks this morning while you have focus time.");
  }
  
  // Find longest block and suggest using it for complex work
  if (timeBlocks.length > 0) {
    const longestBlock = timeBlocks.reduce((a, b) => a.durationMinutes > b.durationMinutes ? a : b);
    if (longestBlock.durationMinutes >= 60) {
      const blockTime = longestBlock.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      insights.push(`🎯 Your longest focus block is ${longestBlock.durationMinutes} min at ${blockTime}. Use it for your most complex task.`);
    }
  }
  
  // Back-to-back meeting warning
  for (let i = 0; i < timedEvents.length - 1; i++) {
    const current = timedEvents[i];
    const next = timedEvents[i + 1];
    if (current.end?.dateTime && next.start?.dateTime) {
      const gap = (new Date(next.start.dateTime).getTime() - new Date(current.end.dateTime).getTime()) / (1000 * 60);
      if (gap <= 5 && gap >= 0) {
        // Count consecutive back-to-backs
        let backToBackCount = 2;
        for (let j = i + 1; j < timedEvents.length - 1; j++) {
          const curr = timedEvents[j];
          const nxt = timedEvents[j + 1];
          if (curr.end?.dateTime && nxt.start?.dateTime) {
            const g = (new Date(nxt.start.dateTime).getTime() - new Date(curr.end.dateTime).getTime()) / (1000 * 60);
            if (g <= 5 && g >= 0) backToBackCount++;
            else break;
          }
        }
        if (backToBackCount >= 2) {
          const startTime = new Date(current.start!.dateTime!).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          insights.push(`⚠️ You have ${backToBackCount} back-to-back meetings starting at ${startTime}. Consider prepping materials before.`);
          break; // Only show one back-to-back warning
        }
      }
    }
  }
  
  // Overdue/urgent warning
  if (categorizedIssues.overdue.length > 0) {
    insights.push(`🚨 You have ${categorizedIssues.overdue.length} overdue issue(s). Prioritize these first.`);
  } else if (categorizedIssues.dueToday.length > 0) {
    insights.push(`⏰ You have ${categorizedIssues.dueToday.length} issue(s) due today. Make sure to allocate time.`);
  }
  
  // Total work time vs tasks
  const totalWorkMinutes = timeBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);
  const estimatedPoints = linearIssues.reduce((sum, i) => sum + (i.estimate || 1), 0);
  if (totalWorkMinutes < 60 && linearIssues.length > 0) {
    insights.push(`📊 Limited focus time today (${totalWorkMinutes} min). Consider moving non-urgent tasks to tomorrow.`);
  }
  
  return insights;
}

/**
 * Lookahead item with text and optional link
 */
interface LookaheadItem {
  text: string;
  link?: string;
  linkText?: string; // Custom text for the link (e.g., issue ID or email subject)
}

/**
 * Generates lookahead items for upcoming prep
 */
function generateLookahead(
  calendarEvents: CalendarEventDetail[],
  gmailTodos: GmailMessageDetail[],
  linearIssues: LinearIssueDetail[]
): LookaheadItem[] {
  const lookahead: LookaheadItem[] = [];
  const addedIssueIds = new Set<string>();
  
  // Check emails for future meeting mentions
  for (const email of gmailTodos) {
    const subject = email.subject.toLowerCase();
    // Look for meeting invites or scheduling emails
    if (subject.includes("accepted:") || subject.includes("invitation:") || subject.includes("meet")) {
      // Extract any date/time hints
      const futureMatch = email.subject.match(/\b(mon|tue|wed|thu|fri|sat|sun|tomorrow|next week)\b/i);
      if (futureMatch) {
        // Clean up subject for display
        const cleanSubject = email.subject.substring(0, 50).replace(/^(Accepted:|Invitation:)\s*/i, "");
        lookahead.push({
          text: `📧 Prep for upcoming:`,
          link: email.link,
          linkText: cleanSubject + (email.subject.length > 50 ? "..." : ""),
        });
      }
    }
  }
  
  // Check for related prep between meetings and issues
  for (const event of calendarEvents) {
    const title = (event.summary || "").toLowerCase();
    // Find Linear issues that might relate to this meeting
    for (const issue of linearIssues) {
      if (addedIssueIds.has(issue.identifier)) continue;
      const issueText = `${issue.title} ${issue.project?.name || ""}`.toLowerCase();
      // Simple keyword matching
      const eventWords = title.split(/\s+/).filter(w => w.length > 3);
      const hasOverlap = eventWords.some(word => issueText.includes(word));
      if (hasOverlap) {
        lookahead.push({
          text: `💡 "${event.summary}" relates to`,
          link: issue.url,
          linkText: issue.identifier,
        });
        addedIssueIds.add(issue.identifier);
      }
    }
  }
  
  // Upcoming deadlines
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const issue of linearIssues) {
    if (addedIssueIds.has(issue.identifier)) continue;
    if (issue.dueDate) {
      const due = new Date(issue.dueDate);
      const daysUntil = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysUntil > 0 && daysUntil <= 3) {
        const dayLabel = daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
        lookahead.push({
          text: `📅 Due ${dayLabel}:`,
          linkText: issue.identifier,
          link: issue.url,
        });
        addedIssueIds.add(issue.identifier);
      }
    }
  }
  
  return lookahead.slice(0, 4); // Limit to 4 items
}

/**
 * Timeline item for unified calendar view
 */
interface TimelineItem {
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
  };
}

/**
 * Calculates a priority score for quick action items (emails, doc comments)
 * Higher score = higher priority
 */
function calculateQuickActionPriority(
  item: { type: "email" | "doc"; timestamp?: string | number; isAssignment?: boolean; isImportant?: boolean },
  now: Date
): number {
  let score = 0;
  
  // Base priority by type
  if (item.type === "doc") {
    // Assignments are more urgent than mentions
    if (item.isAssignment) {
      score += 100; // High priority for assignments
    } else {
      score += 50; // Medium priority for mentions
    }
  } else if (item.type === "email") {
    score += 30; // Base priority for emails
    if (item.isImportant) {
      score += 20; // Boost for important emails
    }
  }
  
  // Recency boost: more recent = higher priority
  let itemDate: Date | null = null;
  if (item.timestamp) {
    if (typeof item.timestamp === "string") {
      itemDate = new Date(item.timestamp);
    } else {
      itemDate = new Date(item.timestamp);
    }
  }
  
  if (itemDate) {
    const hoursAgo = (now.getTime() - itemDate.getTime()) / (1000 * 60 * 60);
    // Items from last hour get big boost
    if (hoursAgo < 1) {
      score += 50;
    } else if (hoursAgo < 4) {
      score += 30;
    } else if (hoursAgo < 24) {
      score += 10;
    }
    // Items older than 24 hours get no recency boost
  }
  
  return score;
}

/**
 * Suggests work for a time block based on duration and priority
 * Optimizes for productivity by matching task complexity to available time
 */
function suggestWorkForBlock(
  block: TimeBlock,
  categorizedIssues: ReturnType<typeof categorizeIssues>,
  linearIssues: LinearIssueDetail[],
  gmailTodos: GmailMessageDetail[],
  assignedActions: AssignedActionDetail[],
  usedIssueIds: Set<string> = new Set()
): { title: string; description?: string; links: TimelineItem["links"]; issueId?: string } | null {
  const { overdue, dueToday, highPriority, dueThisWeek, noDueDate } = categorizedIssues;
  const priorityEmojis: Record<number, string> = { 0: "⚪", 1: "🔴", 2: "🟠", 3: "🟡", 4: "🟢" };
  
  // Helper to find an unused issue from a list
  const findUnusedIssue = (issues: LinearIssueDetail[]): LinearIssueDetail | null => {
    return issues.find(i => !usedIssueIds.has(i.identifier)) || null;
  };
  
  // SHORT BLOCKS (< 30 min): Quick wins - prioritize by urgency and recency
  if (block.durationMinutes < 30) {
    const now = new Date();
    const quickActions: Array<{
      type: "email" | "doc";
      priority: number;
      data: GmailMessageDetail | AssignedActionDetail;
    }> = [];
    
    // Add doc actions with priority scores
    for (const action of assignedActions) {
      quickActions.push({
        type: "doc",
        priority: calculateQuickActionPriority(
          { type: "doc", timestamp: action.timestamp, isAssignment: action.isAssignment },
          now
        ),
        data: action,
      });
    }
    
    // Add emails with priority scores
    for (const email of gmailTodos) {
      quickActions.push({
        type: "email",
        priority: calculateQuickActionPriority(
          { type: "email", timestamp: email.timestamp, isImportant: email.isImportant },
          now
        ),
        data: email,
      });
    }
    
    // Sort by priority (highest first) and take the top item
    if (quickActions.length > 0) {
      quickActions.sort((a, b) => b.priority - a.priority);
      const topAction = quickActions[0];
      
      if (topAction.type === "doc") {
        const action = topAction.data as AssignedActionDetail;
        return {
          title: "📄 Quick: Doc review",
          description: `${action.fileTitle} (${action.actionType})`,
          links: action.fileLink ? { docs: action.fileLink } : {},
        };
      } else {
        const email = topAction.data as GmailMessageDetail;
        return {
          title: "📧 Quick: Email triage",
          description: email.subject,
          links: { gmail: email.link },
        };
      }
    }
    // Small Linear issues (low estimate)
    const smallIssue = linearIssues.find(i => !usedIssueIds.has(i.identifier) && (i.estimate === null || i.estimate <= 1));
    if (smallIssue) {
      return {
        title: `${smallIssue.identifier} - ${smallIssue.title} (${priorityEmojis[smallIssue.priority] || "⚪"} ${smallIssue.priorityLabel})`,
        description: undefined,
        links: { linear: smallIssue.url },
        issueId: smallIssue.identifier,
      };
    }
  }
  
  // MEDIUM BLOCKS (30-60 min): Focused work on urgent/important items
  if (block.durationMinutes >= 30 && block.durationMinutes < 60) {
    // Overdue first - always urgent
    const overdueIssue = findUnusedIssue(overdue);
    if (overdueIssue) {
      return {
        title: `🚨 OVERDUE: ${overdueIssue.identifier} - ${overdueIssue.title}`,
        description: undefined,
        links: { linear: overdueIssue.url },
        issueId: overdueIssue.identifier,
      };
    }
    // Due today
    const dueTodayIssue = findUnusedIssue(dueToday);
    if (dueTodayIssue) {
      return {
        title: `${dueTodayIssue.identifier} - ${dueTodayIssue.title} (⏰ Due Today)`,
        description: undefined,
        links: { linear: dueTodayIssue.url },
        issueId: dueTodayIssue.identifier,
      };
    }
    // High priority with medium estimate
    const mediumHighPriority = highPriority.find(i => !usedIssueIds.has(i.identifier) && (i.estimate === null || i.estimate <= 3));
    if (mediumHighPriority) {
      return {
        title: `${mediumHighPriority.identifier} - ${mediumHighPriority.title} (${priorityEmojis[mediumHighPriority.priority] || "⚪"} ${mediumHighPriority.priorityLabel})`,
        description: undefined,
        links: { linear: mediumHighPriority.url },
        issueId: mediumHighPriority.identifier,
      };
    }
  }
  
  // LONG BLOCKS (60+ min): Deep work on complex/high-priority items
  if (block.durationMinutes >= 60) {
    // Overdue first - always urgent
    const overdueIssue = findUnusedIssue(overdue);
    if (overdueIssue) {
      return {
        title: `🚨 OVERDUE: ${overdueIssue.identifier} - ${overdueIssue.title}`,
        description: undefined,
        links: { linear: overdueIssue.url },
        issueId: overdueIssue.identifier,
      };
    }
    // Due today
    const dueTodayIssue = findUnusedIssue(dueToday);
    if (dueTodayIssue) {
      return {
        title: `${dueTodayIssue.identifier} - ${dueTodayIssue.title} (⏰ Due Today)`,
        description: undefined,
        links: { linear: dueTodayIssue.url },
        issueId: dueTodayIssue.identifier,
      };
    }
    // High priority - perfect for deep work
    const highPriorityIssue = findUnusedIssue(highPriority);
    if (highPriorityIssue) {
      return {
        title: `${highPriorityIssue.identifier} - ${highPriorityIssue.title} (${priorityEmojis[highPriorityIssue.priority] || "⚪"} ${highPriorityIssue.priorityLabel})`,
        description: undefined,
        links: { linear: highPriorityIssue.url },
        issueId: highPriorityIssue.identifier,
      };
    }
    // Large issues (high estimate) - need long blocks
    const largeIssue = linearIssues.find(i => !usedIssueIds.has(i.identifier) && i.estimate !== null && i.estimate >= 3);
    if (largeIssue) {
      return {
        title: `${largeIssue.identifier} - ${largeIssue.title} (${largeIssue.estimate} pts)`,
        description: undefined,
        links: { linear: largeIssue.url },
        issueId: largeIssue.identifier,
      };
    }
  }
  
  // FALLBACK: Any available prioritized work
  const fallbackOrder = [...overdue, ...dueToday, ...highPriority, ...dueThisWeek, ...noDueDate];
  const fallbackIssue = fallbackOrder.find(i => !usedIssueIds.has(i.identifier));
  if (fallbackIssue) {
    return {
      title: `${fallbackIssue.identifier} - ${fallbackIssue.title} (${priorityEmojis[fallbackIssue.priority] || "⚪"} ${fallbackIssue.priorityLabel})`,
      description: undefined,
      links: { linear: fallbackIssue.url },
      issueId: fallbackIssue.identifier,
    };
  }
  
  // Check remaining emails/docs - prioritize by urgency
  const now = new Date();
  const fallbackActions: Array<{
    type: "email" | "doc";
    priority: number;
    data: GmailMessageDetail | AssignedActionDetail;
  }> = [];
  
  for (const action of assignedActions) {
    fallbackActions.push({
      type: "doc",
      priority: calculateQuickActionPriority(
        { type: "doc", timestamp: action.timestamp, isAssignment: action.isAssignment },
        now
      ),
      data: action,
    });
  }
  
  for (const email of gmailTodos) {
    fallbackActions.push({
      type: "email",
      priority: calculateQuickActionPriority(
        { type: "email", timestamp: email.timestamp, isImportant: email.isImportant },
        now
      ),
      data: email,
    });
  }
  
  if (fallbackActions.length > 0) {
    fallbackActions.sort((a, b) => b.priority - a.priority);
    const topAction = fallbackActions[0];
    
    if (topAction.type === "doc") {
      const action = topAction.data as AssignedActionDetail;
      return {
        title: "📄 Doc action",
        description: `${action.fileTitle} (${action.actionType})`,
        links: action.fileLink ? { docs: action.fileLink } : {},
      };
    } else {
      const email = topAction.data as GmailMessageDetail;
      return {
        title: "📧 Email review",
        description: email.subject,
        links: { gmail: email.link },
      };
    }
  }
  
  return null;
}

/**
 * Formats a time range for display
 */
function formatTimeRange(start: Date, end: Date, isAllDay: boolean): string {
  if (isAllDay) {
    return "All day";
  }
  const startTime = start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const endTime = end.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${startTime} - ${endTime}`;
}

/**
 * Creates unified timeline from calendar events and work blocks
 */
function createUnifiedTimeline(
  calendarEvents: CalendarEventDetail[],
  timeBlocks: TimeBlock[],
  categorizedIssues: ReturnType<typeof categorizeIssues>,
  linearIssues: LinearIssueDetail[],
  gmailTodos: GmailMessageDetail[],
  assignedActions: AssignedActionDetail[]
): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  const usedIssueIds = new Set<string>(); // Track issues already assigned to blocks
  
  // Add calendar events
  for (const event of calendarEvents) {
    const startRaw = event.start?.dateTime || event.start?.date;
    if (!startRaw) continue;
    
    const start = new Date(startRaw);
    // For all-day events, set end to end of day
    const isAllDay = !event.start?.dateTime;
    let end: Date;
    if (isAllDay) {
      end = new Date(start);
      end.setHours(23, 59, 59);
    } else {
      end = event.end?.dateTime ? new Date(event.end.dateTime) : start;
    }
    const title = event.summary || "Untitled";
    
    // Get meeting link
    let meetingLink = "";
    if (event.conferenceData?.entryPoints) {
      const videoEntry = event.conferenceData.entryPoints.find(
        ep => ep.entryPointType === "video"
      );
      if (videoEntry?.uri) {
        meetingLink = videoEntry.uri;
      }
    } else if (event.hangoutLink) {
      meetingLink = event.hangoutLink;
    }
    
    // Check if this is a solo focus block (no attendees or only self)
    const attendees = event.attendees || [];
    const otherAttendees = attendees.filter(a => !a.self);
    const isSoloFocusBlock = otherAttendees.length === 0 && !meetingLink;
    
    timeline.push({
      start,
      end,
      type: isSoloFocusBlock ? "focus" : "meeting",
      title: isAllDay ? `${title} (All day)` : title,
      description: event.location || undefined,
      links: {
        calendar: event.htmlLink,
        zoom: meetingLink || undefined,
      },
    });
  }
  
  // Sort time blocks by duration (longest first) for optimal task assignment
  const sortedBlocks = [...timeBlocks].sort((a, b) => b.durationMinutes - a.durationMinutes);
  
  // Assign work to blocks (longest blocks get priority for deep work)
  const blockSuggestions = new Map<TimeBlock, ReturnType<typeof suggestWorkForBlock>>();
  for (const block of sortedBlocks) {
    const suggestion = suggestWorkForBlock(block, categorizedIssues, linearIssues, gmailTodos, assignedActions, usedIssueIds);
    if (suggestion?.issueId) {
      usedIssueIds.add(suggestion.issueId);
    }
    blockSuggestions.set(block, suggestion);
  }
  
  // Add work blocks with suggestions (only if there are calendar events to create gaps)
  if (calendarEvents.length > 0) {
    for (const block of timeBlocks) {
      const suggestion = blockSuggestions.get(block);
      
      if (suggestion) {
        timeline.push({
          start: block.start,
          end: block.end,
          type: "work",
          title: suggestion.title,
          description: suggestion.description,
          links: suggestion.links,
        });
      } else if (linearIssues.length > 0 || gmailTodos.length > 0 || assignedActions.length > 0) {
        // Only show work blocks if there are tasks to work on
        timeline.push({
          start: block.start,
          end: block.end,
          type: "work",
          title: "Available Work Time",
          description: `${block.durationMinutes} minutes available`,
          links: {},
        });
      }
    }
  }
  
  // Sort chronologically
  timeline.sort((a, b) => a.start.getTime() - b.start.getTime());
  
  return timeline;
}

/**
 * Builds a clean chronological list output from unified timeline
 */
function buildListOutput(timeline: TimelineItem[]): string {
  if (timeline.length === 0) {
    return "No items scheduled for today.";
  }
  
  let output = "";
  
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const isAllDay = item.title.includes("(All day)");
    const timeRange = formatTimeRange(item.start, item.end, isAllDay);
    const durationMinutes = Math.round((item.end.getTime() - item.start.getTime()) / (1000 * 60));
    
    // Format time as bold header
    output += `**${timeRange}**`;
    
    if (item.type === "meeting") {
      // Calendar event - title on next line, links inline
      output += `\n📅 `;
      if (item.links.calendar) {
        output += `[${item.title}](${item.links.calendar})`;
      } else {
        output += item.title;
      }
      if (item.links.zoom) {
        output += ` | [Join](${item.links.zoom})`;
      }
      if (item.description) {
        output += `\n   ${item.description}`;
      }
    } else if (item.type === "focus") {
      // Solo calendar focus block (no other attendees)
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      
      output += ` (${durationStr})\n🎧 `;
      if (item.links.calendar) {
        output += `[${item.title}](${item.links.calendar})`;
      } else {
        output += item.title;
      }
    } else if (item.type === "work") {
      // Work block with recommendation
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      
      // Use ⚫ for Linear tasks, ⏰ for other work
      const blockEmoji = item.links.linear ? "⚫" : "⏰";
      
      output += ` — WORK BLOCK (${durationStr})\n${blockEmoji} `;
      
      // If there's a Linear link, make the issue ID in the title clickable
      if (item.links.linear) {
        // Replace issue ID in title with linked version
        const issueMatch = item.links.linear.match(/issue\/([A-Z]+-\d+)/);
        if (issueMatch) {
          const issueId = issueMatch[1];
          const linkedTitle = item.title.replace(issueId, `[${issueId}](${item.links.linear})`);
          output += linkedTitle;
        } else {
          output += `[${item.title}](${item.links.linear})`;
        }
      } else {
        output += item.title;
      }
      if (item.description) {
        // Make description a link if there's an email or doc link
        if (item.links.gmail) {
          output += `\n   [${item.description}](${item.links.gmail})`;
        } else if (item.links.docs) {
          output += `\n   [${item.description}](${item.links.docs})`;
        } else {
          output += `\n   ${item.description}`;
        }
      }
    } else {
      // Email or action - make description the link
      output += `\n`;
      if (item.links.gmail && item.description) {
        output += `📧 [${item.description}](${item.links.gmail})`;
      } else if (item.links.docs && item.description) {
        output += `📄 [${item.description}](${item.links.docs})`;
      } else {
        output += `${item.title}: ${item.description || ""}`;
      }
    }
    
    // Add consistent spacing between items (except after last item)
    if (i < timeline.length - 1) {
      output += `\n\n`;
    } else {
      output += `\n`;
    }
  }
  
  return output;
}

/**
 * Fetches assigned actions from Google Docs
 */
async function fetchAssignedActions(accessToken: string): Promise<AssignedActionDetail[]> {
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

  const data = await response.json() as {
    activities?: Array<{
      primaryActionDetail?: {
        comment?: {
          mentionedUsers?: Array<{ knownUser?: { isCurrentUser?: boolean } }>;
          assignment?: {
            assignedUser?: { knownUser?: { isCurrentUser?: boolean } };
          };
        };
      };
      targets?: Array<{
        driveItem?: {
          title?: string;
          name?: string;
        };
      }>;
      timestamp?: string;
    }>;
  };

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

/**
 * Gets the authenticated user's GitHub username
 */
async function getGitHubUsername(accessToken: string): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "todo-mcp-server",
  };

  const response = await fetch("https://api.github.com/user", { headers });

  if (!response.ok) {
    return null;
  }

  const user = await response.json() as { login: string };
  return user.login;
}

/**
 * Fetches GitHub PRs and issues assigned to the user
 */
async function fetchGitHubTodos(accessToken: string): Promise<{
  prs: GitHubPRDetail[];
  issues: GitHubIssueDetail[];
}> {
  const username = await getGitHubUsername(accessToken);
  if (!username) {
    return { prs: [], issues: [] };
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "todo-mcp-server",
  };

  const prs: GitHubPRDetail[] = [];
  const issues: GitHubIssueDetail[] = [];

  try {
    // Fetch PRs assigned to the user
    const assignedPRResponse = await fetch(
      `https://api.github.com/search/issues?q=is:pr+is:open+assignee:${username}&per_page=10&sort=updated`,
      { headers }
    );

    // Fetch PRs requesting review
    const reviewPRResponse = await fetch(
      `https://api.github.com/search/issues?q=is:pr+is:open+review-requested:${username}&per_page=10&sort=updated`,
      { headers }
    );

    // Fetch full PR details
    if (assignedPRResponse.ok) {
      const assignedData = await assignedPRResponse.json() as { items: Array<{ pull_request?: { url: string } }> };
      const prPromises = assignedData.items
        .filter(item => item.pull_request)
        .map(item => {
          const prUrl = item.pull_request!.url.replace("https://api.github.com/repos/", "");
          return fetch(`https://api.github.com/repos/${prUrl}`, { headers })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);
        });
      const assignedPRs = (await Promise.all(prPromises)).filter(Boolean) as Array<{
        number: number;
        title: string;
        html_url: string;
        draft: boolean;
        updated_at: string;
        repository: { full_name: string };
      }>;

      for (const pr of assignedPRs) {
        prs.push({
          id: pr.number,
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          repo: pr.repository.full_name,
          type: "assigned",
          updatedAt: pr.updated_at,
          isDraft: pr.draft,
        });
      }
    }

    if (reviewPRResponse.ok) {
      const reviewData = await reviewPRResponse.json() as { items: Array<{ pull_request?: { url: string } }> };
      const prPromises = reviewData.items
        .filter(item => item.pull_request)
        .map(item => {
          const prUrl = item.pull_request!.url.replace("https://api.github.com/repos/", "");
          return fetch(`https://api.github.com/repos/${prUrl}`, { headers })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);
        });
      const reviewPRs = (await Promise.all(prPromises)).filter(Boolean) as Array<{
        number: number;
        title: string;
        html_url: string;
        draft: boolean;
        updated_at: string;
        repository: { full_name: string };
      }>;

      for (const pr of reviewPRs) {
        prs.push({
          id: pr.number,
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          repo: pr.repository.full_name,
          type: "review",
          updatedAt: pr.updated_at,
          isDraft: pr.draft,
        });
      }
    }

    // Fetch issues assigned to the user
    const issuesResponse = await fetch(
      `https://api.github.com/search/issues?q=is:issue+is:open+assignee:${username}&per_page=10&sort=updated`,
      { headers }
    );

    if (issuesResponse.ok) {
      const issuesData = await issuesResponse.json() as {
        items: Array<{
          number: number;
          title: string;
          html_url: string;
          updated_at: string;
          repository_url: string;
          labels?: Array<{ name: string }>;
        }>;
      };

      for (const issue of issuesData.items) {
        const repoMatch = issue.repository_url.match(/repos\/([^/]+\/[^/]+)/);
        const repo = repoMatch ? repoMatch[1] : "unknown";
        issues.push({
          id: issue.number,
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          repo,
          updatedAt: issue.updated_at,
          labels: issue.labels?.map(l => l.name),
        });
      }
    }
  } catch {
    // Silently fail - GitHub is optional
  }

  return { prs, issues };
}

/**
 * Registers the list-today-todos tool with the MCP server
 *
 * This tool aggregates tasks from multiple sources:
 * - Calendar events for today
 * - Linear issues due today or overdue
 * - Gmail emails needing attention
 * - Assigned actions from Google Docs
 * - GitHub PRs and issues assigned to you
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerTodayTodosTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-today-todos",
    {
      title: "List Today's Todos",
      description: "Get a comprehensive view of everything you need to do today, aggregated from Calendar, Linear, Gmail, Google Docs, and GitHub. Use this when the user asks 'what do I have to do today?', 'what's on my plate?', 'show me my tasks', 'what do I have left to do?', or 'what's remaining?'.",
      inputSchema: todayTodosInputSchema,
    },
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [{
            type: "text",
            text: "❌ No authentication information available. Please ensure you're properly authenticated."
          }]
        };
      }

      const includeCalendar = args.includeCalendar ?? true;
      const includeLinear = args.includeLinear ?? true;
      const includeGmail = args.includeGmail ?? true;
      const includeAssignedActions = args.includeAssignedActions ?? true;
      const includeGithub = args.includeGithub ?? true;
      const showOnlyRemaining = args.showOnlyRemaining ?? false;

      const errors: string[] = [];
      let calendarEvents: CalendarEventDetail[] = [];
      let linearIssues: LinearIssueDetail[] = [];
      let gmailTodos: GmailMessageDetail[] = [];
      let assignedActions: AssignedActionDetail[] = [];
      let githubPRs: GitHubPRDetail[] = [];
      let githubIssues: GitHubIssueDetail[] = [];

      try {
        // Fetch calendar events
        if (includeCalendar) {
          try {
            const calendarToken = await stsClient.exchange(
              authInfo,
              CALENDAR_RESOURCE,
              CALENDAR_SCOPES
            );
            calendarEvents = await fetchTodayCalendarEvents(calendarToken.access_token);
          } catch (error) {
            errors.push(`Calendar: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        // Calculate 7 days from now
        const today = new Date();
        const sevenDaysFromNow = new Date(today);
        sevenDaysFromNow.setDate(today.getDate() + 7);
        sevenDaysFromNow.setHours(23, 59, 59, 999);

        // Fetch Linear issues
        if (includeLinear) {
          try {
            const linearToken = await stsClient.exchange(
              authInfo,
              LINEAR_RESOURCE,
              LINEAR_SCOPES
            );
            linearIssues = await fetchLinearIssues(linearToken.access_token, sevenDaysFromNow);
          } catch (error) {
            errors.push(`Linear: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        // Fetch Gmail todos
        if (includeGmail) {
          try {
            const gmailToken = await stsClient.exchange(
              authInfo,
              GMAIL_RESOURCE,
              GMAIL_SCOPES
            );
            gmailTodos = await fetchGmailTodos(gmailToken.access_token);
          } catch (error) {
            errors.push(`Gmail: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        // Fetch assigned actions
        if (includeAssignedActions) {
          try {
            const driveToken = await stsClient.exchange(
              authInfo,
              DRIVE_ACTIVITY_RESOURCE,
              DRIVE_ACTIVITY_SCOPES
            );
            assignedActions = await fetchAssignedActions(driveToken.access_token);
          } catch (error) {
            errors.push(`Assigned Actions: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        // Fetch GitHub PRs and issues
        if (includeGithub) {
          try {
            const githubToken = await stsClient.exchange(
              authInfo,
              GITHUB_RESOURCE,
              GITHUB_SCOPES
            );
            const githubData = await fetchGitHubTodos(githubToken.access_token);
            githubPRs = githubData.prs;
            githubIssues = githubData.issues;
          } catch (error) {
            errors.push(`GitHub: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        // Build table output with integrated recommendations
        // (today is already defined above, but normalize it for date comparisons)
        const todayNormalized = new Date(today);
        todayNormalized.setHours(0, 0, 0, 0);
        const todayStr = today.toLocaleDateString("en-US", { 
          weekday: "long", 
          year: "numeric", 
          month: "long", 
          day: "numeric" 
        });

        // Analyze calendar and tasks
        const timeBlocks = findAvailableTimeBlocks(calendarEvents);
        const categorizedIssues = categorizeIssues(linearIssues, todayNormalized);

        // Create unified timeline
        let timeline = createUnifiedTimeline(
          calendarEvents,
          timeBlocks,
          categorizedIssues,
          linearIssues,
          gmailTodos,
          assignedActions
        );

        // Filter timeline to show only remaining items if requested
        // Only filter out past meetings; keep work blocks and other items even if time has passed
        const now = new Date();
        if (showOnlyRemaining) {
          timeline = timeline.filter(item => {
            // Only filter out meetings that have ended
            if (item.type === "meeting" && item.end < now) {
              return false;
            }
            // Keep all other items (work blocks, focus blocks, etc.) even if time has passed
            return true;
          });
        }

        // Generate insights
        const themes = detectThemes(calendarEvents, linearIssues);
        const insights = generateProductivityInsights(calendarEvents, timeBlocks, linearIssues, categorizedIssues);
        const lookahead = generateLookahead(calendarEvents, gmailTodos, linearIssues);
        
        // Calculate summary stats for remaining items
        const remainingTimeBlocks = showOnlyRemaining 
          ? timeBlocks.filter(block => block.end >= now)
          : timeBlocks;
        const totalAvailableMinutes = remainingTimeBlocks.reduce((sum, block) => sum + block.durationMinutes, 0);
        const hours = Math.floor(totalAvailableMinutes / 60);
        const minutes = totalAvailableMinutes % 60;
        // Count only actual meetings (not solo focus blocks) that are remaining
        const timedMeetings = timeline.filter(item => item.type === "meeting" && !item.title.includes("(All day)")).length;
        
        // Build output
        let output = `# 📅 ${todayStr}\n\n`;
        
        // Show current time if filtering
        if (showOnlyRemaining) {
          const currentTime = now.toLocaleTimeString("en-US", { 
            hour: "numeric", 
            minute: "2-digit", 
            hour12: true 
          });
          output += `## ⏰ What's Left (as of ${currentTime})\n\n`;
        }
        
        // Day Overview with focus areas
        const mainThemes = themes.filter(t => t.isMainFocus);
        if (mainThemes.length > 0) {
          output += `## 🎯 Today's Focus\n\n`;
          for (const theme of mainThemes.slice(0, 2)) {
            output += `- **${theme.theme}** — ${theme.items.length} related items\n`;
          }
          output += `\n---\n\n`;
        }
        
        // Quick stats line
        if (showOnlyRemaining && timeline.length === 0) {
          output += `🎉 **All done for today!** No remaining items scheduled.\n\n`;
        } else {
          output += `📊 **${timedMeetings} meeting${timedMeetings !== 1 ? "s" : ""} remaining** · **${hours}h ${minutes}m focus time left** · **${linearIssues.length} tasks** due within 7 days\n\n`;
        }
        
        // Productivity Insights
        if (insights.length > 0) {
          output += `---\n\n## 💡 Productivity Tips\n\n`;
          for (const insight of insights) {
            output += `- ${insight}\n`;
          }
          output += `\n---\n\n`;
        } else {
          // Add separator before "Your Day" even if no insights
          output += `---\n\n`;
        }
        
        // Schedule
        if (showOnlyRemaining) {
          output += `## 📋 What's Remaining\n\n`;
        } else {
          output += `## 📋 Your Day\n\n`;
        }
        
        if (timeline.length === 0 && showOnlyRemaining) {
          output += `✨ Nothing scheduled for the rest of today!\n\n`;
        } else {
          output += buildListOutput(timeline);
        }
        
        // Lookahead / Prep
        if (lookahead.length > 0) {
          output += `\n---\n\n## 🔮 Looking Ahead\n\n`;
          for (const item of lookahead) {
            if (item.link) {
              // Use provided linkText, or extract issue ID, or fall back to "View"
              let linkText = item.linkText;
              if (!linkText) {
                const issueMatch = item.link.match(/issue\/([A-Z]+-\d+)/);
                linkText = issueMatch ? issueMatch[1] : "View";
              }
              output += `- ${item.text} [${linkText}](${item.link})\n`;
            } else {
              output += `- ${item.text}\n`;
            }
          }
          output += `\n`;
        }
        
        // Remaining tasks not scheduled
        const scheduledIssueIds = new Set<string>();
        for (const item of timeline) {
          if (item.links.linear) {
            // Extract issue ID from URL
            const match = item.links.linear.match(/issue\/([A-Z]+-\d+)/);
            if (match) scheduledIssueIds.add(match[1]);
          }
        }
        const unscheduledIssues = linearIssues.filter(i => !scheduledIssueIds.has(i.identifier));
        if (unscheduledIssues.length > 0) {
          output += `---\n\n## 📌 Other Tasks (not scheduled today)\n\n`;
          for (const issue of unscheduledIssues.slice(0, 5)) {
            const dueStr = issue.dueDate 
              ? `due ${new Date(issue.dueDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
              : "no due date";
            output += `- [${issue.identifier}](${issue.url}): ${issue.title} (${dueStr})\n`;
          }
          if (unscheduledIssues.length > 5) {
            output += `- ... and ${unscheduledIssues.length - 5} more\n`;
          }
          output += `\n`;
        }

        // GitHub PRs and Issues
        if (githubPRs.length > 0 || githubIssues.length > 0) {
          output += `---\n\n## 🔷 GitHub\n\n`;
          
          // Show review-requested PRs first (usually more urgent)
          const reviewPRs = githubPRs.filter(pr => pr.type === "review");
          if (reviewPRs.length > 0) {
            output += `### 👀 PRs Requesting Review (${reviewPRs.length})\n\n`;
            for (const pr of reviewPRs.slice(0, 5)) {
              const draft = pr.isDraft ? "📝 [DRAFT] " : "";
              const updated = new Date(pr.updatedAt);
              const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
              const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
              output += `- ${draft}[${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (updated ${timeAgo})\n`;
            }
            if (reviewPRs.length > 5) {
              output += `- ... and ${reviewPRs.length - 5} more\n`;
            }
            output += `\n`;
          }

          // Then assigned PRs
          const assignedPRs = githubPRs.filter(pr => pr.type === "assigned");
          if (assignedPRs.length > 0) {
            output += `### 🔀 Assigned PRs (${assignedPRs.length})\n\n`;
            for (const pr of assignedPRs.slice(0, 5)) {
              const draft = pr.isDraft ? "📝 [DRAFT] " : "";
              const updated = new Date(pr.updatedAt);
              const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
              const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
              output += `- ${draft}[${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (updated ${timeAgo})\n`;
            }
            if (assignedPRs.length > 5) {
              output += `- ... and ${assignedPRs.length - 5} more\n`;
            }
            output += `\n`;
          }

          // Then issues
          if (githubIssues.length > 0) {
            output += `### 🐛 Assigned Issues (${githubIssues.length})\n\n`;
            for (const issue of githubIssues.slice(0, 5)) {
              const updated = new Date(issue.updatedAt);
              const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
              const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
              const labels = issue.labels && issue.labels.length > 0 
                ? ` • ${issue.labels.slice(0, 3).map(l => `\`${l}\``).join(", ")}`
                : "";
              output += `- [${issue.repo}#${issue.number}](${issue.url}): ${issue.title} (updated ${timeAgo}${labels})\n`;
            }
            if (githubIssues.length > 5) {
              output += `- ... and ${githubIssues.length - 5} more\n`;
            }
            output += `\n`;
          }
        }

        if (errors.length > 0) {
          output += `⚠️ **Some sources couldn't be accessed:**\n${errors.map(e => `- ${e}`).join("\n")}`;
        }

        return {
          content: [{
            type: "text",
            text: output
          }]
        };

      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{
            type: "text",
            text: `❌ Error aggregating todos: ${message}`
          }]
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof todayTodosInputSchema>
  );
}
