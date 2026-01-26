import type { CalendarEventDetail, LinearIssueDetail, CategorizedIssues } from "./types";

/**
 * Fetches Linear issues assigned to the user (due within 7 days or without due dates)
 */
export async function fetchLinearIssues(accessToken: string, dueByDate: Date): Promise<LinearIssueDetail[]> {
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
