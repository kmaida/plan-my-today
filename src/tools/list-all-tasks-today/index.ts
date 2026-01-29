import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../../types/index";
import { z } from "zod";
import { stsClient } from "../../services/sts-client";
import { fetchTodayCalendarEvents, calculateCalendarPriority } from "../today-todos/calendar-utils";
import { fetchLinearIssues, calculateLinearPriority } from "../today-todos/linear-utils";
import { fetchGmailTodos, fetchMeetingSummaries, calculateEmailPriority, calculateMeetingSummaryPriority } from "../today-todos/email-utils";
import { fetchAssignedActions, calculateDocsPriority } from "../today-todos/docs-utils";
import { fetchGitHubTodos, calculateGitHubPriority } from "../today-todos/github-utils";
import { fetchSlackMessages, calculateSlackPriorityWithMetadata } from "../today-todos/slack-utils";
import { fetchMeetingNoteActions } from "../today-todos/granola-utils";
import { parseDependencies } from "../today-todos/dependency-utils";
import { detectLinearMentions, detectGitHubMentions } from "../today-todos/cross-reference-utils";
import { generateMeetingContext } from "../today-todos/meeting-prep-utils";
import { config } from "../../config";
import { formatAuthError, getErrorFooter } from "../../utils/error-utils";
import { TIME_WINDOWS, FETCH_LIMITS } from "../../constants";

