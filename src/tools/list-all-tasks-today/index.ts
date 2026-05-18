import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
import { config } from "../../config";
import { FETCH_LIMITS, TIME_WINDOWS } from "../../constants";
import { exchangeToken } from "../../services/keycard-client";
import { applyOverridesToTasks } from "../../services/priority-override-store";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../../types/index";
import type { StructuredToolError } from "../../types/tool-error";
import { formatAuthError } from "../../utils/error-utils";
import { filterCompletedTasks } from "../../utils/filter-completed-tasks";
import { computeStableId } from "../../utils/stable-task-keys";
import { writeTaskStore } from "../../utils/task-store-utils";
import { buildStructuredError } from "../../utils/tool-error-utils";
import { calculateCalendarPriority, fetchTodayCalendarEvents } from "../today-todos/calendar-utils";
import {
  buildCalendarCrossRefs,
  buildCalendarGitHubCrossRefs,
  buildSourceGitHubCrossRefs,
  buildSourceLinearCrossRefs,
  detectGitHubMentions,
  detectLinearMentions,
  linkMeetingAssets,
} from "../today-todos/cross-reference-utils";
import { parseDependencies } from "../today-todos/dependency-utils";
import type { DocCommentEmail } from "../today-todos/drive-comments-utils";
import { verifyAndEnrichDocComments } from "../today-todos/drive-comments-utils";
import { calculateDrivePriority, fetchDriveActionItems } from "../today-todos/drive-utils";
import {
  calculateEmailPriority,
  calculateMeetingSummaryPriority,
  fetchGmailTodos,
  fetchMeetingSummaries,
} from "../today-todos/email-utils";
import { calculateGitHubPriority, fetchGitHubTodos } from "../today-todos/github-utils";
import {
  calculateMeetingNotePriority,
  fetchMeetingNoteActions,
} from "../today-todos/granola-utils";
import { calculateLinearPriority, fetchLinearIssues } from "../today-todos/linear-utils";
import { generateMeetingContext } from "../today-todos/meeting-prep-utils";
import type { PriorityMetadata } from "../today-todos/priority-utils";
import { enrichRelations } from "../today-todos/relation-utils";
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
  SlackFileAttachment,
  SlackMessageDetail,
} from "../today-todos/types";

const CALENDAR_RESOURCE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];
const GMAIL_RESOURCE = "https://gmail.googleapis.com";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const GITHUB_RESOURCE = "https://api.github.com";
const DRIVE_RESOURCE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const SLACK_RESOURCE = "https://slack.com/api";
const SLACK_SCOPES = [
  "search:read",
  "reactions:read",
  "users:read",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
];

const SLACK_TITLE_MAX_LENGTH = 80;

const SLACK_TYPE_LABELS: Record<string, string> = {
  mention: "Mention",
  dm: "Direct message",
  saved: "Saved message",
  thread: "Thread reply",
};

/**
 * Generate a human-readable label for a Slack file attachment.
 * Prefers the file title/name, falls back to MIME type category.
 */
function describeFile(file: SlackFileAttachment): string {
  const raw = file.title || file.name;
  if (raw) {
    // Limit length to avoid excessively long titles from file names
    return raw.length > 50 ? `${raw.slice(0, 47)}...` : raw;
  }

  const mime = file.mimetype || "";
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime.includes("pdf")) return "PDF";
  return "File attachment";
}

/**
 * Build a fallback title for messages with no extractable text content.
 * Used for image-only, emoji-only, /giphy, and similar non-text messages.
 */
function buildFallbackTitle(type: string, files?: SlackFileAttachment[]): string {
  const typeLabel = SLACK_TYPE_LABELS[type] || "Message";

  if (files && files.length > 0) {
    const fileLabel = describeFile(files[0]);
    const suffix = files.length > 1 ? ` (+${files.length - 1} more)` : "";
    return `${fileLabel}${suffix}`;
  }

  return typeLabel;
}

