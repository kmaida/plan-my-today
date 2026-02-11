import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
import { config } from "../../config";
import { DISPLAY_LIMITS, FETCH_LIMITS, TIME_WINDOWS } from "../../constants";
import { keycardClient } from "../../services/keycard-client";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../../types/index";
import { formatAuthError } from "../../utils/error-utils";
import { calculateCalendarPriority, fetchTodayCalendarEvents } from "../today-todos/calendar-utils";
import {
  detectGitHubMentions,
  detectLinearMentions,
  linkMeetingAssets,
} from "../today-todos/cross-reference-utils";
import { parseDependencies } from "../today-todos/dependency-utils";
import { calculateDocsPriority, fetchAssignedActions } from "../today-todos/docs-utils";
import {
  calculateEmailPriority,
  calculateMeetingSummaryPriority,
  fetchGmailTodos,
  fetchMeetingSummaries,
} from "../today-todos/email-utils";
import { calculateGitHubPriority, fetchGitHubTodos } from "../today-todos/github-utils";
import { fetchMeetingNoteActions } from "../today-todos/granola-utils";
import { calculateLinearPriority, fetchLinearIssues } from "../today-todos/linear-utils";
import { generateMeetingContext } from "../today-todos/meeting-prep-utils";
import type { PriorityMetadata } from "../today-todos/priority-utils";
import { calculateSlackPriorityWithMetadata, fetchSlackMessages } from "../today-todos/slack-utils";
import type {
  AssignedActionDetail,
  CalendarEventDetail,
  EnrichedAssignedAction,
  EnrichedCalendarEvent,
  EnrichedGitHubIssue,
  EnrichedGitHubPR,
  EnrichedGmailMessage,
  EnrichedLinearIssue,
  EnrichedMeetingNote,
  EnrichedMeetingSummary,
  EnrichedSlackMessage,
  GitHubIssueDetail,
  GitHubPRDetail,
  GmailMessageDetail,
  LinearIssueDetail,
  ListAllTasksResponse,
  MeetingNoteActionDetail,
  MeetingSummaryDetail,
  SlackMessageDetail,
} from "../today-todos/types";

const CALENDAR_RESOURCE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];
const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];
const GITHUB_RESOURCE = "https://api.github.com";
const DRIVE_RESOURCE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

const SLACK_TITLE_MAX_LENGTH = 80;

/**
 * Generate a short display title from a Slack message.
 * Takes the first line, strips non-link Slack formatting (emoji codes, user/channel mentions),
 * and truncates to a reasonable length. Preserves Slack link markup (<url|label> / <url>)
 * so the UI can render them as clickable hyperlinks.
 */
