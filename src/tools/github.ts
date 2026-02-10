import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod/v3";
import { keycardClient } from "../services/keycard-client";
import { fetchGitHubTodos } from "./today-todos/github-utils";
import type { GitHubPRDetail, GitHubIssueDetail } from "./today-todos/types";

const GITHUB_RESOURCE = "https://api.github.com";
const GITHUB_SCOPES = ["repo", "read:org"];

/**
 * Input schema for the list-github-todos tool
 */
const githubTodosInputSchema = {
  includePRs: z.boolean()
    .describe("Include pull requests assigned to you or requesting your review (default: true)")
    .optional(),
  includeIssues: z.boolean()
    .describe("Include issues assigned to you (default: true)")
    .optional(),
  limit: z.number()
    .describe("Maximum number of items to return per category (default: 10)")
    .optional(),
};

/**
 * GitHub Pull Request
 */
interface GitHubPR {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
  requested_reviewers?: Array<{
    login: string;
  }>;
  assignees?: Array<{
    login: string;
  }>;
  repository?: {
    full_name: string;
  };
  head?: {
    ref: string;
    repo?: {
      full_name: string;
    };
  };
  base?: {
    ref: string;
    repo?: {
      full_name: string;
    };
  };
}

/**
 * GitHub Issue (from search API)
 */
interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  user: {
    login: string;
  };
  created_at: string;
  updated_at: string;
  assignees?: Array<{
    login: string;
  }>;
  repository_url?: string; // From search API: "https://api.github.com/repos/owner/repo"
  repository?: {
    full_name: string;
  };
  labels?: Array<{
    name: string;
    color: string;
  }>;
}

/**
 * Fetches pull requests assigned to the user or requesting review
 */
async function fetchMyPRs(
  accessToken: string,
  username: string,
  limit: number
): Promise<{ assigned: GitHubPR[]; reviewRequested: GitHubPR[] }> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "plan-my-today",
  };

  // Fetch PRs assigned to the user
  const assignedResponse = await fetch(
    `https://api.github.com/search/issues?q=is:pr+is:open+assignee:${username}&per_page=${limit}&sort=updated`,
    { headers }
  );

  // Fetch PRs requesting review from the user
  const reviewResponse = await fetch(
    `https://api.github.com/search/issues?q=is:pr+is:open+review-requested:${username}&per_page=${limit}&sort=updated`,
    { headers }
  );

  let assignedPRs: GitHubPR[] = [];
  let reviewRequestedPRs: GitHubPR[] = [];

  if (assignedResponse.ok) {
    const assignedData = await assignedResponse.json() as { items: Array<{ pull_request?: { url: string }; repository_url?: string }> };
    // Fetch full PR details for assigned PRs
    const prPromises = assignedData.items
      .filter(item => item.pull_request)
      .map(async (item) => {
        const prUrl = item.pull_request!.url.replace("https://api.github.com/repos/", "");
        const response = await fetch(`https://api.github.com/repos/${prUrl}`, { headers });
        if (!response.ok) return null;
        const pr = await response.json() as GitHubPR;
        // If repository info is missing, try multiple sources
        if (!pr.repository?.full_name) {
          // Try base.repo.full_name (standard GitHub PR API field)
          if (pr.base?.repo?.full_name) {
            pr.repository = { full_name: pr.base.repo.full_name };
          }
          // Try head.repo.full_name (fallback)
          else if (pr.head?.repo?.full_name) {
            pr.repository = { full_name: pr.head.repo.full_name };
          }
          // Try repository_url from search API
          else if (item.repository_url) {
            const match = item.repository_url.match(/\/repos\/([^\/]+\/[^\/]+)/);
            if (match && match[1]) {
              pr.repository = { full_name: match[1] };
            }
          }
          // Fallback: extract from prUrl (format: "owner/repo/pulls/123")
          else if (prUrl) {
            const parts = prUrl.split('/');
            if (parts.length >= 2) {
              pr.repository = { full_name: `${parts[0]}/${parts[1]}` };
            }
          }
          // Final fallback: extract from html_url
          else if (pr.html_url) {
            const match = pr.html_url.match(/github\.com\/([^\/]+\/[^\/]+)(?:\/pull|\/pulls)/);
            if (match && match[1]) {
              pr.repository = { full_name: match[1] };
            }
          }
        }
        return pr;
      });
    assignedPRs = (await Promise.all(prPromises)).filter((pr): pr is GitHubPR => pr !== null);
  }

  if (reviewResponse.ok) {
    const reviewData = await reviewResponse.json() as { items: Array<{ pull_request?: { url: string }; repository_url?: string }> };
    // Fetch full PR details for review-requested PRs
    const prPromises = reviewData.items
      .filter(item => item.pull_request)
      .map(async (item) => {
        const prUrl = item.pull_request!.url.replace("https://api.github.com/repos/", "");
        const response = await fetch(`https://api.github.com/repos/${prUrl}`, { headers });
        if (!response.ok) return null;
        const pr = await response.json() as GitHubPR;
        // If repository info is missing, try multiple sources
        if (!pr.repository?.full_name) {
          // Try base.repo.full_name (standard GitHub PR API field)
          if (pr.base?.repo?.full_name) {
            pr.repository = { full_name: pr.base.repo.full_name };
          }
          // Try head.repo.full_name (fallback)
          else if (pr.head?.repo?.full_name) {
            pr.repository = { full_name: pr.head.repo.full_name };
          }
          // Try repository_url from search API
          else if (item.repository_url) {
            const match = item.repository_url.match(/\/repos\/([^\/]+\/[^\/]+)/);
            if (match && match[1]) {
              pr.repository = { full_name: match[1] };
            }
          }
          // Fallback: extract from prUrl (format: "owner/repo/pulls/123")
          else if (prUrl) {
            const parts = prUrl.split('/');
            if (parts.length >= 2) {
              pr.repository = { full_name: `${parts[0]}/${parts[1]}` };
            }
          }
          // Final fallback: extract from html_url
          else if (pr.html_url) {
            const match = pr.html_url.match(/github\.com\/([^\/]+\/[^\/]+)(?:\/pull|\/pulls)/);
            if (match && match[1]) {
              pr.repository = { full_name: match[1] };
            }
          }
        }
        return pr;
      });
    reviewRequestedPRs = (await Promise.all(prPromises)).filter((pr): pr is GitHubPR => pr !== null);
  }

  return { assigned: assignedPRs, reviewRequested: reviewRequestedPRs };
}