/**
 * Generate a short display title from a Slack message.
 * Takes the first line, strips non-link Slack formatting (emoji codes, user/channel mentions),
 * and truncates to a reasonable length. Preserves Slack link markup (<url|label> / <url>)
 * so the UI can render them as clickable hyperlinks.
 * Falls back to file metadata for image-only/emoji-only messages.
 */
function summarizeSlackMessage(text: string, type: string, files?: SlackFileAttachment[]): string {
  if (!text) {
    return buildFallbackTitle(type, files);
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

  // If first line is empty after stripping (e.g., emoji-only, /giphy), use fallback
  if (!title) {
    return buildFallbackTitle(type, files);
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

// ---------------------------------------------------------------------------
// Freshness guard — skip redundant re-fetches within a short window.
// ---------------------------------------------------------------------------

/** Seconds within which a re-call returns cached counts instead of re-fetching. */
const FRESHNESS_WINDOW_SECONDS = 60;

/**
 * Build the per-source item counts from a ListAllTasksResponse (or parsed JSON with the same shape).
 * Used by both the normal return path and the freshness guard to avoid duplicating the counts structure.
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts both typed ListAllTasksResponse and parsed JSON
function buildCounts(data: Record<string, any>) {
  return {
    calendar: data.calendar?.length ?? 0,
    linear: data.linear?.length ?? 0,
    gmail: data.gmail?.length ?? 0,
    slack: data.slack?.length ?? 0,
    github: {
      prs: data.github?.prs?.length ?? 0,
      issues: data.github?.issues?.length ?? 0,
    },
    drive: data.drive?.length ?? 0,
    meetingSummaries: data.meetingSummaries?.length ?? 0,
    meetingNotes: data.meetingNotes?.length ?? 0,
  };
}

/**
 * Timestamp of the last successful fetch (zero failed sources).
 * Module-level so it persists across calls within the same server process.
 * Resets to null on server restart (first call always fetches).
 */
let lastSuccessfulFetch: number | null = null;

/**
 * Input schema for the list-all-tasks-today tool
 */
const listAllTasksTodayInputSchema = {
  includeGithub: z.boolean().describe("Include GitHub PRs and issues (default: true)").optional(),
  force: z
    .boolean()
    .describe(
      "Force a fresh fetch even if data was recently fetched. Use when the user explicitly asks to refresh."
    )
    .optional(),
  includeRecentlyCompleted: z
    .boolean()
    .describe(
      "Include Linear issues completed within the last `completedDaysBack` days alongside actionable items. Use when the user asks what they recently finished or shipped. Default: false."
    )
    .optional(),
  completedDaysBack: z
    .number()
    .describe("How many days back to include recently-completed Linear issues. Default: 3.")
    .optional(),
};

/**
 * Registers the list-all-tasks-today tool with the MCP server
 *
 * This tool fetches from all sources, enriches with priority metadata, and writes
 * to the task store. Returns a confirmation with per-source item counts.
 * Use read-dashboard-tasks to access the full data.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerListAllTasksTodayTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-all-tasks-today",
    {
      title: "Fetch All Tasks Today",
      description:
        "Fetch tasks and events from all sources, enrich with priority metadata, and write to the task store. Returns a confirmation with per-source item counts — use read-dashboard-tasks to access the full data. Sources: Calendar, Linear, Gmail, Google Drive, GitHub, Slack, Meeting Notes (Granola).",
      inputSchema: listAllTasksTodayInputSchema,
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: MCP tool handler — multi-source aggregation
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

      // ============================================
      // FRESHNESS GUARD: skip redundant re-fetches
      // ============================================
      const guardTimestamp = Date.now();
      const elapsedSeconds =
        lastSuccessfulFetch !== null ? (guardTimestamp - lastSuccessfulFetch) / 1000 : Infinity;

      if (!args.force && elapsedSeconds < FRESHNESS_WINDOW_SECONDS) {
        const secondsSinceFetch = Math.round(elapsedSeconds);
        const suggestedWait = FRESHNESS_WINDOW_SECONDS - secondsSinceFetch;

        // Read counts + metadata from the existing task store
        let counts: ReturnType<typeof buildCounts> | null = null;
        let metadata: Record<string, unknown> = {};
        try {
          const taskStorePath = path.join(process.cwd(), "data", "latest-tasks.json");
          const raw = JSON.parse(await fs.readFile(taskStorePath, "utf-8"));
          counts = buildCounts(raw);
          metadata = raw.metadata ?? {};
        } catch {
          // Task store unreadable — fall through to normal fetch
        }

        if (counts) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "fresh",
                  message: `Tasks were fetched from all sources ${secondsSinceFetch} seconds ago and are still current. Use read-dashboard-tasks to access this data. To force a fresh fetch, call again with force: true.`,
                  secondsSinceFetch,
                  suggestedWait,
                  counts,
                  metadata,
                }),
              },
            ],
          };
        }
      }

      const includeGithub = args.includeGithub ?? true;
      const today = new Date();
      const errors: string[] = [];
      const failedSources: string[] = [];
      const sourceErrors: StructuredToolError[] = [];

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
      let docCommentEmails: DocCommentEmail[] = [];

      // ============================================
      // PARALLEL FETCH: All sources run concurrently
      // ============================================
      const sevenDaysFromNow = new Date(today);
      sevenDaysFromNow.setDate(today.getDate() + 7);
      sevenDaysFromNow.setHours(23, 59, 59, 999);

      const fetchResults = await Promise.allSettled([
        // 0: Calendar
        (async () => {
          const token = await exchangeToken(authInfo, CALENDAR_RESOURCE, CALENDAR_SCOPES);
          return fetchTodayCalendarEvents(token.accessToken);
        })(),

        // 1: Linear
        (async () => {
          const token = await exchangeToken(authInfo, LINEAR_RESOURCE, LINEAR_SCOPES);
          return fetchLinearIssues(token.accessToken, sevenDaysFromNow, {
            includeRecentlyCompleted: args.includeRecentlyCompleted ?? false,
            completedDaysBack: args.completedDaysBack ?? 3,
          });
        })(),

        // 2: Gmail (todos + meeting summaries + doc comment emails share one STS exchange)
        (async () => {
          const token = await exchangeToken(authInfo, GMAIL_RESOURCE, GMAIL_SCOPES);
          const [gmailResult, summaries] = await Promise.all([
            fetchGmailTodos(token.accessToken, {
              daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
              maxResults: FETCH_LIMITS.GMAIL,
              includeRead: true,
              strictFiltering: false,
            }),
            fetchMeetingSummaries(token.accessToken, {
              daysBack: TIME_WINDOWS.DEFAULT_DAYS_BACK,
              maxResults: FETCH_LIMITS.MEETINGS,
            }),
          ]);
          return {
            todos: gmailResult.emails,
            summaries,
            docCommentEmails: gmailResult.docCommentEmails,
          };
        })(),

        // 3: Google Drive v3 (files with action items for this user)
        (async () => {
          const token = await exchangeToken(authInfo, DRIVE_RESOURCE, DRIVE_SCOPES);
          return fetchDriveActionItems(token.accessToken);
        })(),

        // 4: GitHub (conditional)
        (async () => {
          if (!includeGithub) return { prs: [], issues: [] };
          const token = await exchangeToken(authInfo, GITHUB_RESOURCE);
          return fetchGitHubTodos(token.accessToken);
        })(),

        // 5: Slack
        (async () => {
          const token = await exchangeToken(authInfo, SLACK_RESOURCE, SLACK_SCOPES);
          return fetchSlackMessages(token.accessToken, {
            daysBack: TIME_WINDOWS.SLACK_DAYS_BACK,
            maxMessages: FETCH_LIMITS.SLACK,
          });
        })(),

        // 6: Meeting notes (Granola via Google Drive)
        (async () => {
          const token = await exchangeToken(authInfo, DRIVE_RESOURCE, DRIVE_SCOPES);
          return fetchMeetingNoteActions(token.accessToken, {
            daysBack: TIME_WINDOWS.MEETING_NOTES_DAYS_BACK,
            maxResults: FETCH_LIMITS.MEETINGS,
          });
        })(),
      ]);

      // Unpack results — each source fails independently
      if (fetchResults[0].status === "fulfilled") {
        rawCalendar = fetchResults[0].value;
      } else {
        errors.push(formatAuthError("Google Calendar", fetchResults[0].reason));
        failedSources.push("calendar");
        sourceErrors.push(
          buildStructuredError(
            fetchResults[0].reason,
            "calendar",
            CALENDAR_RESOURCE,
            CALENDAR_SCOPES
          )
        );
      }

      if (fetchResults[1].status === "fulfilled") {
        rawLinear = fetchResults[1].value;
      } else {
        errors.push(formatAuthError("Linear", fetchResults[1].reason));
        failedSources.push("linear");
        sourceErrors.push(
          buildStructuredError(fetchResults[1].reason, "linear", LINEAR_RESOURCE, LINEAR_SCOPES)
        );
      }

      if (fetchResults[2].status === "fulfilled") {
        rawGmail = fetchResults[2].value.todos;
        rawMeetingSummaries = fetchResults[2].value.summaries;
        docCommentEmails = fetchResults[2].value.docCommentEmails;
      } else {
        errors.push(formatAuthError("Gmail", fetchResults[2].reason));
        failedSources.push("gmail");
        sourceErrors.push(
          buildStructuredError(fetchResults[2].reason, "gmail", GMAIL_RESOURCE, GMAIL_SCOPES)
        );
      }

      if (fetchResults[3].status === "fulfilled") {
        rawAssignedActions = fetchResults[3].value;
      } else {
        errors.push(formatAuthError("Google Drive", fetchResults[3].reason));
        failedSources.push("drive");
        sourceErrors.push(
          buildStructuredError(fetchResults[3].reason, "drive", DRIVE_RESOURCE, DRIVE_SCOPES)
        );
      }

      if (fetchResults[4].status === "fulfilled") {
        rawGithubPRs = fetchResults[4].value.prs;
        rawGithubIssues = fetchResults[4].value.issues;
      } else if (includeGithub) {
        errors.push(formatAuthError("GitHub", fetchResults[4].reason));
        failedSources.push("github");
        sourceErrors.push(
          buildStructuredError(fetchResults[4].reason, "github", GITHUB_RESOURCE, [])
        );
      }

      if (fetchResults[5].status === "fulfilled") {
        rawSlack = fetchResults[5].value;
      } else {
        errors.push(formatAuthError("Slack", fetchResults[5].reason));
        failedSources.push("slack");
        sourceErrors.push(
          buildStructuredError(fetchResults[5].reason, "slack", SLACK_RESOURCE, SLACK_SCOPES)
        );
      }

      if (fetchResults[6].status === "fulfilled") {
        rawMeetingNotes = fetchResults[6].value;
      } else {
        errors.push(formatAuthError("Meeting Notes (via Google Drive)", fetchResults[6].reason));
        failedSources.push("meeting-notes");
        sourceErrors.push(
          buildStructuredError(fetchResults[6].reason, "granola", DRIVE_RESOURCE, DRIVE_SCOPES)
        );
      }

      // ============================================
      // POST-PROCESSING: Verify doc comment emails
      // ============================================
      // Gmail-discovered doc comment emails need Drive v3 verification to
      // check if comments are still unresolved and get counts. This runs
      // after parallel fetches because it needs both Gmail results (fetch #2)
      // and a Drive v3 token.
      if (docCommentEmails.length > 0) {
        try {
          const driveToken = await exchangeToken(authInfo, DRIVE_RESOURCE, DRIVE_SCOPES);

          if (driveToken) {
            // Dedup: skip docs already surfaced via @mention/assignment
            const existingFileIds = new Set(
              rawAssignedActions.map((a) => a.fileId).filter((id): id is string => !!id)
            );

            const verifiedComments = await verifyAndEnrichDocComments(
              docCommentEmails,
              driveToken.accessToken,
              existingFileIds
            );

            rawAssignedActions.push(...verifiedComments);
          }
        } catch {
          // Non-fatal: doc comment verification is best-effort
          errors.push("Doc comment verification failed (Drive v3)");
        }
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
        stableId: computeStableId("calendar", event),
        priorityMetadata: calculateCalendarPriority(event, now),
      }));

      let linearIssues: EnrichedLinearIssue[] = rawLinear.map((issue) => ({
        ...issue,
        taskId: randomUUID(),
        stableId: computeStableId("linear", issue),
        priorityMetadata: calculateLinearPriority(issue, now),
      }));

      let gmailTodos: EnrichedGmailMessage[] = rawGmail.map((email) => ({
        ...email,
        taskId: randomUUID(),
        stableId: computeStableId("gmail", email),
        priorityMetadata: calculateEmailPriority(email, now),
      }));

      let meetingSummaries: EnrichedMeetingSummary[] = rawMeetingSummaries.map((summary) => ({
        ...summary,
        taskId: randomUUID(),
        stableId: computeStableId("meeting-summary", summary),
        priorityMetadata: calculateMeetingSummaryPriority(summary, now),
      }));

      let assignedActions: EnrichedAssignedAction[] = rawAssignedActions.map((action) => ({
        ...action,
        taskId: randomUUID(),
        stableId: computeStableId("drive", action),
        priorityMetadata: calculateDrivePriority(action, now),
      }));

      let githubPRs: EnrichedGitHubPR[] = rawGithubPRs.map((pr) => ({
        ...pr,
        taskId: randomUUID(),
        stableId: computeStableId("github-pr", pr),
        priorityMetadata: calculateGitHubPriority(pr, now),
      }));

      let githubIssues: EnrichedGitHubIssue[] = rawGithubIssues.map((issue) => ({
        ...issue,
        taskId: randomUUID(),
        stableId: computeStableId("github-issue", issue),
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
          stableId: computeStableId("slack", msg),
          title: summarizeSlackMessage(msg.text, msg.type, msg.files),
          timestamp: isoTimestamp,
          priorityMetadata,
        };
      });

      // Enrich meeting notes with taskId, stableId, and priorityMetadata
      const meetingNoteActions: EnrichedMeetingNote[] = rawMeetingNotes.map((note) => ({
        ...note,
        taskId: randomUUID(),
        stableId: computeStableId("meeting-note", note),
        priorityMetadata: note.priorityMetadata ?? calculateMeetingNotePriority(note, now),
      }));

      // Apply persisted priority overrides before sorting
      await applyOverridesToTasks(
        calendarEvents,
        linearIssues,
        gmailTodos,
        meetingSummaries,
        assignedActions,
        githubPRs,
        githubIssues,
        slackMessages,
        meetingNoteActions
      );

      // Sort by priority score (highest first) so the task store is in priority order
      const byPriority = (
        a: { priorityMetadata?: PriorityMetadata },
        b: { priorityMetadata?: PriorityMetadata }
      ) => (b.priorityMetadata?.score ?? 0) - (a.priorityMetadata?.score ?? 0);

      linearIssues = linearIssues.sort(byPriority);
      gmailTodos = gmailTodos.sort(byPriority);
      slackMessages = slackMessages.sort(byPriority);
      githubPRs = githubPRs.sort(byPriority);
      githubIssues = githubIssues.sort(byPriority);
      assignedActions = assignedActions.sort(byPriority);
      meetingSummaries = meetingSummaries.sort(byPriority);

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
          slackMessages,
          meetingNoteActions,
          meetingSummaries,
          calendarEvents
        );
      }

      for (const pr of githubPRs) {
        pr.crossReferenceMetadata = detectGitHubMentions(
          pr.repo,
          pr.number,
          gmailTodos,
          slackMessages,
          meetingNoteActions,
          meetingSummaries,
          calendarEvents
        );
      }

      for (const issue of githubIssues) {
        issue.crossReferenceMetadata = detectGitHubMentions(
          issue.repo,
          issue.number,
          gmailTodos,
          slackMessages,
          meetingNoteActions,
          meetingSummaries,
          calendarEvents
        );
      }

      // 2.5. Relations: Merge API blocking into deps + inject into cross-refs
      enrichRelations(linearIssues);

      // 2.6. Calendar cross-refs: Link calendar events that reference Linear issues (URL-based)
      buildCalendarCrossRefs(calendarEvents, linearIssues);

      // 2.7. Source cross-refs: Populate Gmail, Slack, Meeting Notes with referenced Linear issues
      buildSourceLinearCrossRefs(linearIssues, gmailTodos, slackMessages, meetingNoteActions);

      // 2.8. Calendar GitHub cross-refs: Link calendar events that reference GitHub PRs/issues (URL-based)
      buildCalendarGitHubCrossRefs(calendarEvents, githubPRs, githubIssues);

      // 2.9. Source GitHub cross-refs: Populate Gmail, Slack, Meeting Notes with referenced GitHub items
      buildSourceGitHubCrossRefs(
        githubPRs,
        githubIssues,
        gmailTodos,
        slackMessages,
        meetingNoteActions
      );

      // 3. Meeting prep: Generate context for calendar events (skip non-meeting types)
      for (const meeting of calendarEvents) {
        const apiEventType = meeting.eventType || "default";
        if (apiEventType !== "default") continue;

        meeting.meetingContextMetadata = generateMeetingContext(
          meeting,
          linearIssues,
          { prs: githubPRs, issues: githubIssues },
          gmailTodos,
          meetingSummaries
        );
      }

      // 4. Prep blocks: Link focusTime prep-prefixed blocks to the next meeting's context
      const prepPrefix = config.calendarPrepPrefix.toLowerCase();
      for (let i = 0; i < calendarEvents.length; i++) {
        const event = calendarEvents[i];
        if ((event.eventType || "default") !== "focusTime") continue;
        if (!event.summary || !event.summary.toLowerCase().startsWith(prepPrefix)) continue;

        // Find next default-type meeting after this prep block in the sorted list
        for (let j = i + 1; j < calendarEvents.length; j++) {
          const next = calendarEvents[j];
          if ((next.eventType || "default") === "default") {
            event.meetingContextMetadata = next.meetingContextMetadata;
            break;
          }
        }
      }

      // 5. Meeting assets: Link Zoom "meeting assets" emails to Granola notes & calendar events
      linkMeetingAssets(meetingSummaries, meetingNoteActions, calendarEvents);

      // Build response data
      const responseData: ListAllTasksResponse = {
        calendar: calendarEvents,
        linear: linearIssues,
        gmail: gmailTodos,
        meetingSummaries,
        drive: assignedActions,
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
          failedSources: failedSources.length > 0 ? failedSources : undefined,
        },
      };

      // Filter dismissed tasks at the source so every consumer
      // (MCP response, task store file, REST readers) gets clean data.
      await filterCompletedTasks(responseData);

      // Write full data to local file so the UI can read it without auth.
      // Awaited so the task store is fresh when the UI re-fetches after a chat tool call.
      // `writeTaskStore` serializes with `removeTaskFromStore` / `mutateTaskStore`
      // so a concurrent dashboard dismiss can't overwrite this refresh.
      try {
        await writeTaskStore(responseData);
        // Only guard future calls when every source succeeded — partial failures
        // should allow immediate retry without hitting the freshness guard.
        if (failedSources.length === 0) {
          lastSuccessfulFetch = Date.now();
        }
      } catch {
        // Non-fatal: task store write failed
      }

      // Return confirmation with per-source counts.
      // Full data is in the task store — use read-dashboard-tasks to access it.
      // `_meta.sourceErrors` carries structured per-source error detail for
      // the UI; the JSON text content is what the LLM sees (unchanged).
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              counts: buildCounts(responseData),
              metadata: responseData.metadata,
            }),
          },
        ],
        ...(sourceErrors.length > 0 ? { _meta: { sourceErrors } } : {}),
      };
    }) as AuthenticatedToolHandlerWithArgs<typeof listAllTasksTodayInputSchema>
  );
}
