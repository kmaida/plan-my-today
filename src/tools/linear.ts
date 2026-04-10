import { z } from "zod/v3";
import { exchangeToken } from "../services/keycard-client";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import { parseLocalDate } from "../utils/date-utils";
import { handleToolError } from "../utils/tool-error-utils";
import { fetchAllAssignedIssues, RELATION_LABELS } from "./today-todos/linear-utils";
import type { LinearIssueDetail } from "./today-todos/types";

const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];

const linearIssuesInputSchema = {
  includeCompleted: z.boolean().describe("Include completed issues (default: false)").optional(),
  limit: z.number().describe("Maximum number of issues to return (default: 20)").optional(),
};

/**
 * Formats a priority level into an emoji indicator
 */
function formatPriority(priority: number, priorityLabel: string): string {
  const priorityEmojis: Record<number, string> = {
    0: "⚪", // No priority
    1: "🔴", // Urgent
    2: "🟠", // High
    3: "🟡", // Medium
    4: "🟢", // Low
  };
  return `${priorityEmojis[priority] || "⚪"} ${priorityLabel}`;
}

/**
 * Formats a due date with urgency indicators
 */
function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return "";

  const due = parseLocalDate(dueDate);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const daysUntilDue = Math.round((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  let urgency = "";
  if (daysUntilDue < 0) {
    urgency = "⚠️ OVERDUE";
  } else if (daysUntilDue === 0) {
    urgency = "🔥 Due today";
  } else if (daysUntilDue === 1) {
    urgency = "⏰ Due tomorrow";
  } else if (daysUntilDue <= 7) {
    urgency = `📅 Due in ${daysUntilDue} days`;
  } else {
    urgency = `📅 Due ${due.toLocaleDateString()}`;
  }

  return urgency;
}

/**
 * Registers the Linear issues tool with the MCP server
 */
export function registerLinearTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-linear-issues",
    {
      title: "List Linear Issues",
      description:
        "Get issues assigned to you from Linear. Use this when the user asks about their tasks, issues, tickets, work items, or what they need to work on.",
      inputSchema: linearIssuesInputSchema,
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
        };
      }

      try {
        // Exchange user's JWT for a Linear access token
        const tokenResponse = await exchangeToken(
          authInfo,
          LINEAR_RESOURCE,
          LINEAR_SCOPES
        );

        const includeCompleted = args.includeCompleted ?? false;
        const limit = args.limit ?? 20;

        // Fetch issues using utility function
        const issues = await fetchAllAssignedIssues(tokenResponse.accessToken, {
          includeCompleted,
          limit,
        });

        if (issues.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "📋 No issues assigned to you right now. Nice work! 🎉",
              },
            ],
          };
        }

        // Group issues by state type for better organization
        const byState: Record<string, LinearIssueDetail[]> = {};
        for (const issue of issues) {
          const stateType = issue.state?.type || "unknown";
          if (!byState[stateType]) {
            byState[stateType] = [];
          }
          byState[stateType].push(issue);
        }

        // Format output
        const lines: string[] = [`📋 **Your Linear Issues** (${issues.length}):\n`];

        // Order: in progress first, then backlog/unstarted, then others
        const stateOrder = ["started", "unstarted", "backlog", "triage", "completed", "canceled"];
        const stateLabels: Record<string, string> = {
          started: "🔄 In Progress",
          unstarted: "📥 To Do",
          backlog: "📦 Backlog",
          triage: "🔍 Triage",
          completed: "✅ Completed",
          canceled: "❌ Canceled",
        };

        for (const stateType of stateOrder) {
          const stateIssues = byState[stateType];
          if (!stateIssues || stateIssues.length === 0) continue;

          lines.push(`### ${stateLabels[stateType] || stateType}\n`);

          for (const issue of stateIssues) {
            const priority = formatPriority(issue.priority, issue.priorityLabel);
            const dueDate = formatDueDate(issue.dueDate);
            const estimate = issue.estimate ? `[${issue.estimate}pts]` : "";
            const project = issue.project?.name ? `(${issue.project.name})` : "";

            lines.push(`• **${issue.identifier}**: ${issue.title}`);
            lines.push(`  ${priority} ${estimate} ${project}`);
            if (dueDate) {
              lines.push(`  ${dueDate}`);
            }
            // Relation context from Linear API
            if (issue.relationMetadata?.parent) {
              lines.push(`  ↑ Parent: ${issue.relationMetadata.parent.identifier}`);
            }
            const blockingRels =
              issue.relationMetadata?.relations.filter((r) => r.type === "blocks") ?? [];
            if (blockingRels.length > 0) {
              lines.push(
                `  ${RELATION_LABELS.blocks}: ${blockingRels.map((r) => r.relatedIssue.identifier).join(", ")}`
              );
            }
            const childCount = issue.relationMetadata?.children.length ?? 0;
            if (childCount > 0) {
              lines.push(`  ${childCount} sub-issue${childCount > 1 ? "s" : ""}`);
            }
            lines.push(`  🔗 ${issue.url}`);
            lines.push(""); // Empty line between issues
          }
        }

        const output = lines.join("\n");

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, LINEAR_RESOURCE, LINEAR_SCOPES);
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof linearIssuesInputSchema>
  );
}