/**
 * Fetches issues assigned to the user
 */
async function fetchMyIssues(
  accessToken: string,
  username: string,
  limit: number
): Promise<GitHubIssue[]> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "plan-my-today",
  };

  const response = await fetch(
    `https://api.github.com/search/issues?q=is:issue+is:open+assignee:${username}&per_page=${limit}&sort=updated`,
    { headers }
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as { items: GitHubIssue[] };
  return data.items || [];
}

/**
 * Gets the authenticated user's GitHub username
 */
async function getGitHubUsername(accessToken: string): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "plan-my-today",
  };

  const response = await fetch("https://api.github.com/user", { headers });

  if (!response.ok) {
    return null;
  }

  const user = await response.json() as { login: string };
  return user.login;
}

/**
 * Extracts repository name from PR response
 */
function extractPRRepoName(pr: GitHubPR): string {
  // Try repository.full_name first (if present)
  if (pr.repository?.full_name) {
    return pr.repository.full_name;
  }
  
  // Try base.repo.full_name (GitHub PR API includes this)
  if (pr.base?.repo?.full_name) {
    return pr.base.repo.full_name;
  }
  
  // Try head.repo.full_name (fallback)
  if (pr.head?.repo?.full_name) {
    return pr.head.repo.full_name;
  }
  
  // Fallback: extract from html_url (format: "https://github.com/owner/repo/pull/123")
  if (pr.html_url) {
    // Match owner/repo from URLs like:
    // - https://github.com/owner/repo/pull/123
    // - https://github.com/owner/repo/pulls/123
    const match = pr.html_url.match(/github\.com\/([^\/]+\/[^\/]+)(?:\/pull|\/pulls)/);
    if (match && match[1]) {
      return match[1];
    }
    // Fallback: try to match any owner/repo pattern before a slash
    const fallbackMatch = pr.html_url.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (fallbackMatch && fallbackMatch[1]) {
      return fallbackMatch[1];
    }
  }
  
  return "unknown";
}

/**
 * Formats a PR detail from utility for display
 */
function formatPRDetail(pr: GitHubPRDetail): string {
  const draft = pr.isDraft ? "📝 [DRAFT] " : "";
  const emoji = pr.type === "review" ? "👀" : "🔀";
  const label = pr.type === "review" ? "Review requested" : "Assigned";

  const updated = new Date(pr.updatedAt);
  const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
  const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;

  return `• ${emoji} **${draft}[${pr.repo}#${pr.number}](${pr.url})**: ${pr.title}\n` +
    `  ${label} • Updated ${timeAgo}`;
}

/**
 * Formats a PR for display (legacy, uses old GitHubPR type)
 */
