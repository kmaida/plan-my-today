import type { GitHubPRDetail, GitHubIssueDetail } from "./types";

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

  // Filter out items older than 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
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
