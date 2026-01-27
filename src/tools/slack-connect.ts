import type { McpServer, AuthenticatedToolHandlerNoArgs } from "../types/index";
import * as slackTokenStore from "../services/slack-token-store";
import { extractUserIdFromAuthInfo } from "../utils/auth-utils";
import { config } from "../config";
import { generateOAuthUrl } from "../services/slack-oauth";

export function registerSlackConnectTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "connect-slack",
    {
      title: "Connect Slack Account",
      description: "Authenticate with Slack to access your recent @mentions and DMs. Opens OAuth flow in browser.",
    },
    async ({ authInfo }: AuthenticatedToolHandlerNoArgs) => {
      if (!authInfo) {
        return {
          content: [{ type: "text", text: "❌ No authentication available" }]
        };
      }

      if (!config.slackClientId || !config.slackClientSecret) {
        return {
          content: [{
            type: "text",
            text: "❌ Slack integration not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET environment variables."
          }]
        };
      }

      try {
        const userId = extractUserIdFromAuthInfo(authInfo);
        const hasToken = await slackTokenStore.hasToken(userId);

        if (hasToken) {
          return {
            content: [{
              type: "text",
              text: "✅ Already connected to Slack! Use 'disconnect-slack' to reset."
            }]
          };
        }

        // Generate the Slack OAuth URL directly (includes state parameter with userId)
        const oauthUrl = generateOAuthUrl(userId);

        return {
          content: [{
            type: "text",
            text: `🔗 **Connect Slack**\n\nClick here to authorize access to your Slack messages:\n\n${oauthUrl}\n\nAfter authorization, your recent @mentions and DMs will be included in 'list-all-tasks-today' with priority metadata for intelligent agent-based planning.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }]
        };
      }
    }
  );
}