function formatPR(pr: GitHubPR, type: "assigned" | "review"): string {
  const repo = extractPRRepoName(pr);
  const draft = pr.draft ? "📝 [DRAFT] " : "";
  const emoji = type === "review" ? "👀" : "🔀";
  const label = type === "review" ? "Review requested" : "Assigned";

  const updated = new Date(pr.updated_at);
  const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
  const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;

  const headRef = pr.head?.ref || "unknown";
  const baseRef = pr.base?.ref || "unknown";
  const branchInfo = `${headRef} → ${baseRef}`;

  return `• ${emoji} **${draft}[${repo}#${pr.number}](${pr.html_url})**: ${pr.title}\n` +
    `  ${label} • Updated ${timeAgo} • ${branchInfo}`;
}

/**
 * Extracts repository name from various GitHub API response formats
 */
function extractRepoName(issue: GitHubIssue): string {
  // Try repository.full_name first (from full issue details)
  if (issue.repository?.full_name) {
    return issue.repository.full_name;
  }
  
  // Try repository_url from search API (format: "https://api.github.com/repos/owner/repo")
  if (issue.repository_url) {
    const match = issue.repository_url.match(/\/repos\/([^\/]+\/[^\/]+)/);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // Fallback: extract from html_url (format: "https://github.com/owner/repo/issues/123")
  if (issue.html_url) {
    const match = issue.html_url.match(/github\.com\/([^\/]+\/[^\/]+)\//);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  return "unknown";
}

/**
 * Formats an issue detail from utility for display
 */
function formatIssueDetail(issue: GitHubIssueDetail): string {
  const labels = issue.labels?.map(l => `\`${l}\``).join(", ") || "";
  const labelsText = labels ? ` • ${labels}` : "";

  const updated = new Date(issue.updatedAt);
  const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
  const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;

  return `• 🐛 **[${issue.repo}#${issue.number}](${issue.url})**: ${issue.title}\n` +
    `  Updated ${timeAgo}${labelsText}`;
}

/**
 * Formats an issue for display (legacy, uses old GitHubIssue type)
 */
function formatIssue(issue: GitHubIssue): string {
  const repo = extractRepoName(issue);
  const labels = issue.labels?.map(l => `\`${l.name}\``).join(", ") || "";
  const labelsText = labels ? ` • ${labels}` : "";

  const updated = new Date(issue.updated_at);
  const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
  const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;

  return `• 🐛 **[${repo}#${issue.number}](${issue.html_url})**: ${issue.title}\n` +
    `  Updated ${timeAgo}${labelsText}`;
}

/**
 * Registers the GitHub todos tool with the MCP server
 */
export function registerGithubTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-github-todos",
    {
      title: "List GitHub Todos",
      description: "Get pull requests and issues assigned to you from GitHub. Use this when the user asks about their GitHub tasks, PRs, code reviews, or issues.",
      inputSchema: githubTodosInputSchema,
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

      try {
        // Exchange user's JWT for a GitHub access token
        const tokenResponse = await keycardClient.exchange(
          authInfo,
          GITHUB_RESOURCE,
          GITHUB_SCOPES
        );

        const includePRs = args.includePRs !== false; // default true
        const includeIssues = args.includeIssues !== false; // default true
        const limit = args.limit || 10;

        // Fetch PRs and issues using utility function
        const { prs, issues } = await fetchGitHubTodos(tokenResponse.access_token);

        // Apply limit parameter
        const limitedPRs = prs.slice(0, limit);
        const limitedIssues = issues.slice(0, limit);

        const outputParts: string[] = [];
        let hasItems = false;

        // Fetch PRs
        if (includePRs) {
          // Separate PRs by type
          const reviewRequested = limitedPRs.filter(pr => pr.type === "review");
          const assigned = limitedPRs.filter(pr => pr.type === "assigned");

          // Show review-requested PRs first (usually more urgent)
          if (reviewRequested.length > 0) {
            hasItems = true;
            outputParts.push(`## 👀 Pull Requests Requesting Review (${reviewRequested.length})\n\n`);
            for (const pr of reviewRequested) {
              outputParts.push(formatPRDetail(pr));
              outputParts.push("\n");
            }
            outputParts.push("\n");
          }

          // Then show assigned PRs
          if (assigned.length > 0) {
            hasItems = true;
            outputParts.push(`## 🔀 Assigned Pull Requests (${assigned.length})\n\n`);
            for (const pr of assigned) {
              outputParts.push(formatPRDetail(pr));
              outputParts.push("\n");
            }
            outputParts.push("\n");
          }
        }

        // Fetch Issues
        if (includeIssues) {
          if (limitedIssues.length > 0) {
            hasItems = true;
            outputParts.push(`## 🐛 Assigned Issues (${limitedIssues.length})\n\n`);
            for (const issue of limitedIssues) {
              outputParts.push(formatIssueDetail(issue));
              outputParts.push("\n");
            }
          }
        }

        if (!hasItems) {
          return {
            content: [{
              type: "text",
              text: "✅ No GitHub PRs or issues assigned to you right now. Nice work! 🎉"
            }]
          };
        }

        const output = `🔷 **Your GitHub Todos**\n\n${outputParts.join("")}`;

        return {
          content: [{
            type: "text",
            text: output
          }]
        };

      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const normalizedMessage = message.toLowerCase();
        const isInvalidGrant = normalizedMessage.includes("invalid_grant")
          || normalizedMessage.includes("not allowed to exchange token");
        const isInvalidTarget = normalizedMessage.includes("invalid_target")
          || normalizedMessage.includes("unknown resource");
        const isServerError = normalizedMessage.includes("server_error")
          || normalizedMessage.includes("500")
          || normalizedMessage.includes("internal server error");

        // Extract requestId if present for debugging
        let requestId = "";
        try {
          const errorJson = message.match(/\{.*\}/)?.[0];
          if (errorJson) {
            const parsed = JSON.parse(errorJson) as { requestId?: string };
            requestId = parsed.requestId ? `\n\n🔍 Request ID: ${parsed.requestId}` : "";
          }
        } catch {
          // Ignore JSON parsing errors
        }

        if (isInvalidTarget) {
          return {
            content: [{
              type: "text",
              text: [
                `❌ Error: ${message}`,
                "",
                "🔍 **Diagnosis**: The GitHub resource is not registered in your Keycard zone.",
                "",
                "**To fix this:**",
                "",
                "1. **Add GitHub as a Credential Provider** in your Keycard zone:",
                "   - Go to Keycard Console → Your Zone → Credential Providers",
                "   - Add GitHub OAuth App credentials",
                "",
                "2. **Configure Token Exchange Permissions** for your Keycard client:",
                "   - Go to Keycard Console → Your Zone → Clients",
                "   - Select your client (KEYCARD_CLIENT_ID)",
                "   - Enable token exchange",
                "   - Add resource permission:",
                `     • Resource: ${GITHUB_RESOURCE}`,
                `     • Scopes: ${GITHUB_SCOPES.join(", ")}`,
                "",
                "3. **Verify your GitHub OAuth App** is configured correctly:",
                "   - GitHub Settings → Developer settings → OAuth Apps",
                "   - Ensure the app has the required scopes:",
                `     • ${GITHUB_SCOPES.join("\n     • ")}`,
                "",
                "4. **Check environment variables**:",
                "   - Verify KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET are set",
                "   - Ensure KEYCARD_STS_ISSUER_URL matches your zone",
                requestId
              ].join("\n")
            }]
          };
        }

        if (isServerError) {
          return {
            content: [{
              type: "text",
              text: [
                `❌ Error: ${message}`,
                "",
                "🔍 **Diagnosis**: The Keycard server encountered an internal error during token exchange.",
                "",
                "**Possible causes and fixes:**",
                "",
                "1. **Credential Provider Configuration Issue**:",
                "   - Verify GitHub OAuth App credentials in Keycard Console",
                "   - Check that Client ID and Client Secret are correct",
                "   - Ensure the GitHub OAuth App is active and not revoked",
                "",
                "2. **Token Exchange Configuration**:",
                "   - Verify your Keycard client has token exchange enabled",
                "   - Confirm resource permission is correctly configured:",
                `     • Resource: ${GITHUB_RESOURCE}`,
                `     • Scopes: ${GITHUB_SCOPES.join(", ")}`,
                "",
                "3. **GitHub OAuth App Issues**:",
                "   - Check GitHub OAuth App status in GitHub Settings",
                "   - Verify callback URLs are configured correctly",
                "   - Ensure the app hasn't been deleted or suspended",
                "",
                "4. **Temporary Server Issue**:",
                "   - Wait a few minutes and try again",
                "   - Check Keycard Console for service status",
                "",
                "5. **Check Logs**:",
                "   - Review Keycard Console logs for more details",
                "   - Check server logs for additional error context",
                requestId
              ].join("\n")
            }]
          };
        }

        if (isInvalidGrant) {
          return {
            content: [{
              type: "text",
              text: [
                `❌ Error: ${message}`,
                "",
                "Possible fixes:",
                "- Verify KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET are set for this server.",
                "- Confirm the Keycard client is allowed to exchange tokens for:",
                `  resource: ${GITHUB_RESOURCE}`,
                `  scope: ${GITHUB_SCOPES.join(" ")}`,
                "- Ensure the Keycard issuer/zone matches the one that issued your MCP token.",
                requestId
              ].join("\n")
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `❌ Error: ${message}${requestId}`
          }]
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof githubTodosInputSchema>
  );
}