const CALENDAR_RESOURCE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];
const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];
const GITHUB_RESOURCE = "https://api.github.com";
const GITHUB_SCOPES = ["repo", "read:org"];
const DRIVE_RESOURCE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

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
      description: "Fetch all tasks, events, and items for today from multiple sources, returning raw structured data grouped by source. Each item includes priority metadata (score, category, signals, reasons) to help with intelligent planning and prioritization. Scores range from 0-300 (higher = more urgent), with categories: critical (≥180), high (130-179), medium (80-129), low (<80). This tool provides data only - agents can use or override priority signals as needed. Sources: Calendar, Linear, Gmail, Google Docs, GitHub, Slack, Meeting Notes (Granola).",
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
      let meetingSummaries: any[] = [];
      let assignedActions: any[] = [];
      let githubPRs: any[] = [];
      let githubIssues: any[] = [];
      let slackMessages: any[] = [];
      let meetingNoteActions: any[] = [];

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

      // Fetch Linear issues (with 14-day window for due dates + recently completed)
      try {
        const fourteenDaysFromNow = new Date(today);
        fourteenDaysFromNow.setDate(today.getDate() + 14);
        fourteenDaysFromNow.setHours(23, 59, 59, 999);

        const linearToken = await stsClient.exchange(
          authInfo,
          LINEAR_RESOURCE,
          LINEAR_SCOPES
        );
        linearIssues = await fetchLinearIssues(linearToken.access_token, fourteenDaysFromNow, {
          includeRecentlyCompleted: true,
          completedDaysBack: 3
        });
      } catch (error) {
        errors.push(formatAuthError("Linear", error));
      }

      // Fetch Gmail todos (more inclusive for agent use)
      try {
        const gmailToken = await stsClient.exchange(
          authInfo,
          GMAIL_RESOURCE,
          GMAIL_SCOPES
        );
        gmailTodos = await fetchGmailTodos(gmailToken.access_token, {
          daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
          maxResults: FETCH_LIMITS.GMAIL,
          includeRead: true,
          strictFiltering: false
        });
      } catch (error) {
        errors.push(formatAuthError("Gmail", error));
      }

      // Fetch meeting summaries (Zoom, Google Meet, etc.)
      try {
        const gmailToken = await stsClient.exchange(
          authInfo,
          GMAIL_RESOURCE,
          GMAIL_SCOPES
        );
        meetingSummaries = await fetchMeetingSummaries(gmailToken.access_token, {
          daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
          maxResults: FETCH_LIMITS.MEETINGS
        });
      } catch (error) {
        errors.push(formatAuthError("Meeting Summaries (Gmail)", error));
      }

      // Fetch assigned actions from Google Docs (extended time window)
      try {
        const driveActivityToken = await stsClient.exchange(
          authInfo,
          DRIVE_ACTIVITY_RESOURCE,
          DRIVE_ACTIVITY_SCOPES
        );
        assignedActions = await fetchAssignedActions(driveActivityToken.access_token, TIME_WINDOWS.DEFAULT_DAYS_BACK);
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

      // Fetch Slack messages (more inclusive for agent use)
      try {
        // Use environment variable token (single-user deployment)
        const slackToken = config.slackUserToken || null;

        if (slackToken) {
          slackMessages = await fetchSlackMessages(slackToken, {
            daysBack: TIME_WINDOWS.SLACK_DAYS_BACK,
            maxMessages: FETCH_LIMITS.SLACK
          });
        }
      } catch (error) {
        errors.push(formatAuthError("Slack", error));
      }

      // Fetch meeting notes from Granola (synced to Google Drive)
      try {
        const driveToken = await stsClient.exchange(
          authInfo,
          DRIVE_RESOURCE,
          DRIVE_SCOPES
        );
        meetingNoteActions = await fetchMeetingNoteActions(driveToken.access_token, {
          daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
          maxResults: FETCH_LIMITS.MEETINGS
        });
      } catch (error) {
        errors.push(formatAuthError("Meeting Notes (Google Drive)", error));
      }

      // Enrich with priority metadata
      const now = new Date();

      calendarEvents = calendarEvents.map(event => ({
        ...event,
        priorityMetadata: calculateCalendarPriority(event, now)
      }));

      linearIssues = linearIssues.map(issue => ({
        ...issue,
        priorityMetadata: calculateLinearPriority(issue, now)
      }));

      gmailTodos = gmailTodos.map(email => ({
        ...email,
        priorityMetadata: calculateEmailPriority(email, now)
      }));

      meetingSummaries = meetingSummaries.map(summary => ({
        ...summary,
        priorityMetadata: calculateMeetingSummaryPriority(summary, now)
      }));

      assignedActions = assignedActions.map(action => ({
        ...action,
        priorityMetadata: calculateDocsPriority(action, now)
      }));

      githubPRs = githubPRs.map(pr => ({
        ...pr,
        priorityMetadata: calculateGitHubPriority(pr, now)
      }));

      githubIssues = githubIssues.map(issue => ({
        ...issue,
        priorityMetadata: calculateGitHubPriority(issue, now)
      }));

      slackMessages = slackMessages.map(msg => ({
        ...msg,
        priorityMetadata: calculateSlackPriorityWithMetadata(msg, now)
      }));

      // ============================================
      // ENRICHMENT PHASE: Cross-Item Intelligence
      // ============================================

      // 1. Dependencies: Parse blocking relationships from Linear issue titles
      for (const issue of linearIssues) {
        if (issue.title) {
          issue.dependencyMetadata = parseDependencies(issue.title);
        }
      }

      // Compute reverse dependencies (what each item blocks)
      const dependencyMap = new Map<string, Set<string>>();
      for (const issue of linearIssues) {
        if (issue.dependencyMetadata?.blockedBy) {
          for (const blockerId of issue.dependencyMetadata.blockedBy) {
            if (!dependencyMap.has(blockerId)) {
              dependencyMap.set(blockerId, new Set());
            }
            dependencyMap.get(blockerId)!.add(issue.identifier);
          }
        }
      }

      // Update blocks field with reverse lookup
      for (const issue of linearIssues) {
        if (dependencyMap.has(issue.identifier)) {
          issue.dependencyMetadata = issue.dependencyMetadata || {
            blockedBy: [],
            blocks: [],
            waitingOn: [],
            blockedByExternal: false,
          };
          issue.dependencyMetadata.blocks = Array.from(dependencyMap.get(issue.identifier)!);
        }
      }

      // 2. Cross-references: Detect mentions across sources
      for (const issue of linearIssues) {
        issue.crossReferenceMetadata = detectLinearMentions(
          issue.identifier,
          gmailTodos,
          slackMessages
        );
      }

      for (const pr of githubPRs) {
        pr.crossReferenceMetadata = detectGitHubMentions(
          pr.repo,
          pr.number,
          gmailTodos,
          slackMessages
        );
      }

      for (const issue of githubIssues) {
        issue.crossReferenceMetadata = detectGitHubMentions(
          issue.repo,
          issue.number,
          gmailTodos,
          slackMessages
        );
      }

      // 3. Meeting prep: Generate context for calendar events
      for (const meeting of calendarEvents) {
        meeting.meetingContextMetadata = generateMeetingContext(
          meeting,
          linearIssues,
          { prs: githubPRs, issues: githubIssues },
          gmailTodos,
          meetingSummaries
        );
      }

      // Build response data
      const responseData = {
        calendar: calendarEvents,
        linear: linearIssues,
        gmail: gmailTodos,
        meetingSummaries,
        docs: assignedActions,
        github: {
          prs: githubPRs,
          issues: githubIssues
        },
        slack: slackMessages,
        meetingNotes: meetingNoteActions,
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
