import { config } from "../../config";
import { TIME_WINDOWS } from "../../constants";
import { getLogger } from "../../observability/logger";
import { AuthenticationError } from "../../utils/error-utils";
import { calculateRecencyBoost, categorizeScore, type PriorityMetadata } from "./priority-utils";
import type { GitHubIssueDetail, GitHubPRDetail } from "./types";

/**
 * Known dependency/security bot logins (GitHub App identity).
 * Intentionally narrow — targets only dedicated dependency bots, not all
 * GitHub Apps. `github-actions[bot]` and other workflow bots are excluded.
 */
const DEPENDENCY_BOT_LOGINS = new Set(["dependabot[bot]", "renovate[bot]", "snyk[bot]"]);

/** Returns true if the given GitHub login belongs to a dependency/security bot. */
function isDependencyBot(login: string): boolean {
  return DEPENDENCY_BOT_LOGINS.has(login.toLowerCase());
}

/**
 * Head branch prefixes used by dependency tools when creating PRs.
 * Catches PAT-configured Snyk (creates PRs under the user's account, not
 * the `snyk[bot]` App identity), as well as belt-and-suspenders coverage
 * for dependabot and renovate.
 */
const DEPENDENCY_BOT_BRANCH_PREFIXES = ["snyk-fix-", "snyk-upgrade-", "dependabot/", "renovate/"];

/** Returns true if the head branch name matches a known dependency-bot pattern. */
function isDependencyBotBranch(ref: string): boolean {
  return DEPENDENCY_BOT_BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

/** Module-level cache for GitHub username (never changes for a given token). */
let cachedGitHubUser: { token: string; login: string } | null = null;

/**
 * Gets the authenticated user's GitHub username.
 * Caches the result in-memory since the login never changes for a given token.
 */
async function getGitHubUsername(accessToken: string): Promise<string | null> {
  if (cachedGitHubUser && cachedGitHubUser.token === accessToken) {
    return cachedGitHubUser.login;
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "plan-my-today",
  };

  const response = await fetch("https://api.github.com/user", { headers });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError("GitHub", response.status);
    }
    return null;
  }

  const user = (await response.json()) as { login: string };
  cachedGitHubUser = { token: accessToken, login: user.login };
  return user.login;
}

/** Builds a YYYY-MM-DD date string for `updated:>` API filters. */
function buildDateStr(daysBack: number): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
}

/** Full PR object returned by GET /repos/{owner}/{repo}/pulls/{number}. */
type RawGitHubPR = {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  updated_at: string;
  repository?: { full_name?: string };
  base?: { repo?: { full_name?: string; owner?: { login?: string } } };
  head?: { ref?: string; repo?: { full_name?: string } };
  assignees?: Array<{ login: string }>;
  requested_reviewers?: Array<{ login: string }>;
  user?: { login: string };
};

/** Issue item returned by the GitHub Search API. */
type RawGitHubIssue = {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  repository_url: string;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  user?: { login: string };
};

/**
 * Extracts the full repo name (owner/repo) from a raw PR response,
 * using multiple fallback fields in the API response.
 */
function extractRepoFromPR(pr: RawGitHubPR): string {
  return (
    pr.repository?.full_name ??
    pr.base?.repo?.full_name ??
    pr.head?.repo?.full_name ??
    pr.html_url.match(/github\.com\/([^/]+\/[^/]+)(?:\/pull|\/pulls)/)?.[1] ??
    "unknown"
  );
}

/**
 * Runs a GitHub Search API query and returns the raw items array.
 * Returns empty array on non-auth errors; throws on 401/403.
 */
async function runSearchQuery(url: string, headers: Record<string, string>): Promise<unknown[]> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError("GitHub", response.status);
    }
    return [];
  }
  const data = (await response.json()) as { items: unknown[] };
  return data.items ?? [];
}

/**
 * Fetches full PR details from the GitHub API given a deduplicated list of
 * search result items. Filters out non-PR items (issues appear in search results).
 */
async function fetchPRDetails(
  items: Array<{ pull_request?: { url: string } }>,
  headers: Record<string, string>
): Promise<RawGitHubPR[]> {
  const prItems = items.filter((item) => item.pull_request);
  const detailPromises = prItems.map((item) => {
    const prUrl = item.pull_request!.url.replace("https://api.github.com/repos/", "");
    return fetch(`https://api.github.com/repos/${prUrl}`, { headers })
      .then((r) => (r.ok ? (r.json() as Promise<RawGitHubPR>) : null))
      .catch(() => null);
  });
  return (await Promise.all(detailPromises)).filter(Boolean) as RawGitHubPR[];
}

