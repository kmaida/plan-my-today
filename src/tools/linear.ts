import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod";
import { stsClient } from "../services/sts-client";

const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];

const linearIssuesInputSchema = {
  includeCompleted: z.boolean()
    .describe("Include completed issues (default: false)")
    .optional(),
  limit: z.number()
    .describe("Maximum number of issues to return (default: 20)")
    .optional(),
};

/**
 * Fetches issues assigned to the authenticated user from Linear
 */
async function fetchMyIssues(
  accessToken: string,
  includeCompleted: boolean,
  limit: number
): Promise<LinearIssuesResponse> {
  const query = `
    query MyIssues($first: Int, $filter: IssueFilter) {
      viewer {
        assignedIssues(first: $first, filter: $filter) {
          nodes {
            id
            identifier
            title
            description
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
            team {
              name
            }
            createdAt
            updatedAt
          }
        }
      }
    }
  `;

  // Filter out completed issues unless explicitly requested
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
    const error = await response.text();
    throw new Error(`Linear API error: ${response.status} - ${error}`);
  }

  return await response.json() as LinearIssuesResponse;
}

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
  
  const due = new Date(dueDate);
  const now = new Date();
  const daysUntilDue = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  
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
      description: "Get issues assigned to you from Linear. Use this when the user asks about their tasks, issues, tickets, work items, or what they need to work on.",
      inputSchema: linearIssuesInputSchema,
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
        // Exchange user's JWT for a Linear access token
        const tokenResponse = await stsClient.exchange(
          authInfo,
          LINEAR_RESOURCE,
          LINEAR_SCOPES
        );

        const includeCompleted = args.includeCompleted ?? false;
        const limit = args.limit ?? 20;

        const data = await fetchMyIssues(
          tokenResponse.access_token,
          includeCompleted,
          limit
        );

        const issues = data.data?.viewer?.assignedIssues?.nodes || [];

        if (issues.length === 0) {
          return {
            content: [{
              type: "text",
              text: "📋 No issues assigned to you right now. Nice work! 🎉"
            }]
          };
        }

        // Group issues by state type for better organization
        const byState: Record<string, LinearIssue[]> = {};
        for (const issue of issues) {
          const stateType = issue.state?.type || "unknown";
          if (!byState[stateType]) {
            byState[stateType] = [];
          }
          byState[stateType].push(issue);
        }

        // Format output
        let output = `📋 **Your Linear Issues** (${issues.length}):\n\n`;

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

          output += `### ${stateLabels[stateType] || stateType}\n\n`;

          for (const issue of stateIssues) {
            const priority = formatPriority(issue.priority, issue.priorityLabel);
            const dueDate = formatDueDate(issue.dueDate);
            const estimate = issue.estimate ? `[${issue.estimate}pts]` : "";
            const project = issue.project?.name ? `(${issue.project.name})` : "";

            output += `• **${issue.identifier}**: ${issue.title}\n`;
            output += `  ${priority} ${estimate} ${project}\n`;
            if (dueDate) {
              output += `  ${dueDate}\n`;
            }
            output += `  🔗 ${issue.url}\n`;
            output += `\n`;
          }
        }

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
                `  resource: ${LINEAR_RESOURCE}`,
                `  scope: ${LINEAR_SCOPES.join(" ")}`,
                "- Ensure the STS issuer/zone matches the one that issued your MCP token."
              ].join("\n")
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `❌ Error: ${message}`
          }]
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof linearIssuesInputSchema>
  );
}

// Type definitions for Linear API responses
interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  url: string;
  state: {
    name: string;
    type: string;
  } | null;
  dueDate: string | null;
  estimate: number | null;
  project: {
    name: string;
  } | null;
  team: {
    name: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface LinearIssuesResponse {
  data?: {
    viewer?: {
      assignedIssues?: {
        nodes: LinearIssue[];
      };
    };
  };
  errors?: Array<{ message: string }>;
}
