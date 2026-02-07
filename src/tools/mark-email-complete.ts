import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod/v3";
import { stsClient } from "../services/sts-client";
import { markEmailComplete, unmarkEmailComplete } from "../services/gmail-label-service";

const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

/**
 * Input schema for the mark-email-complete tool
 */
const markEmailCompleteInputSchema = {
  emailId: z.string()
    .describe("The Gmail message ID to mark as complete"),
  complete: z.boolean()
    .describe("Set to true to mark as complete, false to unmark (default: true)")
    .optional(),
};

/**
 * Registers the mark-email-complete tool with the MCP server
 *
 * This tool marks an email as complete by adding the "Complete" label,
 * which excludes it from future todo lists.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerMarkEmailCompleteTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "mark-email-complete",
    {
      title: "Mark Email Complete",
      description: "Mark an email as complete by adding the 'Complete' label. This removes the email from your Gmail todo list. Use this when you've finished handling an email (replied, delegated, or no action needed).",
      inputSchema: markEmailCompleteInputSchema,
    },
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [{
            type: "text",
            text: "No authentication information available. Please ensure you're properly authenticated."
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

        const shouldComplete = args.complete ?? true;

        if (shouldComplete) {
          await markEmailComplete(tokenResponse.access_token, args.emailId);
          return {
            content: [{
              type: "text",
              text: `Email marked as complete. It will no longer appear in your Gmail todo list.`
            }]
          };
        } else {
          await unmarkEmailComplete(tokenResponse.access_token, args.emailId);
          return {
            content: [{
              type: "text",
              text: `Email unmarked as complete. It will now appear in your Gmail todo list again.`
            }]
          };
        }

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
                `Error: ${message}`,
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
            text: `Error: ${message}`
          }]
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof markEmailCompleteInputSchema>
  );
}