function summarizeSlackMessage(text: string, type: string, userName: string): string {
  if (!text) {
    const labels: Record<string, string> = {
      mention: "Mention",
      dm: "Direct message",
      saved: "Saved message",
      thread: "Thread reply",
    };
    return `${labels[type] || "Message"} from ${userName}`;
  }

  // Take first line only
  let title = text.split("\n")[0].trim();

  // Strip Slack emoji codes like :slightly_smiling_face:
  title = title.replace(/:[a-z0-9_+-]+:/g, "").trim();

  // Strip Slack user mentions: <@U12345|kim> → @kim, <@U12345> → removed
  title = title.replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1");
  title = title.replace(/<@[A-Z0-9]+>/g, "").trim();

  // Strip Slack channel mentions like <#C12345|general>
  title = title.replace(/<#[A-Z0-9]+\|?[^>]*>/g, "").trim();

  // NOTE: Slack links (<url|label> and <url>) are preserved for the UI to render as hyperlinks

  // Collapse multiple spaces
  title = title.replace(/\s+/g, " ").trim();

  // If first line is empty after stripping, fall back to type label
  if (!title) {
    const labels: Record<string, string> = {
      mention: "Mention",
      dm: "Direct message",
      saved: "Saved message",
      thread: "Thread reply",
    };
    return `${labels[type] || "Message"} from ${userName}`;
  }

  // Truncate based on visible text length (excluding link URL markup).
  // "Visible" means what the user sees: link labels instead of full <url|label> markup.
  const visibleText = title
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1") // <url|label> → label
    .replace(/<https?:\/\/[^>]+>/g, "link"); // <url> → "link"
  if (visibleText.length > SLACK_TITLE_MAX_LENGTH) {
    // Estimate a proportional cut point in the raw string.
    // The ratio of raw length to visible length accounts for link markup overhead.
    const ratio = title.length / Math.max(visibleText.length, 1);
    const cutAt = Math.floor((SLACK_TITLE_MAX_LENGTH - 1) * ratio);
    title = `${title.substring(0, cutAt).trimEnd()}\u2026`;
  }

  return title;
}

/**
 * Strip verbose enrichment metadata from the full response to reduce token
 * usage when returning data to chat agents.
 *
 * Keeps: essential fields, priority category/score/reasons, links
 * Strips: signals, crossReferenceMetadata, dependencyMetadata,
 *         meetingContextMetadata, conferenceData, internal IDs, redundant fields
 */
function compactifyResponse(data: ListAllTasksResponse): Record<string, unknown> {
  // Slim priority metadata: keep score, category, reasons — drop signals
  function slimPriority(item: { priorityMetadata?: PriorityMetadata }) {
    if (!item.priorityMetadata) return undefined;
    return {
      score: item.priorityMetadata.score,
      category: item.priorityMetadata.category,
      reasons: item.priorityMetadata.reasons,
    };
  }

  function stripItem(item: Record<string, unknown>, keepFields: string[]): Record<string, unknown> {
    const slim: Record<string, unknown> = {};
    for (const key of keepFields) {
      if (item[key] !== undefined && item[key] !== null) slim[key] = item[key];
    }
    slim.priorityMetadata = slimPriority(item as { priorityMetadata?: PriorityMetadata });
    return slim;
  }

  return {
    calendar: data.calendar.map((e) =>
      stripItem(e as unknown as Record<string, unknown>, [
        "summary",
        "start",
        "end",
        "htmlLink",
        "hangoutLink",
        "attendees",
        "taskId",
      ])
    ),
    linear: data.linear.map((e) =>
      stripItem(e as unknown as Record<string, unknown>, [
        "identifier",
        "title",
        "priority",
        "priorityLabel",
        "url",
        "state",
        "dueDate",
        "estimate",
        "project",
        "taskId",
      ])
    ),
    gmail: data.gmail.map((e) =>
      stripItem(e as unknown as Record<string, unknown>, [
        "id",
        "subject",
        "from",
        "link",
        "needsReply",
        "hasActionItems",
        "taskId",
        "threadMessageCount",
        "threadParticipants",
      ])
    ),
    meetingSummaries: data.meetingSummaries.map((e) =>
      stripItem(e as unknown as Record<string, unknown>, [
        "platform",
        "meetingTitle",
        "subject",
        "link",
        "recordingLink",
        "hasActionItems",
        "taskId",
      ])
    ),
    docs: data.docs.map((e) =>
      stripItem(e as unknown as Record<string, unknown>, [
        "fileTitle",
        "actionType",
        "fileLink",
        "taskId",
      ])
    ),
    github: {
      prs: data.github.prs.map((e) =>
        stripItem(e as unknown as Record<string, unknown>, [
          "number",
          "title",
          "url",
          "repo",
          "type",
          "isDraft",
          "taskId",
        ])
      ),
      issues: data.github.issues.map((e) =>
        stripItem(e as unknown as Record<string, unknown>, [
          "number",
          "title",
          "url",
          "repo",
          "labels",
          "taskId",
        ])
      ),
    },
    slack: data.slack.map((e) =>
      stripItem(e as unknown as Record<string, unknown>, [
        "text",
        "type",
        "userName",
        "permalink",
        "dismissalId",
        "taskId",
      ])
    ),
    meetingNotes: data.meetingNotes.map((e) =>
      stripItem(e as unknown as Record<string, unknown>, [
        "actionItem",
        "documentTitle",
        "documentLink",
        "assignee",
        "isUrgent",
        "taskId",
      ])
    ),
    metadata: data.metadata,
  };
}

/**
 * Input schema for the list-all-tasks-today tool
 */
const listAllTasksTodayInputSchema = {
  includeGithub: z.boolean().describe("Include GitHub PRs and issues (default: true)").optional(),
  compact: z
    .boolean()
    .describe(
      "Return a compact response with only essential fields per item. Recommended for chat agents to reduce token usage. (default: false)"
    )
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
      description:
        "Fetch all tasks, events, and items for today from multiple sources, returning raw structured data grouped by source. Each item includes priority metadata (score, category, signals, reasons) to help with intelligent planning and prioritization. Scores range from 0-300 (higher = more urgent), with categories: critical (≥180), high (130-179), medium (80-129), low (<80). This tool provides data only - agents can use or override priority signals as needed. Sources: Calendar, Linear, Gmail, Google Docs, GitHub, Slack, Meeting Notes (Granola).",
      inputSchema: listAllTasksTodayInputSchema,
    },
    (async (args, { authInfo }) => {
      if (!authInfo) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "No authentication information available",
                  message: "Please ensure you're properly authenticated.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const includeGithub = args.includeGithub ?? true;
      const compact = args.compact ?? false;
      const today = new Date();
      const errors: string[] = [];

      // Initialize raw data containers (populated by parallel fetch)
      let rawCalendar: CalendarEventDetail[] = [];
      let rawLinear: LinearIssueDetail[] = [];
      let rawGmail: GmailMessageDetail[] = [];
      let rawMeetingSummaries: MeetingSummaryDetail[] = [];
      let rawAssignedActions: AssignedActionDetail[] = [];
      let rawGithubPRs: GitHubPRDetail[] = [];
      let rawGithubIssues: GitHubIssueDetail[] = [];
      let rawSlack: SlackMessageDetail[] = [];
      let rawMeetingNotes: MeetingNoteActionDetail[] = [];

      // ============================================
      // PARALLEL FETCH: All sources run concurrently
      // ============================================
      const sevenDaysFromNow = new Date(today);
      sevenDaysFromNow.setDate(today.getDate() + 7);
      sevenDaysFromNow.setHours(23, 59, 59, 999);

      const fetchResults = await Promise.allSettled([
        // 0: Calendar
        (async () => {
          const token = await keycardClient.exchange(authInfo, CALENDAR_RESOURCE, CALENDAR_SCOPES);
          return fetchTodayCalendarEvents(token.access_token);
        })(),

        // 1: Linear
        (async () => {
          const token = await keycardClient.exchange(authInfo, LINEAR_RESOURCE, LINEAR_SCOPES);
          return fetchLinearIssues(token.access_token, sevenDaysFromNow);
        })(),

        // 2: Gmail (todos + meeting summaries share one STS exchange)
        (async () => {
          const token = await keycardClient.exchange(authInfo, GMAIL_RESOURCE, GMAIL_SCOPES);
          const [todos, summaries] = await Promise.all([
            fetchGmailTodos(token.access_token, {
              daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
              maxResults: FETCH_LIMITS.GMAIL,
              includeRead: true,
              strictFiltering: false,
            }),
            fetchMeetingSummaries(token.access_token, {
              daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
              maxResults: FETCH_LIMITS.MEETINGS,
            }),
          ]);
          return { todos, summaries };
        })(),

        // 3: Google Drive Activity (assigned actions)
        (async () => {
          const token = await keycardClient.exchange(
            authInfo,
            DRIVE_ACTIVITY_RESOURCE,
            DRIVE_ACTIVITY_SCOPES
          );
          return fetchAssignedActions(token.access_token, TIME_WINDOWS.DEFAULT_DAYS_BACK);
        })(),

        // 4: GitHub (conditional)
        (async () => {
          if (!includeGithub) return { prs: [], issues: [] };
          const token = await keycardClient.exchange(authInfo, GITHUB_RESOURCE);
          return fetchGitHubTodos(token.access_token);
        })(),

        // 5: Slack (static user token, not STS)
        // Slack's OIDC discovery only advertises identity scopes (openid, profile,
        // email), so the API scopes we need (search:read, etc.) can't go through
        // Keycard STS. See src/tools/slack-list.ts for full explanation.
        (async () => {
          const slackToken = config.slackUserToken || null;
          if (!slackToken) return [];
          return fetchSlackMessages(slackToken, {
            daysBack: TIME_WINDOWS.SLACK_DAYS_BACK,
            maxMessages: FETCH_LIMITS.SLACK,
          });
        })(),

        // 6: Meeting notes (Granola via Google Drive)
        (async () => {
          const token = await keycardClient.exchange(authInfo, DRIVE_RESOURCE, DRIVE_SCOPES);
          return fetchMeetingNoteActions(token.access_token, {
            daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
            maxResults: FETCH_LIMITS.MEETINGS,
          });
        })(),
      ]);

      // Unpack results — each source fails independently
      if (fetchResults[0].status === "fulfilled") {
        rawCalendar = fetchResults[0].value;
      } else {
        errors.push(formatAuthError("Google Calendar", fetchResults[0].reason));
      }

      if (fetchResults[1].status === "fulfilled") {
        rawLinear = fetchResults[1].value;
      } else {
        errors.push(formatAuthError("Linear", fetchResults[1].reason));
      }

      if (fetchResults[2].status === "fulfilled") {
        rawGmail = fetchResults[2].value.todos;
        rawMeetingSummaries = fetchResults[2].value.summaries;
      } else {
        errors.push(formatAuthError("Gmail", fetchResults[2].reason));
      }

      if (fetchResults[3].status === "fulfilled") {
        rawAssignedActions = fetchResults[3].value;
      } else {
        errors.push(formatAuthError("Google Drive Activity", fetchResults[3].reason));
      }

      if (fetchResults[4].status === "fulfilled") {
        rawGithubPRs = fetchResults[4].value.prs;
        rawGithubIssues = fetchResults[4].value.issues;
      } else if (includeGithub) {
        errors.push(formatAuthError("GitHub", fetchResults[4].reason));
      }

      if (fetchResults[5].status === "fulfilled") {
        rawSlack = fetchResults[5].value;
      } else {
        errors.push(formatAuthError("Slack", fetchResults[5].reason));
      }

      if (fetchResults[6].status === "fulfilled") {
        rawMeetingNotes = fetchResults[6].value;
      } else {
        errors.push(formatAuthError("Meeting Notes (Google Drive)", fetchResults[6].reason));
      }

      // Enrich with priority metadata + taskId
      const now = new Date();

      // Remove calendar events that have already ended (keep all-day events)
      const activeCalendar = rawCalendar.filter((event) => {
        const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;
        return !endTime || endTime > now;
      });

      const calendarEvents: EnrichedCalendarEvent[] = activeCalendar.map((event) => ({
        ...event,
        taskId: randomUUID(),
        priorityMetadata: calculateCalendarPriority(event, now),
      }));

      let linearIssues: EnrichedLinearIssue[] = rawLinear.map((issue) => ({
        ...issue,
        taskId: randomUUID(),
        priorityMetadata: calculateLinearPriority(issue, now),
      }));

      let gmailTodos: EnrichedGmailMessage[] = rawGmail.map((email) => ({
        ...email,
        taskId: randomUUID(),
        priorityMetadata: calculateEmailPriority(email, now),
      }));

      let meetingSummaries: EnrichedMeetingSummary[] = rawMeetingSummaries.map((summary) => ({
        ...summary,
        taskId: randomUUID(),
        priorityMetadata: calculateMeetingSummaryPriority(summary, now),
      }));

      let assignedActions: EnrichedAssignedAction[] = rawAssignedActions.map((action) => ({
        ...action,
        taskId: randomUUID(),
        priorityMetadata: calculateDocsPriority(action, now),
      }));

      let githubPRs: EnrichedGitHubPR[] = rawGithubPRs.map((pr) => ({
        ...pr,
        taskId: randomUUID(),
        priorityMetadata: calculateGitHubPriority(pr, now),
      }));

      let githubIssues: EnrichedGitHubIssue[] = rawGithubIssues.map((issue) => ({
        ...issue,
        taskId: randomUUID(),
        priorityMetadata: calculateGitHubPriority(issue, now),
      }));

      let slackMessages: EnrichedSlackMessage[] = rawSlack.map((msg) => {
        // Priority must be calculated BEFORE we convert the timestamp,
        // since calculateSlackPriorityWithMetadata expects epoch seconds
        const priorityMetadata = calculateSlackPriorityWithMetadata(msg, now);
        // Convert Slack epoch seconds (e.g., "1770390352.498779") to ISO string
        const epochMs = parseFloat(msg.timestamp) * 1000;
        const isoTimestamp = Number.isNaN(epochMs)
          ? msg.timestamp
          : new Date(epochMs).toISOString();
        return {
          ...msg,
          taskId: randomUUID(),
          title: summarizeSlackMessage(msg.text, msg.type, msg.userName || msg.user),
          timestamp: isoTimestamp,
          priorityMetadata,
        };
      });

      // Add taskId to meeting notes
      let meetingNoteActions: EnrichedMeetingNote[] = rawMeetingNotes.map((note) => ({
        ...note,
        taskId: randomUUID(),
      }));

      // Sort by priority score (highest first) and cap each source
      // Done BEFORE cross-reference enrichment so less work to do
      const byPriority = (
        a: { priorityMetadata?: PriorityMetadata },
        b: { priorityMetadata?: PriorityMetadata }
      ) => (b.priorityMetadata?.score ?? 0) - (a.priorityMetadata?.score ?? 0);

      // Calendar is uncapped (you need to see all your meetings)
      linearIssues = linearIssues.sort(byPriority).slice(0, DISPLAY_LIMITS.LINEAR);
      gmailTodos = gmailTodos.sort(byPriority).slice(0, DISPLAY_LIMITS.GMAIL);
      slackMessages = slackMessages.sort(byPriority).slice(0, DISPLAY_LIMITS.SLACK);
      githubPRs = githubPRs.sort(byPriority).slice(0, DISPLAY_LIMITS.GITHUB_PRS);
      githubIssues = githubIssues.sort(byPriority).slice(0, DISPLAY_LIMITS.GITHUB_ISSUES);
      assignedActions = assignedActions.sort(byPriority).slice(0, DISPLAY_LIMITS.DOCS);
      meetingSummaries = meetingSummaries
        .sort(byPriority)
        .slice(0, DISPLAY_LIMITS.MEETING_SUMMARIES);
      meetingNoteActions = meetingNoteActions.slice(0, DISPLAY_LIMITS.MEETING_NOTES);

      // ============================================
      // ENRICHMENT PHASE: Cross-Item Intelligence
      // Runs on capped arrays so less work to do
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

      // 4. Meeting assets: Link Zoom "meeting assets" emails to Granola notes & calendar events
      linkMeetingAssets(meetingSummaries, meetingNoteActions, calendarEvents);

      // Build response data
      const responseData: ListAllTasksResponse = {
        calendar: calendarEvents,
        linear: linearIssues,
        gmail: gmailTodos,
        meetingSummaries,
        docs: assignedActions,
        github: {
          prs: githubPRs,
          issues: githubIssues,
        },
        slack: slackMessages,
        meetingNotes: meetingNoteActions,
        metadata: {
          fetched_at: new Date().toISOString(),
          date: today.toISOString(),
          errors: errors.length > 0 ? errors : undefined,
        },
      };

      // Write full data to local file so the UI can read it without auth.
      // Awaited so the cache is fresh when the UI re-fetches after a chat tool call.
      try {
        const dataDir = path.join(process.cwd(), "data");
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(
          path.join(dataDir, "latest-tasks.json"),
          JSON.stringify(responseData, null, 2)
        );
      } catch {
        // Non-fatal: UI cache write failed
      }

      // In compact mode, strip verbose enrichment to reduce token usage for chat agents
      const outputData = compact ? compactifyResponse(responseData) : responseData;

      // Return JSON string
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(outputData),
          },
        ],
      };
    }) as AuthenticatedToolHandlerWithArgs<typeof listAllTasksTodayInputSchema>
  );
}
