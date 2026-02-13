import { FETCH_LIMITS } from "../../constants";
import { getLogger } from "../../observability/logger";
import { parseLocalDate } from "../../utils/date-utils";
import { AuthenticationError } from "../../utils/error-utils";
import { categorizeScore, type PriorityMetadata } from "./priority-utils";
import type {
  CalendarEventDetail,
  CategorizedIssues,
  LinearIssueDetail,
  LinearRelatedIssueRef,
  LinearRelationType,
} from "./types";

/** Known Linear relation types we handle. Others are silently dropped. */
const KNOWN_RELATION_TYPES = new Set<string>(["blocks", "duplicate", "related"]);

/** Display labels for Linear relation types, used in cross-ref snippets and markdown output */
export const RELATION_LABELS: Record<string, string> = {
  blocks: "Blocks",
  duplicate: "Duplicate of",
  related: "Related",
};

/**
 * Raw shape of a single issue node from the Linear GraphQL response.
 * Kept local — consumers only see the cleaned LinearIssueDetail.
 */
interface RawLinearIssueNode {
  id: string;
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
  parent?: LinearRelatedIssueRef | null;
  children?: { nodes: LinearRelatedIssueRef[] };
  relations?: {
    nodes: Array<{
      type: string;
      relatedIssue: LinearRelatedIssueRef;
    }>;
  };
}

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
    /** Extra GraphQL IssueFilter fields merged into the base filter.
     *  Used by fetchLinearIssues to push actionable-today logic to the API. */
    additionalFilter?: Record<string, unknown>;
  } = {}
): Promise<LinearIssueDetail[]> {
  const { includeCompleted = false, limit = 50, additionalFilter } = options;

  const query = `
    query MyIssues($first: Int, $filter: IssueFilter) {
      viewer {
        assignedIssues(first: $first, filter: $filter, orderBy: updatedAt) {
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
            parent {
              identifier
              title
              url
              state {
                name
                type
              }
            }
            children {
              nodes {
                identifier
                title
                url
                state {
                  name
                  type
                }
              }
            }
            relations {
              nodes {
                type
                relatedIssue {
                  identifier
                  title
                  url
                  state {
                    name
                    type
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const baseFilter = includeCompleted
    ? {}
    : {
        state: { type: { nin: ["completed", "canceled"] } },
      };

  // Merge caller-supplied filter (e.g. `or` combinator) with the base exclusion.
  // Keys don't overlap — base has `state`, caller typically adds `or`.
  const filter = additionalFilter ? { ...baseFilter, ...additionalFilter } : baseFilter;

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
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError("Linear", response.status);
    }
    getLogger().withOperation("linear_utils").warn("Linear API error — returning empty results", {
      status: response.status,
      statusText: response.statusText,
    });
    return [];
  }

  const data = (await response.json()) as {
    data?: {
      viewer?: {
        assignedIssues?: {
          nodes: RawLinearIssueNode[];
        };
      };
    };
  };

  const rawNodes = data.data?.viewer?.assignedIssues?.nodes || [];

  // Map raw GraphQL nodes to LinearIssueDetail, building relationMetadata at fetch time
  // so the domain type never carries raw GraphQL fields.
  const issues: LinearIssueDetail[] = rawNodes.map((node) => {
    const { parent: rawParent, children: rawChildren, relations: rawRelations, ...rest } = node;

    return {
      ...rest,
      relationMetadata: {
        parent: rawParent ?? null,
        children: rawChildren?.nodes ?? [],
        relations: (rawRelations?.nodes ?? [])
          .filter((r) => KNOWN_RELATION_TYPES.has(r.type) && r.relatedIssue)
          .map((r) => ({
            type: r.type as LinearRelationType,
            relatedIssue: r.relatedIssue,
          })),
      },
    };
  });

  // Belt-and-suspenders: Linear's API has eventual consistency on state
  // changes — both the GraphQL filter AND the returned field data can be
  // stale for several minutes after a status change. This post-filter
  // helps if the field data updates before the filter index, but won't
  // catch cases where the entire response is stale. The primary defense
  // is that the UI never auto-loads stale task store data on mount.
  if (!includeCompleted) {
    return issues.filter(
      (issue) => issue.state?.type !== "completed" && issue.state?.type !== "canceled"
    );
  }

  return issues;
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
  // TODO: implement recently-completed filtering when agent requests it
  const {
    includeRecentlyCompleted: _includeRecentlyCompleted = false,
    completedDaysBack: _completedDaysBack = 0,
  } = options;

  // Push actionable-today logic to the Linear GraphQL API using the `or` combinator.
  // Result: (NOT completed/canceled) AND (started OR high-priority OR due-within-window).
  // This replaces the former client-side filter and lets us fetch fewer items overall.
  // Build YYYY-MM-DD from local date parts (not toISOString which shifts to UTC).
  const y = dueByDate.getFullYear();
  const m = String(dueByDate.getMonth() + 1).padStart(2, "0");
  const d = String(dueByDate.getDate()).padStart(2, "0");
  const dueDateStr = `${y}-${m}-${d}`;
  const actionableFilter = {
    or: [
      { state: { type: { eq: "started" } } },
      { priority: { in: [1, 2] } },
      { dueDate: { lte: dueDateStr } },
    ],
  };

  return fetchAllAssignedIssues(accessToken, {
    includeCompleted: false,
    limit: FETCH_LIMITS.LINEAR,
    additionalFilter: actionableFilter,
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
      const due = parseLocalDate(issue.dueDate);
      const daysUntilDue = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

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
    let _matchedKeyword = false;

    for (const { pattern, theme } of keywordPatterns) {
      if (pattern.test(text)) {
        if (!themes.has(theme)) themes.set(theme, new Set());
        themes.get(theme)!.add(`📋 ${issue.identifier}: ${issue.title}`);
        _matchedKeyword = true;
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
export function calculateLinearPriority(issue: LinearIssueDetail, now: Date): PriorityMetadata {
  // Linear uses categorical priority, not numerical
  // Score based on temporal urgency + priority level
  let score = 70; // Base
  const reasons: string[] = [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let temporalUrgency: "overdue" | "due_today" | "due_this_week" | "due_later" | "no_due_date";
  let daysUntilDue: number | null = null;

  if (issue.dueDate) {
    const dueDate = parseLocalDate(issue.dueDate);
    daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

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

  // In-progress state boost — small tiebreaker only.
  // Must stay below priority (30/50) and due-date (40/80/100) boosts
  // so that in-progress items without signals don't outrank items that
  // have a real priority or approaching deadline.
  if (issue.state?.type === "started") {
    score += 10;
    reasons.push("In progress");
  }

  // Priority level boost
  if (issue.priority <= 1) {
    score += 50;
    reasons.push("Urgent priority");
  } else if (issue.priority === 2) {
    score += 30;
    reasons.push("High priority");
  }

  // Recent activity boost — only applies to issues that have priority
  // or a due date. Prevents bare in-progress items from stacking
  // activity + state boosts to leapfrog issues with real urgency signals.
  const hasPriorityOrDueDate = issue.priority >= 1 || !!issue.dueDate;
  let ageHours: number | null = null;
  if (issue.updatedAt) {
    const updatedDate = new Date(issue.updatedAt);
    ageHours = (now.getTime() - updatedDate.getTime()) / (1000 * 60 * 60);

    if (hasPriorityOrDueDate) {
      if (ageHours <= 24) {
        score += 30;
        reasons.push("Updated in last 24 hours");
      } else if (ageHours <= 72) {
        // 3 days
        score += 20;
        reasons.push("Updated recently");
      } else if (ageHours <= 168) {
        // 7 days
        score += 10;
        reasons.push("Updated this week");
      }
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
      recentlyUpdated: ageHours !== null && ageHours <= 168, // Updated in last week
    },
    reasons,
  };
}
