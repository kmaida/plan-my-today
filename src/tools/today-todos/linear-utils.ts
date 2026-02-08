import type { CalendarEventDetail, LinearIssueDetail, CategorizedIssues } from "./types";
import { PriorityMetadata, categorizeScore } from "./priority-utils";
import { FETCH_LIMITS } from "../../constants";

/**
 * Fetches all Linear issues assigned to the user
 *
 * @param accessToken - Linear access token
 * @param options - Fetch options
 * @returns Array of Linear issues
 */
export async function fetchAllAssignedIssues(
  accessToken: string,
  options: {
    includeCompleted?: boolean;
    limit?: number;
  } = {}
): Promise<LinearIssueDetail[]> {
  const { includeCompleted = false, limit = 50 } = options;

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
            completedAt
            updatedAt
          }
        }
      }
    }
  `;

  const filter = includeCompleted ? {} : {
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
      variables: { first: limit, filter },
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

  return data.data?.viewer?.assignedIssues?.nodes || [];
}

/**
 * Fetches Linear issues assigned to the user, filtered by due date
 *
 * @param accessToken - Linear access token
 * @param dueByDate - Include issues due on or before this date
 * @param options - Optional configuration
 * @param options.includeRecentlyCompleted - Include recently completed items (default: false, agent: true)
 * @param options.completedDaysBack - Days to look back for completed items (default: 0, agent: 3)
 * @returns Array of Linear issues
 */
export async function fetchLinearIssues(
  accessToken: string,
  dueByDate: Date,
  options: {
    includeRecentlyCompleted?: boolean;
    completedDaysBack?: number;
  } = {}
): Promise<LinearIssueDetail[]> {
  // Defaults: backward compatible with existing behavior
  const { includeRecentlyCompleted = false, completedDaysBack = 0 } = options;

  // Fetch open issues
  let issues = await fetchAllAssignedIssues(accessToken, {
    includeCompleted: false,
    limit: FETCH_LIMITS.LINEAR,
  });

  // If includeRecentlyCompleted, also fetch completed items
  if (includeRecentlyCompleted && completedDaysBack > 0) {
    const completedIssues = await fetchAllAssignedIssues(accessToken, {
      includeCompleted: true,
      limit: FETCH_LIMITS.LINEAR,
    });

    // Filter to only include items completed within completedDaysBack
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - completedDaysBack);
    cutoffDate.setHours(0, 0, 0, 0);

    const recentlyCompleted = completedIssues.filter(issue => {
      if (issue.state?.type !== "completed") return false;
      if (!issue.completedAt) return false;
      const completedDate = new Date(issue.completedAt);
      return completedDate >= cutoffDate;
    });

    // Merge with open issues
    issues = [...issues, ...recentlyCompleted];
  }

  // Filter: include issues that are actionable today
  // 1. Due within the date window (or overdue)
  // 2. High or Urgent priority (priority ≤ 2), even without a due date
  // 3. Recently completed (already filtered by date above)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return issues.filter(issue => {
    // If completed, always include (already filtered by date above)
    if (issue.state?.type === "completed") return true;

    // High or Urgent priority always included (priority: 0=No, 1=Urgent, 2=High, 3=Medium, 4=Low)
    if (issue.priority >= 1 && issue.priority <= 2) return true;

    // Has a due date within the window or overdue
    if (issue.dueDate) {
      const dueDate = new Date(issue.dueDate);
      dueDate.setHours(0, 0, 0, 0);
      return dueDate <= dueByDate;
    }

    // No due date and not high/urgent — skip
    return false;
  });
}

/**
 * Categorizes Linear issues by urgency and priority
 */
export function categorizeIssues(issues: LinearIssueDetail[], today: Date): CategorizedIssues {
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
export function detectThemes(
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
 * Calculates priority metadata for Linear issues
 *
 * @param issue - Linear issue detail
 * @param now - Current date/time for temporal calculations
 * @returns Priority metadata
 */
export function calculateLinearPriority(
  issue: LinearIssueDetail,
  now: Date
): PriorityMetadata {
  // Linear uses categorical priority, not numerical
  // Score based on temporal urgency + priority level
  let score = 70; // Base
  const reasons: string[] = [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let temporalUrgency: "overdue" | "due_today" | "due_this_week" | "due_later" | "no_due_date";
  let daysUntilDue: number | null = null;

  if (issue.dueDate) {
    const dueDate = new Date(issue.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilDue < 0) {
      temporalUrgency = "overdue";
      score += 100;
      reasons.push("Overdue");
    } else if (daysUntilDue === 0) {
      temporalUrgency = "due_today";
      score += 80;
      reasons.push("Due today");
    } else if (daysUntilDue <= 7) {
      temporalUrgency = "due_this_week";
      score += 40;
      reasons.push("Due soon");
    } else {
      temporalUrgency = "due_later";
      score += 10;
    }
  } else {
    temporalUrgency = "no_due_date";
  }

  // Priority level boost
  if (issue.priority <= 1) {
    score += 50;
    reasons.push("Urgent priority");
  } else if (issue.priority === 2) {
    score += 30;
    reasons.push("High priority");
  }

  // Recent activity boost - issues actively being worked on
  let ageHours: number | null = null;
  if (issue.updatedAt) {
    const updatedDate = new Date(issue.updatedAt);
    ageHours = (now.getTime() - updatedDate.getTime()) / (1000 * 60 * 60);

    // Boost for recently updated issues (shows active work)
    if (ageHours <= 24) {
      score += 30;
      reasons.push("Updated in last 24 hours");
    } else if (ageHours <= 72) { // 3 days
      score += 20;
      reasons.push("Updated recently");
    } else if (ageHours <= 168) { // 7 days
      score += 10;
      reasons.push("Updated this week");
    }
  }

  const isCompleted = issue.state?.type === "completed";
  if (isCompleted) {
    reasons.push("Recently completed");
  }

  return {
    score,
    category: categorizeScore(score),
    signals: {
      temporalUrgency,
      priorityLevel: issue.priority,
      daysUntilDue,
      isCompleted,
      hasEstimate: issue.estimate !== null,
      estimatePoints: issue.estimate,
      ageHours,
      recentlyUpdated: ageHours !== null && ageHours <= 168 // Updated in last week
    },
    reasons
  };
}
