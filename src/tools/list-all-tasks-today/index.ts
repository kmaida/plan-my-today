import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../../types/index";
import { z } from "zod/v3";
import { stsClient } from "../../services/sts-client";
import { fetchTodayCalendarEvents, calculateCalendarPriority } from "../today-todos/calendar-utils";
import { fetchLinearIssues, calculateLinearPriority } from "../today-todos/linear-utils";
import { fetchGmailTodos, fetchMeetingSummaries, calculateEmailPriority, calculateMeetingSummaryPriority } from "../today-todos/email-utils";
import { fetchAssignedActions, calculateDocsPriority } from "../today-todos/docs-utils";
import { fetchGitHubTodos, calculateGitHubPriority } from "../today-todos/github-utils";
import { fetchSlackMessages, calculateSlackPriorityWithMetadata } from "../today-todos/slack-utils";
import { fetchMeetingNoteActions } from "../today-todos/granola-utils";
import { parseDependencies } from "../today-todos/dependency-utils";
import { detectLinearMentions, detectGitHubMentions, linkMeetingAssets } from "../today-todos/cross-reference-utils";
import { generateMeetingContext } from "../today-todos/meeting-prep-utils";
import { config } from "../../config";
import { formatAuthError, getErrorFooter } from "../../utils/error-utils";
import { TIME_WINDOWS, FETCH_LIMITS, DISPLAY_LIMITS } from "../../constants";

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

const SLACK_TITLE_MAX_LENGTH = 80;

/**
 * Generate a short display title from a Slack message.
 * Takes the first line, strips non-link Slack formatting (emoji codes, user/channel mentions),
 * and truncates to a reasonable length. Preserves Slack link markup (<url|label> / <url>)
 * so the UI can render them as clickable hyperlinks.
 */