/**
 * Fetches GitHub PRs and issues relevant to the authenticated user.
 *
 * Queries run in parallel and cover: assigned, review-requested, authored,
 * PRs on personally-owned repos, and PRs/issues on configured org repos
 * (ORG_GITHUB_REPOS). All queries use a 7-day activity window.
 *
 * Boolean relationship flags (isAssigned, isReviewRequested, isAuthored,
 * isOwnedRepo) are computed from the actual API response — not from which
 * query returned the item — so they stack correctly when multiple apply.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrates multiple parallel GitHub API queries
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
    "User-Agent": "plan-my-today",
  };

  const dateStr = buildDateStr(TIME_WINDOWS.GITHUB_DAYS);
  const BASE = "https://api.github.com/search/issues";

  try {
    // ── Search queries — all in parallel ────────────────────────────────────

    const prQueries = [
      `${BASE}?q=is:pr+is:open+assignee:${username}+updated:>${dateStr}&per_page=15&sort=updated`,
      `${BASE}?q=is:pr+is:open+review-requested:${username}+updated:>${dateStr}&per_page=15&sort=updated`,
      `${BASE}?q=is:pr+is:open+author:${username}+updated:>${dateStr}&per_page=15&sort=updated`,
      `${BASE}?q=is:pr+is:open+user:${username}+updated:>${dateStr}&per_page=15&sort=updated`,
      ...config.orgGithubRepos.map(
        (repo) =>
          `${BASE}?q=is:pr+is:open+repo:${repo}+updated:>${dateStr}&per_page=15&sort=updated`
      ),
    ];

    const issueQueries = [
      `${BASE}?q=is:issue+is:open+assignee:${username}+updated:>${dateStr}&per_page=15&sort=updated`,
      `${BASE}?q=is:issue+is:open+author:${username}+updated:>${dateStr}&per_page=15&sort=updated`,
      ...config.orgGithubRepos.map(
        (repo) =>
          `${BASE}?q=is:issue+is:open+repo:${repo}+updated:>${dateStr}&per_page=15&sort=updated`
      ),
    ];

    const [prSearchResults, issueSearchResults] = await Promise.all([
      Promise.all(prQueries.map((q) => runSearchQuery(q, headers))),
      Promise.all(issueQueries.map((q) => runSearchQuery(q, headers))),
    ]);

    // ── PRs: dedup search items by pull_request.url, fetch full details ──────

    const seenPRUrls = new Map<string, { pull_request?: { url: string } }>();
    for (const items of prSearchResults) {
      for (const item of items as Array<{ pull_request?: { url: string } }>) {
        const url = item.pull_request?.url;
        if (url && !seenPRUrls.has(url)) {
          seenPRUrls.set(url, item);
        }
      }
    }

    const rawPRs = await fetchPRDetails(Array.from(seenPRUrls.values()), headers);

    const seenPRKeys = new Set<string>();
    const prs: GitHubPRDetail[] = [];

    for (const pr of rawPRs) {
      const repo = extractRepoFromPR(pr);
      const key = `${repo}#${pr.number}`;
      if (seenPRKeys.has(key)) continue;
      seenPRKeys.add(key);

      prs.push({
        id: pr.number,
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        repo,
        isAssigned: (pr.assignees ?? []).some((a) => a.login === username),
        isReviewRequested: (pr.requested_reviewers ?? []).some((r) => r.login === username),
        isAuthored: pr.user?.login === username,
        isOwnedRepo:
          pr.base?.repo?.owner?.login === username || config.orgGithubRepos.includes(repo),
        isBot: isDependencyBot(pr.user?.login ?? "") || isDependencyBotBranch(pr.head?.ref ?? ""),
        dismissalId: `${repo}#${pr.number}`,
        updatedAt: pr.updated_at,
        isDraft: pr.draft,
      });
    }

    // ── Issues: dedup by html_url, build directly from search data ───────────

    const seenIssueUrls = new Map<string, RawGitHubIssue>();
    for (const items of issueSearchResults) {
      for (const item of items as RawGitHubIssue[]) {
        if (item.html_url && !seenIssueUrls.has(item.html_url)) {
          seenIssueUrls.set(item.html_url, item);
        }
      }
    }

    const seenIssueKeys = new Set<string>();
    const issues: GitHubIssueDetail[] = [];

    for (const issue of seenIssueUrls.values()) {
      const repoMatch = issue.repository_url.match(/repos\/([^/]+\/[^/]+)/);
      const repo = repoMatch ? repoMatch[1] : "unknown";
      const key = `${repo}#${issue.number}`;
      if (seenIssueKeys.has(key)) continue;
      seenIssueKeys.add(key);

      const repoOwner = issue.repository_url.match(/repos\/([^/]+)\//)?.[1];
      issues.push({
        id: issue.number,
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        repo,
        isAssigned: (issue.assignees ?? []).some((a) => a.login === username),
        isAuthored: issue.user?.login === username,
        isOwnedRepo: repoOwner === username || config.orgGithubRepos.includes(repo),
        // Issues come from Search API (no head.ref) — branch-name detection is not
        // available here. Login detection still catches Snyk App (snyk[bot]) and
        // other GitHub App bots; PAT-configured tools rarely create issues.
        isBot: isDependencyBot(issue.user?.login ?? ""),
        dismissalId: `${repo}#${issue.number}`,
        updatedAt: issue.updated_at,
        labels: issue.labels?.map((l) => l.name),
      });
    }

    return { prs, issues };
  } catch (err) {
    if (err instanceof AuthenticationError) throw err;
    getLogger()
      .withOperation("github_utils")
      .warn("GitHub API error — returning empty results", {
        error: String(err),
      });
    return { prs: [], issues: [] };
  }
}

/**
 * Calculates priority metadata for GitHub PRs and issues using additive
 * relationship-flag scoring. Multiple flags stack — a PR that is both
 * assigned and review-requested scores higher than either alone.
 *
 * PR scores: review-requested +100, authored +70, assigned +60, owned-repo-only +40.
 * Issue scores: authored +70, assigned +60, owned-repo-only +40.
 * Recency boosts apply on top. Draft PRs get -30. Dependency bot items get -60,
 * except bot PRs with an explicit review request (those stay at full priority).
 *
 * @param item - GitHub PR or issue detail
 * @param now - Current date/time for recency calculations
 * @returns Priority metadata
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: additive scoring across PR and issue branches
export function calculateGitHubPriority(
  item: GitHubPRDetail | GitHubIssueDetail,
  now: Date
): PriorityMetadata {
  let score = 50; // Base
  const reasons: string[] = [];
  const isPR = "isDraft" in item;

  if (isPR) {
    const pr = item as GitHubPRDetail;
    // Routine bots get no relationship bonuses — only review-requested bots keep the +100
    if (!pr.isBot || pr.isReviewRequested) {
      if (pr.isReviewRequested) {
        score += 100;
        reasons.push("Review requested");
      }
      if (pr.isAssigned) {
        score += 60;
        reasons.push("Assigned");
      }
      if (pr.isAuthored) {
        score += 70;
        reasons.push("Authored");
      }
      // isOwnedRepo baseline only added when no personal relationship applies
      if (pr.isOwnedRepo && !pr.isReviewRequested && !pr.isAssigned && !pr.isAuthored) {
        score += 40;
        reasons.push("Open on your repo");
      }
    }
    if (pr.isDraft) {
      score -= 30;
      reasons.push("Draft");
    }
    // Dependency bots are de-prioritized unless review was explicitly requested
    if (pr.isBot && !pr.isReviewRequested) {
      score -= 60;
      reasons.push("Automated");
    }
  } else {
    const issue = item as GitHubIssueDetail;
    if (!issue.isBot) {
      if (issue.isAssigned) {
        score += 60;
        reasons.push("Assigned");
      }
      if (issue.isAuthored) {
        score += 70;
        reasons.push("Authored");
      }
      if (issue.isOwnedRepo && !issue.isAssigned && !issue.isAuthored) {
        score += 40;
        reasons.push("Open on your repo");
      }
    }
    if (issue.isBot) {
      score -= 60;
      reasons.push("Automated");
    }
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

  // Derive display itemType from the highest-priority flag
  let itemType: string;
  if (isPR) {
    const pr = item as GitHubPRDetail;
    if (pr.isBot && !pr.isReviewRequested) itemType = "pr_automated";
    else if (pr.isReviewRequested) itemType = "pr_review";
    else if (pr.isAssigned) itemType = "pr_assigned";
    else if (pr.isAuthored) itemType = "pr_authored";
    else if (pr.isOwnedRepo) itemType = "pr_owned";
    else itemType = "pr_other";
  } else {
    itemType = "issue";
  }

  return {
    score,
    category: categorizeScore(score),
    signals: {
      itemType,
      isDraft: isPR ? (item as GitHubPRDetail).isDraft : false,
      isBot: item.isBot,
      ageHours,
      recencyBoost: calculateRecencyBoost(ageHours),
    },
    reasons,
  };
}
