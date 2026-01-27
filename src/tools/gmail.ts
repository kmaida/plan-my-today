import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod";
import { stsClient } from "../services/sts-client";

const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * Input schema for the list-gmail-todos tool
 */
const gmailTodosInputSchema = {
  maxResults: z.number()
    .describe("Maximum number of emails to return (default: 20)")
    .optional(),
  daysBack: z.number()
    .describe("Number of days to look back (default: 7)")
    .optional(),
  includeUnread: z.boolean()
    .describe("Include unread emails (default: true)")
    .optional(),
  includeImportant: z.boolean()
    .describe("Include important emails (default: true)")
    .optional(),
  includeNeedsReply: z.boolean()
    .describe("Include emails that likely need a reply (default: true)")
    .optional(),
  searchQuery: z.string()
    .describe("Custom Gmail search query (e.g., 'is:unread from:example@email.com')")
    .optional(),
};

/**
 * Gmail API response types
 */
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string };
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    }>;
    body?: { data?: string };
  };
  internalDate?: string;
}

interface GmailMessagesResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

/**
 * Extracts header value from message
 */
function getHeader(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value;
}

/**
 * Formats email date
 */
function formatEmailDate(timestamp: string | undefined): string {
  if (!timestamp) return "Unknown date";
  const date = new Date(parseInt(timestamp));
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
 * Determines if an email likely needs a reply
 */
function needsReply(message: GmailMessage, userEmail: string): boolean {
  // Check if email is to the user (not from them)
  const from = getHeader(message.payload?.headers, "from");
  const to = getHeader(message.payload?.headers, "to");
  
  // If it's sent TO the user (and not from them), it might need a reply
  if (to && to.toLowerCase().includes(userEmail.toLowerCase()) && 
      from && !from.toLowerCase().includes(userEmail.toLowerCase())) {
    // Check if it's unread or important
    const isUnread = message.labelIds?.includes("UNREAD");
    const isImportant = message.labelIds?.includes("IMPORTANT");
    return isUnread || isImportant || false;
  }
  
  return false;
}

/**
 * Checks if email contains todo-related keywords
 */
function containsTodoKeywords(snippet: string | undefined, subject: string | undefined): boolean {
  if (!snippet && !subject) return false;
  const text = `${subject || ""} ${snippet || ""}`.toLowerCase();
  const todoKeywords = [
    "todo", "action", "follow up", "follow-up", "please", "can you", "could you",
    "need", "required", "urgent", "asap", "deadline", "due", "reminder"
  ];
  return todoKeywords.some(keyword => text.includes(keyword));
}

/**
 * Fetches Gmail messages based on query
 */
async function fetchGmailMessages(
  accessToken: string,
  query: string,
  maxResults: number
): Promise<GmailMessagesResponse> {
  const response = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?` +
    new URLSearchParams({
      q: query,
      maxResults: maxResults.toString(),
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  return await response.json() as GmailMessagesResponse;
}

/**
 * Fetches a single Gmail message by ID
 */
async function fetchGmailMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const response = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  return await response.json() as GmailMessage;
}

/**
 * Fetches user's Gmail profile to get email address
 */
async function fetchGmailProfile(accessToken: string): Promise<GmailProfile> {
  const response = await fetch(
    "https://www.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  return await response.json() as GmailProfile;
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
      description: "Get emails from Gmail that might be todos, need replies, or need attention. Use this when the user asks about their email, emails they need to reply to, or emails they need to catch up on.",
      inputSchema: gmailTodosInputSchema,
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
        // Exchange user's JWT for a Gmail access token
        const tokenResponse = await stsClient.exchange(
          authInfo,
          GMAIL_RESOURCE,
          GMAIL_SCOPES
        );

        // Get user's email address
        const profile = await fetchGmailProfile(tokenResponse.access_token);

        const maxResults = args.maxResults || 20;
        const daysBack = args.daysBack || 7;
        const includeUnread = args.includeUnread ?? true;
        const includeImportant = args.includeImportant ?? true;
        const includeNeedsReply = args.includeNeedsReply ?? true;

        // Build Gmail search query
        const dateFilter = new Date();
        dateFilter.setDate(dateFilter.getDate() - daysBack);
        const afterDate = Math.floor(dateFilter.getTime() / 1000);

        let query = `after:${afterDate}`;

        if (args.searchQuery) {
          // Use custom query if provided
          query = args.searchQuery;
        } else {
          // Build query based on options
          const queryParts: string[] = [];

          if (includeUnread) {
            queryParts.push("is:unread");
          }

          if (includeImportant) {
            queryParts.push("is:important");
          }

          // Combine with date filter
          if (queryParts.length > 0) {
            query = `${queryParts.join(" OR ")} after:${afterDate}`;
          }
        }

        // Fetch messages
        const messagesResponse = await fetchGmailMessages(
          tokenResponse.access_token,
          query,
          maxResults
        );

        if (!messagesResponse.messages || messagesResponse.messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `📧 No emails found matching your criteria in the last ${daysBack} days.`
            }]
          };
        }

        // Fetch full message details
        const messagePromises = messagesResponse.messages.slice(0, maxResults).map(msg =>
          fetchGmailMessage(tokenResponse.access_token, msg.id)
        );
        const messages = await Promise.all(messagePromises);

        // Filter and categorize messages
        const todos: GmailMessage[] = [];
        const needsReplyList: GmailMessage[] = [];
        const important: GmailMessage[] = [];
        const unread: GmailMessage[] = [];

        for (const message of messages) {
          const subject = getHeader(message.payload?.headers, "subject") || "(No subject)";
          const from = getHeader(message.payload?.headers, "from") || "Unknown";
          const snippet = message.snippet || "";

          // Categorize
          if (message.labelIds?.includes("UNREAD")) {
            unread.push(message);
          }
          if (message.labelIds?.includes("IMPORTANT")) {
            important.push(message);
          }
          if (includeNeedsReply && needsReply(message, profile.emailAddress)) {
            needsReplyList.push(message);
          }
          if (containsTodoKeywords(snippet, subject)) {
            todos.push(message);
          }
        }

        // Build output
        const lines: string[] = [`📧 **Gmail - Emails Needing Attention**\n`];

        if (todos.length > 0) {
          lines.push(`📋 **Potential Todos** (${todos.length}):\n`);
          for (const message of todos) {
            const subject = getHeader(message.payload?.headers, "subject") || "(No subject)";
            const from = getHeader(message.payload?.headers, "from") || "Unknown";
            const date = formatEmailDate(message.internalDate);
            const link = `https://mail.google.com/mail/u/0/#inbox/${message.id}`;

            lines.push(`• **${subject}**`);
            lines.push(`  From: ${from}`);
            lines.push(`  ${date} | 🔗 ${link}\n`);
          }
        }

        if (needsReplyList.length > 0) {
          lines.push(`💬 **Needs Reply** (${needsReplyList.length}):\n`);
          for (const message of needsReplyList.slice(0, 10)) {
            const subject = getHeader(message.payload?.headers, "subject") || "(No subject)";
            const from = getHeader(message.payload?.headers, "from") || "Unknown";
            const date = formatEmailDate(message.internalDate);
            const link = `https://mail.google.com/mail/u/0/#inbox/${message.id}`;

            lines.push(`• **${subject}**`);
            lines.push(`  From: ${from}`);
            lines.push(`  ${date} | 🔗 ${link}\n`);
          }
        }

        if (unread.length > 0) {
          lines.push(`📬 **Unread** (${unread.length}):\n`);
          for (const message of unread.slice(0, 10)) {
            const subject = getHeader(message.payload?.headers, "subject") || "(No subject)";
            const from = getHeader(message.payload?.headers, "from") || "Unknown";
            const date = formatEmailDate(message.internalDate);
            const link = `https://mail.google.com/mail/u/0/#inbox/${message.id}`;

            lines.push(`• **${subject}**`);
            lines.push(`  From: ${from}`);
            lines.push(`  ${date} | 🔗 ${link}\n`);
          }
        }

        if (important.length > 0) {
          lines.push(`⭐ **Important** (${important.length}):\n`);
          for (const message of important.slice(0, 10)) {
            const subject = getHeader(message.payload?.headers, "subject") || "(No subject)";
            const from = getHeader(message.payload?.headers, "from") || "Unknown";
            const date = formatEmailDate(message.internalDate);
            const link = `https://mail.google.com/mail/u/0/#inbox/${message.id}`;

            lines.push(`• **${subject}**`);
            lines.push(`  From: ${from}`);
            lines.push(`  ${date} | 🔗 ${link}\n`);
          }
        }

        let output = lines.join('\n');
        if (output === `📧 **Gmail - Emails Needing Attention**\n\n`) {
          output += "No emails found matching the criteria.";
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
                `  resource: ${GMAIL_RESOURCE}`,
                `  scope: ${GMAIL_SCOPES.join(" ")}`,
                "- Ensure your Gmail credential provider is configured in Keycard.",
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
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof gmailTodosInputSchema>
  );
}
