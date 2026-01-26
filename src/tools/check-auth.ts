import type { McpServer, AuthenticatedToolHandlerNoArgs } from "../types/index";
import { stsClient } from "../services/sts-client";
import { config } from "../config";

const SERVICES = [
  {
    name: "Google Calendar",
    resource: "https://www.googleapis.com/calendar/v3",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  },
  {
    name: "Linear",
    resource: "https://api.linear.app",
    scopes: ["read"],
  },
  {
    name: "Gmail",
    resource: "https://www.googleapis.com/gmail/v1",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  },
  {
    name: "Google Docs",
    resource: "https://www.googleapis.com/drive/v3",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ],
  },
  {
    name: "GitHub",
    resource: "https://api.github.com",
    scopes: ["repo", "read:user"],
  },
];

export function registerCheckAuthTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "check-auth",
    {
      title: "Check Service Authentication",
      description: "Check which services are properly authenticated and which need reconnection. Run this if you're having authentication issues.",
    },
    async ({ authInfo }: AuthenticatedToolHandlerNoArgs) => {
      if (!authInfo) {
        return {
          content: [{
            type: "text",
            text: "❌ **No Authentication Available**\n\nThe MCP server is not receiving authentication from Claude Desktop.\n\n**To fix this:**\n1. Restart Claude Desktop\n2. Or check your Claude Desktop MCP configuration\n3. Make sure the server is running and accessible"
          }]
        };
      }

      const results: string[] = [];
      results.push("🔍 **Service Authentication Status**\n");

      // Check each service
      for (const service of SERVICES) {
        try {
          await stsClient.exchange(authInfo, service.resource, service.scopes);
          results.push(`✅ ${service.name} - Connected`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          results.push(`❌ ${service.name} - ${errorMsg}`);
        }
      }

      // Check Slack
      results.push("");
      if (config.slackUserToken) {
        results.push("✅ Slack - Connected (via SLACK_USER_TOKEN)");
      } else {
        results.push("⚠️  Slack - Not configured (set SLACK_USER_TOKEN or use connect-slack)");
      }

      results.push("\n**If services show as disconnected:**");
      results.push("1. Go to https://keycard.cloud and check your service connections");
      results.push("2. Re-authorize any disconnected services");
      results.push("3. Restart Claude Desktop to refresh the connection");
      results.push("4. Run this tool again to verify");

      return {
        content: [{ type: "text", text: results.join("\n") }]
      };
    }
  );
}
