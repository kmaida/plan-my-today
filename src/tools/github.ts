import { z } from "zod/v3";
import { exchangeToken } from "../services/keycard-client";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";
import { fetchGitHubTodos } from "./today-todos/github-utils";
import type { GitHubIssueDetail, GitHubPRDetail } from "./today-todos/types";

const GITHUB_RESOURCE = "https://api.github.com";

/**
 * Input schema for the list-github-todos tool
 */
const githubTodosInputSchema = {
  includePRs: z
    .boolean()
    .describe("Include pull requests assigned to you or requesting your review (default: true)")
    .optional(),
  includeIssues: z.boolean().describe("Include issues assigned to you (default: true)").optional(),
  limit: z
    .number()
    .describe("Maximum number of items to return per category (default: 10)")
    .optional(),
};

/**
 * Formats a time-ago string from a date
 */
function formatTimeAgo(dateStr: string): string {
  const updated = new Date(dateStr);
  const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
  if (daysAgo === 0) return "today";
  if (daysAgo === 1) return "yesterday";
  return `${daysAgo} days ago`;
}

/**
 * Formats a PR detail for display
 */
function formatPRDetail(pr: GitHubPRDetail): string {
  const draft = pr.isDraft ? "📝 [DRAFT] " : "";
  const emoji = pr.isReviewRequested ? "👀" : "🔀";
  const label = pr.isReviewRequested ? "Review requested" : "Assigned";

  return (
    `• ${emoji} **${draft}[${pr.repo}#${pr.number}](${pr.url})**: ${pr.title}\n` +
    `  ${label} • Updated ${formatTimeAgo(pr.updatedAt)}`
  );
}

/**
 * Formats an issue detail for display
 */
function formatIssueDetail(issue: GitHubIssueDetail): string {
  const labels = issue.labels?.map((l) => `\`${l}\``).join(", ") || "";
  const labelsText = labels ? ` • ${labels}` : "";

  return (
    `• 🐛 **[${issue.repo}#${issue.number}](${issue.url})**: ${issue.title}\n` +
    `  Updated ${formatTimeAgo(issue.updatedAt)}${labelsText}`
  );
}

/**
 * Registers the GitHub todos tool with the MCP server
 */
export function registerGithubTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-github-todos",
    {
      title: "List GitHub Todos",
      description:
        "Get pull requests and issues assigned to you from GitHub. Use this when the user asks about their GitHub tasks, PRs, code reviews, or issues.",
      inputSchema: githubTodosInputSchema,
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: MCP tool handler — auth, API call, response formatting
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [
            {
              type: "text",
              text: "❌ No authentication information available. Please ensure you're properly authenticated.",
            },
          ],
          isError: true,
        };
      }

      try {
        // Exchange user's JWT for a GitHub access token
        const tokenResponse = await exchangeToken(authInfo, GITHUB_RESOURCE);

        const includePRs = args.includePRs !== false; // default true
        const includeIssues = args.includeIssues !== false; // default true
        const limit = args.limit || 10;

        // Fetch PRs and issues using shared utility
        const { prs, issues } = await fetchGitHubTodos(tokenResponse.accessToken);

        // Apply limit parameter
        const limitedPRs = prs.slice(0, limit);
        const limitedIssues = issues.slice(0, limit);

        const outputParts: string[] = [];
        let hasItems = false;

        // Fetch PRs
        if (includePRs) {
          // Separate PRs by relationship flag
          const reviewRequested = limitedPRs.filter((pr) => pr.isReviewRequested);
          const assigned = limitedPRs.filter((pr) => !pr.isReviewRequested && pr.isAssigned);

          // Show review-requested PRs first (usually more urgent)
          if (reviewRequested.length > 0) {
            hasItems = true;
            outputParts.push(
              `## 👀 Pull Requests Requesting Review (${reviewRequested.length})\n\n`
            );
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
            content: [
              {
                type: "text",
                text: "✅ No GitHub PRs or issues assigned to you right now. Nice work! 🎉",
              },
            ],
          };
        }

        const output = `🔷 **Your GitHub Todos**\n\n${outputParts.join("")}`;

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, "github", GITHUB_RESOURCE, []);
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof githubTodosInputSchema>
  );
}
