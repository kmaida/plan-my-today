import { z } from "zod/v3";
import { keycardClient } from "../services/keycard-client";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";
import { fetchGmailTodos } from "./today-todos/email-utils";
import type { GmailMessageDetail } from "./today-todos/types";

const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * Input schema for the list-gmail-todos tool
 */
const gmailTodosInputSchema = {
  maxResults: z.number().describe("Maximum number of emails to return (default: 20)").optional(),
  daysBack: z.number().describe("Number of days to look back (default: 7)").optional(),
  includeUnread: z.boolean().describe("Include unread emails (default: true)").optional(),
  includeImportant: z.boolean().describe("Include important emails (default: true)").optional(),
  includeNeedsReply: z
    .boolean()
    .describe("Include emails that likely need a reply (default: true)")
    .optional(),
  searchQuery: z
    .string()
    .describe("Custom Gmail search query (e.g., 'is:unread from:example@email.com')")
    .optional(),
};

/**
 * Formats email date for display
 */
function formatEmailDate(timestamp: number | undefined): string {
  if (!timestamp) return "Unknown date";
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return "Today";
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
}

/**
 * Registers the list-gmail-todos tool with the MCP server
 *
 * This tool queries Gmail to find emails that might be todos, need replies, or need attention.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerGmailTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-gmail-todos",
    {
      title: "List Gmail Todos",
      description:
        "Get emails from Gmail that might be todos, need replies, or need attention. Use this when the user asks about their email, emails they need to reply to, or emails they need to catch up on.",
      inputSchema: gmailTodosInputSchema,
    },
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
        // Exchange user's JWT for a Gmail access token
        const tokenResponse = await keycardClient.exchange(authInfo, GMAIL_RESOURCE, GMAIL_SCOPES);

        const maxResults = args.maxResults || 20;
        const daysBack = args.daysBack || 7;
        const _includeUnread = args.includeUnread ?? true;
        const includeImportant = args.includeImportant ?? true;
        const includeNeedsReply = args.includeNeedsReply ?? true;

        // TODO: Support custom searchQuery parameter
        // The utility function uses a fixed query, so custom queries aren't supported yet

        // Fetch emails using utility function (ignore doc comment emails in standalone tool)
        const { emails } = await fetchGmailTodos(tokenResponse.access_token, {
          daysBack,
          maxResults,
          includeRead: false, // Tool focuses on unread/starred
          strictFiltering: true, // Apply newsletter/low-priority filtering
        });

        if (emails.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `📧 No emails found matching your criteria in the last ${daysBack} days.`,
              },
            ],
          };
        }

        // Categorize emails based on metadata from utility
        const todos: GmailMessageDetail[] = [];
        const needsReplyList: GmailMessageDetail[] = [];
        const important: GmailMessageDetail[] = [];
        const _unread: GmailMessageDetail[] = [];

        for (const email of emails) {
          // Use metadata from utility function
          if (includeNeedsReply && email.needsReply) {
            needsReplyList.push(email);
          }
          if (email.hasActionItems) {
            todos.push(email);
          }
          if (includeImportant && email.isImportant) {
            important.push(email);
          }
          // Note: We don't track unread separately since the utility already filters to unread/starred
        }

        // Build output
        const lines: string[] = [`📧 **Gmail - Emails Needing Attention**\n`];

        if (todos.length > 0) {
          lines.push(`📋 **Potential Todos** (${todos.length}):\n`);
          for (const email of todos) {
            const date = formatEmailDate(email.timestamp);

            lines.push(`• **${email.subject}**`);
            lines.push(`  From: ${email.from}`);
            lines.push(`  ${date} | 🔗 ${email.link}\n`);
          }
        }

        if (needsReplyList.length > 0) {
          lines.push(`💬 **Needs Action** (${needsReplyList.length}):\n`);
          for (const email of needsReplyList.slice(0, 10)) {
            const date = formatEmailDate(email.timestamp);

            lines.push(`• **${email.subject}**`);
            lines.push(`  From: ${email.from}`);
            lines.push(`  ${date} | 🔗 ${email.link}\n`);
          }
        }

        if (important.length > 0) {
          lines.push(`⭐ **Important** (${important.length}):\n`);
          for (const email of important.slice(0, 10)) {
            const date = formatEmailDate(email.timestamp);

            lines.push(`• **${email.subject}**`);
            lines.push(`  From: ${email.from}`);
            lines.push(`  ${date} | 🔗 ${email.link}\n`);
          }
        }

        // Show all emails if no specific categories matched
        if (todos.length === 0 && needsReplyList.length === 0 && important.length === 0) {
          lines.push(`📬 **All Emails** (${emails.length}):\n`);
          for (const email of emails.slice(0, 10)) {
            const date = formatEmailDate(email.timestamp);

            lines.push(`• **${email.subject}**`);
            lines.push(`  From: ${email.from}`);
            lines.push(`  ${date} | 🔗 ${email.link}\n`);
          }
        }

        let output = lines.join("\n");
        if (output === `📧 **Gmail - Emails Needing Attention**\n\n`) {
          output += "No emails found matching the criteria.";
        }

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, GMAIL_RESOURCE, GMAIL_SCOPES, [
          "Ensure your Gmail credential provider is configured in Keycard.",
        ]);
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof gmailTodosInputSchema>
  );
}