function summarizeSlackMessage(text: string, type: string, userName: string): string {
  if (!text) {
    const labels: Record<string, string> = { mention: "Mention", dm: "Direct message", saved: "Saved message", thread: "Thread reply" };
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
    const labels: Record<string, string> = { mention: "Mention", dm: "Direct message", saved: "Saved message", thread: "Thread reply" };
    return `${labels[type] || "Message"} from ${userName}`;
  }

  // Truncate based on visible text length (excluding link URL markup)
  const visibleLength = title.replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1").replace(/<https?:\/\/[^>]+>/g, "link").length;
  if (visibleLength > SLACK_TITLE_MAX_LENGTH) {
    // Truncate conservatively — find a safe cut point in the raw string
    let visible = 0;
    let i = 0;
    while (i < title.length && visible < SLACK_TITLE_MAX_LENGTH - 1) {
      if (title[i] === "<" && title.substring(i).match(/^<https?:\/\//)) {
        // Skip to end of link markup, count only label length
        const end = title.indexOf(">", i);
        if (end === -1) break;
        const linkContent = title.substring(i + 1, end);
        const pipeIdx = linkContent.indexOf("|");
        const labelLen = pipeIdx >= 0 ? linkContent.length - pipeIdx - 1 : 4; // "link"
        visible += labelLen;
        i = end + 1;
      } else {
        visible++;
        i++;
      }
    }
    title = title.substring(0, i).trimEnd() + "\u2026";
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compactifyResponse(data: Record<string, any>): Record<string, any> {
  // Slim priority metadata: keep score, category, reasons — drop signals
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function slimPriority(item: any) {
    if (!item.priorityMetadata) return undefined;
    return {
      score: item.priorityMetadata.score,
      category: item.priorityMetadata.category,
      reasons: item.priorityMetadata.reasons,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stripItem(item: any, keepFields: string[]): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slim: any = {};
    for (const key of keepFields) {
      if (item[key] !== undefined && item[key] !== null) slim[key] = item[key];
    }
    slim.priorityMetadata = slimPriority(item);
    return slim;
  }

  return {
    calendar: (data.calendar || []).map((e: any) => stripItem(e, [
      "summary", "start", "end", "htmlLink", "hangoutLink", "attendees", "taskId",
    ])),
    linear: (data.linear || []).map((e: any) => stripItem(e, [
      "identifier", "title", "priority", "priorityLabel", "url", "state", "dueDate", "estimate", "project", "taskId",
    ])),
    gmail: (data.gmail || []).map((e: any) => stripItem(e, [
      "id", "subject", "from", "link", "needsReply", "hasActionItems", "taskId",
    ])),
    meetingSummaries: (data.meetingSummaries || []).map((e: any) => stripItem(e, [
      "platform", "meetingTitle", "subject", "link", "recordingLink", "hasActionItems", "taskId",
    ])),
    docs: (data.docs || []).map((e: any) => stripItem(e, [
      "fileTitle", "actionType", "fileLink", "taskId",
    ])),
    github: {
      prs: (data.github?.prs || []).map((e: any) => stripItem(e, [
        "number", "title", "url", "repo", "type", "isDraft", "taskId",
      ])),
      issues: (data.github?.issues || []).map((e: any) => stripItem(e, [
        "number", "title", "url", "repo", "labels", "taskId",
      ])),
    },
    slack: (data.slack || []).map((e: any) => stripItem(e, [
      "text", "type", "userName", "permalink", "taskId",
    ])),
    meetingNotes: (data.meetingNotes || []).map((e: any) => stripItem(e, [
      "actionItem", "documentTitle", "documentLink", "assignee", "isUrgent", "taskId",
    ])),
    metadata: data.metadata,
  };
}

/**
 * Input schema for the list-all-tasks-today tool
 */
const listAllTasksTodayInputSchema = {
  includeGithub: z.boolean()
    .describe("Include GitHub PRs and issues (default: true)")
    .optional(),
  compact: z.boolean()
    .describe("Return a compact response with only essential fields per item. Recommended for chat agents to reduce token usage. (default: false)")
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
      const compact = args.compact ?? false;
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

      // ============================================
      // PARALLEL FETCH: All sources run concurrently
      // ============================================
      const sevenDaysFromNow = new Date(today);
      sevenDaysFromNow.setDate(today.getDate() + 7);
      sevenDaysFromNow.setHours(23, 59, 59, 999);

      const fetchResults = await Promise.allSettled([
        // 0: Calendar
        (async () => {
          const token = await stsClient.exchange(authInfo, CALENDAR_RESOURCE, CALENDAR_SCOPES);
          return fetchTodayCalendarEvents(token.access_token);
        })(),

        // 1: Linear
        (async () => {
          const token = await stsClient.exchange(authInfo, LINEAR_RESOURCE, LINEAR_SCOPES);
          return fetchLinearIssues(token.access_token, sevenDaysFromNow);
        })(),

        // 2: Gmail (todos + meeting summaries share one STS exchange)
        (async () => {
          const token = await stsClient.exchange(authInfo, GMAIL_RESOURCE, GMAIL_SCOPES);
          const [todos, summaries] = await Promise.all([
            fetchGmailTodos(token.access_token, {
              daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
              maxResults: FETCH_LIMITS.GMAIL,
              includeRead: true,
              strictFiltering: false
            }),
            fetchMeetingSummaries(token.access_token, {
              daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
              maxResults: FETCH_LIMITS.MEETINGS
            })
          ]);
          return { todos, summaries };
        })(),

        // 3: Google Drive Activity (assigned actions)
        (async () => {
          const token = await stsClient.exchange(authInfo, DRIVE_ACTIVITY_RESOURCE, DRIVE_ACTIVITY_SCOPES);
          return fetchAssignedActions(token.access_token, TIME_WINDOWS.DEFAULT_DAYS_BACK);
        })(),

        // 4: GitHub (conditional)
        (async () => {
          if (!includeGithub) return { prs: [], issues: [] };
          const token = await stsClient.exchange(authInfo, GITHUB_RESOURCE, GITHUB_SCOPES);
          return fetchGitHubTodos(token.access_token);
        })(),

        // 5: Slack (env token, no STS)
        (async () => {
          const slackToken = config.slackUserToken || null;
          if (!slackToken) return [];
          return fetchSlackMessages(slackToken, {
            daysBack: TIME_WINDOWS.SLACK_DAYS_BACK,
            maxMessages: FETCH_LIMITS.SLACK
          });
        })(),

        // 6: Meeting notes (Granola via Google Drive)
        (async () => {
          const token = await stsClient.exchange(authInfo, DRIVE_RESOURCE, DRIVE_SCOPES);
          return fetchMeetingNoteActions(token.access_token, {
            daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
            maxResults: FETCH_LIMITS.MEETINGS
          });
        })(),
      ]);

      // Unpack results — each source fails independently
      if (fetchResults[0].status === "fulfilled") {
        calendarEvents = fetchResults[0].value;
      } else {
        errors.push(formatAuthError("Google Calendar", fetchResults[0].reason));
      }

      if (fetchResults[1].status === "fulfilled") {
        linearIssues = fetchResults[1].value;
      } else {
        errors.push(formatAuthError("Linear", fetchResults[1].reason));
      }

      if (fetchResults[2].status === "fulfilled") {
        gmailTodos = fetchResults[2].value.todos;
        meetingSummaries = fetchResults[2].value.summaries;
      } else {
        errors.push(formatAuthError("Gmail", fetchResults[2].reason));
      }

      if (fetchResults[3].status === "fulfilled") {
        assignedActions = fetchResults[3].value;
      } else {
        errors.push(formatAuthError("Google Drive Activity", fetchResults[3].reason));
      }

      if (fetchResults[4].status === "fulfilled") {
        githubPRs = fetchResults[4].value.prs;
        githubIssues = fetchResults[4].value.issues;
      } else if (includeGithub) {
        errors.push(formatAuthError("GitHub", fetchResults[4].reason));
      }

      if (fetchResults[5].status === "fulfilled") {
        slackMessages = fetchResults[5].value;
      } else {
        errors.push(formatAuthError("Slack", fetchResults[5].reason));
      }

      if (fetchResults[6].status === "fulfilled") {
        meetingNoteActions = fetchResults[6].value;
      } else {
        errors.push(formatAuthError("Meeting Notes (Google Drive)", fetchResults[6].reason));
      }

      // Enrich with priority metadata
      const now = new Date();

      // Remove calendar events that have already ended (keep all-day events)
      calendarEvents = calendarEvents.filter(event => {
        const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;
        return !endTime || endTime > now;
      });

      calendarEvents = calendarEvents.map(event => ({
        ...event,
        taskId: randomUUID(),
        priorityMetadata: calculateCalendarPriority(event, now)
      }));

      linearIssues = linearIssues.map(issue => ({
        ...issue,
        taskId: randomUUID(),
        priorityMetadata: calculateLinearPriority(issue, now)
      }));

      gmailTodos = gmailTodos.map(email => ({
        ...email,
        taskId: randomUUID(),
        priorityMetadata: calculateEmailPriority(email, now)
      }));

      meetingSummaries = meetingSummaries.map(summary => ({
        ...summary,
        taskId: randomUUID(),
        priorityMetadata: calculateMeetingSummaryPriority(summary, now)
      }));

      assignedActions = assignedActions.map(action => ({
        ...action,
        taskId: randomUUID(),
        priorityMetadata: calculateDocsPriority(action, now)
      }));

      githubPRs = githubPRs.map(pr => ({
        ...pr,
        taskId: randomUUID(),
        priorityMetadata: calculateGitHubPriority(pr, now)
      }));

      githubIssues = githubIssues.map(issue => ({
        ...issue,
        taskId: randomUUID(),
        priorityMetadata: calculateGitHubPriority(issue, now)
      }));

      slackMessages = slackMessages.map(msg => {
        // Priority must be calculated BEFORE we convert the timestamp,
        // since calculateSlackPriorityWithMetadata expects epoch seconds
        const priorityMetadata = calculateSlackPriorityWithMetadata(msg, now);
        // Convert Slack epoch seconds (e.g., "1770390352.498779") to ISO string
        const epochMs = parseFloat(msg.timestamp) * 1000;
        const isoTimestamp = isNaN(epochMs) ? msg.timestamp : new Date(epochMs).toISOString();
        return {
          ...msg,
          taskId: randomUUID(),
          title: summarizeSlackMessage(msg.text, msg.type, msg.userName || msg.user),
          timestamp: isoTimestamp,
          priorityMetadata,
        };
      });

      // Add id to meeting notes (they don't go through an enrichment .map())
      meetingNoteActions = meetingNoteActions.map(note => ({
        ...note,
        taskId: randomUUID(),
      }));

      // Sort by priority score (highest first) and cap each source
      // Done BEFORE enrichment so cross-reference/dependency work runs on fewer items
      const byPriority = (a: any, b: any) =>
        (b.priorityMetadata?.score ?? 0) - (a.priorityMetadata?.score ?? 0);

      // Calendar is uncapped (you need to see all your meetings)
      linearIssues = linearIssues.sort(byPriority).slice(0, DISPLAY_LIMITS.LINEAR);
      gmailTodos = gmailTodos.sort(byPriority).slice(0, DISPLAY_LIMITS.GMAIL);
      slackMessages = slackMessages.sort(byPriority).slice(0, DISPLAY_LIMITS.SLACK);
      githubPRs = githubPRs.sort(byPriority).slice(0, DISPLAY_LIMITS.GITHUB_PRS);
      githubIssues = githubIssues.sort(byPriority).slice(0, DISPLAY_LIMITS.GITHUB_ISSUES);
      assignedActions = assignedActions.sort(byPriority).slice(0, DISPLAY_LIMITS.DOCS);
      meetingSummaries = meetingSummaries.sort(byPriority).slice(0, DISPLAY_LIMITS.MEETING_SUMMARIES);
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

      // Write full data to local file so the UI can read it without auth
      // Fire-and-forget: don't block the response on disk I/O
      const dataDir = path.join(process.cwd(), "data");
      fs.mkdir(dataDir, { recursive: true })
        .then(() => fs.writeFile(
          path.join(dataDir, "latest-tasks.json"),
          JSON.stringify(responseData, null, 2)
        ))
        .catch(() => {}); // Non-fatal: UI cache write failed

      // In compact mode, strip verbose enrichment to reduce token usage for chat agents
      const outputData = compact ? compactifyResponse(responseData) : responseData;

      // Return JSON string
      return {
        content: [{
          type: "text",
          text: JSON.stringify(outputData)
        }]
      };
    }) as AuthenticatedToolHandlerWithArgs<typeof listAllTasksTodayInputSchema>
  );
}
