import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../../types/index";
import { z } from "zod";
import { stsClient } from "../../services/sts-client";
import { fetchTodayCalendarEvents } from "../today-todos/calendar-utils";
import { fetchLinearIssues } from "../today-todos/linear-utils";
import { fetchGmailTodos } from "../today-todos/email-utils";
import { fetchAssignedActions } from "../today-todos/docs-utils";
import { fetchGitHubTodos } from "../today-todos/github-utils";
import { fetchSlackMessages } from "../today-todos/slack-utils";
import { config } from "../../config";
import { formatAuthError, getErrorFooter } from "../../utils/error-utils";
import * as slackTokenStore from "../../services/slack-token-store";
import { extractUserIdFromAuthInfo } from "../../utils/auth-utils";

const CALENDAR_RESOURCE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];
const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];
const GITHUB_RESOURCE = "https://api.github.com";
const GITHUB_SCOPES = ["repo", "read:org"];

/**
 * Input schema for the list-all-tasks-today tool
 */
const listAllTasksTodayInputSchema = {
  includeGithub: z.boolean()
    .describe("Include GitHub PRs and issues (default: true)")
    .optional(),
};

/**
 * Registers the list-all-tasks-today tool with the MCP server
 *
 * This tool aggregates raw data from multiple sources without any intelligence or scheduling:
 * - Calendar events for today
 * - Linear issues
 * - Gmail emails (unread/starred)
 * - Assigned actions from Google Docs
 * - GitHub PRs and issues
 * - Slack messages
 *
 * Returns structured JSON data grouped by source for use by agents or other tools.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerListAllTasksTodayTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-all-tasks-today",
    {
      title: "List All Tasks Today (Raw Data)",
      description: "Fetch all tasks, events, and items for today from multiple sources, returning raw structured data grouped by source. This tool provides data only - no intelligence, scheduling, or formatting. Use this when you need raw data to analyze or plan with. Sources: Calendar, Linear, Gmail, Google Docs, GitHub, Slack.",
      inputSchema: listAllTasksTodayInputSchema,
    },
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "No authentication information available",
              message: "Please ensure you're properly authenticated."
            }, null, 2)
          }]
        };
      }

      const includeGithub = args.includeGithub ?? true;
      const today = new Date();
      const errors: string[] = [];

      // Initialize data containers
      let calendarEvents: any[] = [];
      let linearIssues: any[] = [];
      let gmailTodos: any[] = [];
      let assignedActions: any[] = [];
      let githubPRs: any[] = [];
      let githubIssues: any[] = [];
      let slackMessages: any[] = [];

      // Fetch Calendar events
      try {
        const calendarToken = await stsClient.exchange(
          authInfo,
          CALENDAR_RESOURCE,
          CALENDAR_SCOPES
        );
        calendarEvents = await fetchTodayCalendarEvents(calendarToken.access_token);
      } catch (error) {
        errors.push(formatAuthError("Google Calendar", error));
      }

      // Fetch Linear issues (with 7-day window for due dates)
      try {
        const sevenDaysFromNow = new Date(today);
        sevenDaysFromNow.setDate(today.getDate() + 7);
        sevenDaysFromNow.setHours(23, 59, 59, 999);

        const linearToken = await stsClient.exchange(
          authInfo,
          LINEAR_RESOURCE,
          LINEAR_SCOPES
        );
        linearIssues = await fetchLinearIssues(linearToken.access_token, sevenDaysFromNow);
      } catch (error) {
        errors.push(formatAuthError("Linear", error));
      }

      // Fetch Gmail todos
      try {
        const gmailToken = await stsClient.exchange(
          authInfo,
          GMAIL_RESOURCE,
          GMAIL_SCOPES
        );
        gmailTodos = await fetchGmailTodos(gmailToken.access_token);
      } catch (error) {
        errors.push(formatAuthError("Gmail", error));
      }

      // Fetch assigned actions from Google Docs
      try {
        const driveActivityToken = await stsClient.exchange(
          authInfo,
          DRIVE_ACTIVITY_RESOURCE,
          DRIVE_ACTIVITY_SCOPES
        );
        assignedActions = await fetchAssignedActions(driveActivityToken.access_token);
      } catch (error) {
        errors.push(formatAuthError("Google Drive Activity", error));
      }

      // Fetch GitHub PRs and issues
      if (includeGithub) {
        try {
          const githubToken = await stsClient.exchange(
            authInfo,
            GITHUB_RESOURCE,
            GITHUB_SCOPES
          );
          const githubData = await fetchGitHubTodos(githubToken.access_token);
          githubPRs = githubData.prs;
          githubIssues = githubData.issues;
        } catch (error) {
          errors.push(formatAuthError("GitHub", error));
        }
      }

      // Fetch Slack messages
      try {
        let slackToken: string | null = null;

        // Check for environment variable token first (single-user deployment)
        if (config.slackUserToken) {
          slackToken = config.slackUserToken;
        } else {
          // Fall back to token store (multi-user OAuth flow)
          const userId = extractUserIdFromAuthInfo(authInfo);
          const storedToken = await slackTokenStore.getToken(userId);
          if (storedToken) {
            slackToken = storedToken.access_token;
          }
        }

        if (slackToken) {
          slackMessages = await fetchSlackMessages(slackToken);
        }
      } catch (error) {
        errors.push(formatAuthError("Slack", error));
      }

      // Build response data
      const responseData = {
        calendar: calendarEvents,
        linear: linearIssues,
        gmail: gmailTodos,
        docs: assignedActions,
        github: {
          prs: githubPRs,
          issues: githubIssues
        },
        slack: slackMessages,
        metadata: {
          fetched_at: new Date().toISOString(),
          date: today.toISOString(),
          errors: errors.length > 0 ? errors : undefined
        }
      };

      // Return JSON string
      return {
        content: [{
          type: "text",
          text: JSON.stringify(responseData, null, 2)
        }]
      };
    }) as AuthenticatedToolHandlerWithArgs<typeof listAllTasksTodayInputSchema>
  );
}
