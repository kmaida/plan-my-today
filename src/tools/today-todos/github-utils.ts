import type { GitHubPRDetail, GitHubIssueDetail } from "./types";
import { PriorityMetadata, categorizeScore, calculateRecencyBoost } from "./priority-utils";
import { TIME_WINDOWS } from "../../constants";
import { AuthenticationError } from "../../utils/error-utils";

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
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError("GitHub", response.status);
    }
    return null;
  }

  const user = await response.json() as { login: string };
  return user.login;
}

/**
 * Fetches GitHub PRs and issues assigned to the user
 */
export async function fetchGitHubTodos(accessToken: string): Promise<{
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
    if (!assignedPRResponse.ok && (assignedPRResponse.status === 401 || assignedPRResponse.status === 403)) {
      throw new AuthenticationError("GitHub", assignedPRResponse.status);
    }
    if (!reviewPRResponse.ok && (reviewPRResponse.status === 401 || reviewPRResponse.status === 403)) {
      throw new AuthenticationError("GitHub", reviewPRResponse.status);
    }

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
        repository?: { full_name: string };
        base?: { repo?: { full_name: string } };
        head?: { repo?: { full_name: string } };
      }>;

      for (const pr of assignedPRs) {
        // Extract repo name with fallbacks
        let repo = pr.repository?.full_name;
        if (!repo && pr.base?.repo?.full_name) {
          repo = pr.base.repo.full_name;
        }
        if (!repo && pr.head?.repo?.full_name) {
          repo = pr.head.repo.full_name;
        }
        if (!repo && pr.html_url) {
          const match = pr.html_url.match(/github\.com\/([^\/]+\/[^\/]+)(?:\/pull|\/pulls)/);
          repo = match ? match[1] : "unknown";
        }
        
        prs.push({
          id: pr.number,
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          repo: repo || "unknown",
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
        repository?: { full_name: string };
        base?: { repo?: { full_name: string } };
        head?: { repo?: { full_name: string } };
      }>;

      for (const pr of reviewPRs) {
        // Extract repo name with fallbacks
        let repo = pr.repository?.full_name;
        if (!repo && pr.base?.repo?.full_name) {
          repo = pr.base.repo.full_name;
        }
        if (!repo && pr.head?.repo?.full_name) {
          repo = pr.head.repo.full_name;
        }
        if (!repo && pr.html_url) {
          const match = pr.html_url.match(/github\.com\/([^\/]+\/[^\/]+)(?:\/pull|\/pulls)/);
          repo = match ? match[1] : "unknown";
        }
        
        prs.push({
          id: pr.number,
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          repo: repo || "unknown",
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

    if (!issuesResponse.ok && (issuesResponse.status === 401 || issuesResponse.status === 403)) {
      throw new AuthenticationError("GitHub", issuesResponse.status);
    }

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
  } catch (err) {
    if (err instanceof AuthenticationError) throw err;
    // Silently fail - GitHub is optional
  }

  // Filter out items older than 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - TIME_WINDOWS.GITHUB_DAYS);
  const thirtyDaysAgoTime = thirtyDaysAgo.getTime();

  const recentPRs = prs.filter(pr => {
    const updatedAt = new Date(pr.updatedAt).getTime();
    return updatedAt >= thirtyDaysAgoTime;
  });

  const recentIssues = issues.filter(issue => {
    const updatedAt = new Date(issue.updatedAt).getTime();
    return updatedAt >= thirtyDaysAgoTime;
  });

  return { prs: recentPRs, issues: recentIssues };
}

/**
 * Calculates priority metadata for GitHub PRs and issues
 *
 * @param item - GitHub PR or issue detail
 * @param now - Current date/time for recency calculations
 * @returns Priority metadata
 */
export function calculateGitHubPriority(
  item: GitHubPRDetail | GitHubIssueDetail,
  now: Date
): PriorityMetadata {
  let score = 50; // Base
  const reasons: string[] = [];
  const isPR = 'isDraft' in item;

  if (isPR) {
    const pr = item as GitHubPRDetail;
    if (pr.type === "review") {
      score += 100;
      reasons.push("Review requested");
    } else {
      score += 60;
      reasons.push("Assigned PR");
    }

    if (pr.isDraft) {
      score -= 30;
      reasons.push("Draft (lower priority)");
    }
  } else {
    reasons.push("Assigned issue");
  }

  const updatedAt = new Date(item.updatedAt);
  const ageHours = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);

  if (ageHours < 4) {
    score += 40;
    reasons.push("Very recent update");
  } else if (ageHours < 24) {
    score += 20;
    reasons.push("Recent update");
  } else if (ageHours < 48) {
    score += 10;
  }

  return {
    score,
    category: categorizeScore(score),
    signals: {
      itemType: isPR ? ((item as GitHubPRDetail).type === "review" ? "pr_review" : "pr_assigned") : "issue",
      isDraft: isPR ? (item as GitHubPRDetail).isDraft : false,
      ageHours,
      recencyBoost: calculateRecencyBoost(ageHours)
    },
    reasons
  };
}
