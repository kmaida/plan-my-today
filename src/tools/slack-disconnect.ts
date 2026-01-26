import type { McpServer, AuthenticatedToolHandlerNoArgs } from "../types/index";
import * as slackTokenStore from "../services/slack-token-store";
import { extractUserIdFromAuthInfo } from "../utils/auth-utils";

export function registerSlackDisconnectTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "disconnect-slack",
    {
      title: "Disconnect Slack Account",
      description: "Remove Slack connection and stop fetching reminders.",
    },
    async ({ authInfo }: AuthenticatedToolHandlerNoArgs) => {
      if (!authInfo) {
        return {
          content: [{ type: "text", text: "❌ No authentication available" }]
        };
      }

      try {
        const userId = extractUserIdFromAuthInfo(authInfo);
        const hasToken = await slackTokenStore.hasToken(userId);

        if (!hasToken) {
          return {
            content: [{
              type: "text",
              text: "ℹ️ Slack is not connected."
            }]
          };
        }

        await slackTokenStore.deleteToken(userId);

        return {
          content: [{
            type: "text",
            text: "✅ Slack disconnected successfully. Use 'connect-slack' to reconnect."
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
