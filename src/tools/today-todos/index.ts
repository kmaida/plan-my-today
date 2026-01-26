import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../../types/index";
import { z } from "zod";
import { stsClient } from "../../services/sts-client";
import type {
  CalendarEventDetail,
  LinearIssueDetail,
  GmailMessageDetail,
  AssignedActionDetail,
  GitHubPRDetail,
  GitHubIssueDetail,
  SlackReminderDetail,
  TimeBlock,
  CategorizedIssues,
  TimelineItem,
} from "./types";
import { fetchTodayCalendarEvents, findAvailableTimeBlocks } from "./calendar-utils";
import { fetchLinearIssues, categorizeIssues, detectThemes } from "./linear-utils";
import { fetchGmailTodos } from "./email-utils";
import { fetchAssignedActions } from "./docs-utils";
import { fetchGitHubTodos } from "./github-utils";
import { fetchSlackReminders } from "./slack-utils";
import { generateProductivityInsights, generateLookahead } from "./insights";
import { createUnifiedTimeline, buildListOutput, calculateQuickActionPriority } from "./timeline";
import * as slackTokenStore from "../../services/slack-token-store";
import { extractUserIdFromAuthInfo } from "../../utils/auth-utils";
import { config } from "../../config";
import { formatAuthError, getErrorFooter } from "../../utils/error-utils";

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
 * Input schema for the list-today-todos tool
 */
const todayTodosInputSchema = {
  includeCalendar: z.boolean()
    .describe("Include calendar events (default: true)")
    .optional(),
  includeLinear: z.boolean()
    .describe("Include Linear issues (default: true)")
    .optional(),
  includeGmail: z.boolean()
    .describe("Include Gmail todos (default: true)")
    .optional(),
  includeAssignedActions: z.boolean()
    .describe("Include assigned actions from Google Docs (default: true)")
    .optional(),
  includeGithub: z.boolean()
    .describe("Include GitHub PRs and issues (default: true)")
    .optional(),
  includeSlack: z.boolean()
    .describe("Include Slack reminders (default: false, opt-in)")
    .optional(),
  showOnlyRemaining: z.boolean()
    .describe("Show only items that haven't passed yet based on current time (default: false). Use this when asking 'what do I have left to do?' or 'what's remaining?'")
    .optional(),
};

/**
 * Registers the list-today-todos tool with the MCP server
 *
 * This tool aggregates tasks from multiple sources:
 * - Calendar events for today
 * - Linear issues due today or overdue
 * - Gmail emails needing attention
 * - Assigned actions from Google Docs
 * - GitHub PRs and issues assigned to you
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerTodayTodosTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-today-todos",
    {
      title: "List Today's Todos",
      description: "Get a comprehensive view of everything you need to do today, aggregated from Calendar, Linear, Gmail, Google Docs, GitHub, and Slack reminders. Use this when the user asks 'what do I have to do today?', 'what's on my plate?', 'show me my tasks', 'what do I have left to do?', or 'what's remaining?'.",
      inputSchema: todayTodosInputSchema,
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

      const includeCalendar = args.includeCalendar ?? true;
      const includeLinear = args.includeLinear ?? true;
      const includeGmail = args.includeGmail ?? true;
      const includeAssignedActions = args.includeAssignedActions ?? true;
      const includeGithub = args.includeGithub ?? true;
      const includeSlack = args.includeSlack ?? false;
      const showOnlyRemaining = args.showOnlyRemaining ?? false;

      const errors: string[] = [];
      let calendarEvents: CalendarEventDetail[] = [];
      let linearIssues: LinearIssueDetail[] = [];
      let gmailTodos: GmailMessageDetail[] = [];
      let assignedActions: AssignedActionDetail[] = [];
      let githubPRs: GitHubPRDetail[] = [];
      let githubIssues: GitHubIssueDetail[] = [];
      let slackReminders: SlackReminderDetail[] = [];

      try {
        // Fetch calendar events
        if (includeCalendar) {
          try {
            const calendarToken = await stsClient.exchange(
              authInfo,
              CALENDAR_RESOURCE,
              CALENDAR_SCOPES
            );
            calendarEvents = await fetchTodayCalendarEvents(calendarToken.access_token);
          } catch (error) {
            errors.push(formatAuthError("Calendar", error));
          }
        }

        // Calculate 7 days from now
        const today = new Date();
        const sevenDaysFromNow = new Date(today);
        sevenDaysFromNow.setDate(today.getDate() + 7);
        sevenDaysFromNow.setHours(23, 59, 59, 999);

        // Fetch Linear issues
        if (includeLinear) {
          try {
            const linearToken = await stsClient.exchange(
              authInfo,
              LINEAR_RESOURCE,
              LINEAR_SCOPES
            );
            linearIssues = await fetchLinearIssues(linearToken.access_token, sevenDaysFromNow);
          } catch (error) {
            errors.push(formatAuthError("Linear", error));
          }
        }

        // Fetch Gmail todos
        if (includeGmail) {
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
        }

        // Fetch assigned actions
        if (includeAssignedActions) {
          try {
            const driveToken = await stsClient.exchange(
              authInfo,
              DRIVE_ACTIVITY_RESOURCE,
              DRIVE_ACTIVITY_SCOPES
            );
            assignedActions = await fetchAssignedActions(driveToken.access_token);
          } catch (error) {
            errors.push(formatAuthError("Assigned Actions", error));
          }
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

        // Fetch Slack reminders
        if (includeSlack) {
          try {
            // Check for environment variable token first (single-user deployment)
            if (config.slackUserToken) {
              slackReminders = await fetchSlackReminders(config.slackUserToken);
            } else {
              // Fall back to token store (multi-user OAuth flow)
              const userId = extractUserIdFromAuthInfo(authInfo);
              const slackToken = await slackTokenStore.getToken(userId);

              if (slackToken) {
                slackReminders = await fetchSlackReminders(slackToken.access_token);
              } else {
                errors.push("Slack: Not connected. Set SLACK_USER_TOKEN environment variable or use 'connect-slack' tool.");
              }
            }
          } catch (error) {
            errors.push(formatAuthError("Slack", error));
          }
        }

        // Build table output with integrated recommendations
        // (today is already defined above, but normalize it for date comparisons)
        const todayNormalized = new Date(today);
        todayNormalized.setHours(0, 0, 0, 0);
        const todayStr = today.toLocaleDateString("en-US", { 
          weekday: "long", 
          year: "numeric", 
          month: "long", 
          day: "numeric" 
        });

        // Analyze calendar and tasks
        const timeBlocks = findAvailableTimeBlocks(calendarEvents);
        const categorizedIssues = categorizeIssues(linearIssues, todayNormalized);

        // Create unified timeline
        let timeline = createUnifiedTimeline(
          calendarEvents,
          timeBlocks,
          categorizedIssues,
          linearIssues,
          gmailTodos,
          assignedActions,
          slackReminders
        );

        // Filter timeline to show only remaining items if requested
        const now = new Date();
        if (showOnlyRemaining) {
          timeline = timeline.filter(item => {
            // Filter out all items that have ended (meetings, work blocks, focus blocks, etc.)
            return item.end >= now;
          });
        }

        // Generate insights
        const themes = detectThemes(calendarEvents, linearIssues);
        const insights = generateProductivityInsights(calendarEvents, timeBlocks, linearIssues, categorizedIssues, gmailTodos, assignedActions);
        const lookahead = generateLookahead(calendarEvents, gmailTodos, linearIssues);
        
        // Calculate summary stats for remaining items
        const remainingTimeBlocks = showOnlyRemaining 
          ? timeBlocks.filter(block => block.end >= now)
          : timeBlocks;
        const totalAvailableMinutes = remainingTimeBlocks.reduce((sum, block) => sum + block.durationMinutes, 0);
        const hours = Math.floor(totalAvailableMinutes / 60);
        const minutes = totalAvailableMinutes % 60;
        // Count only actual meetings (not solo focus blocks) that are remaining
        const timedMeetings = timeline.filter(item => item.type === "meeting" && !item.title.includes("(All day)")).length;
        
        // Build output
        let output = `# 📅 ${todayStr}\n\n`;
        
        // Show current time if filtering
        if (showOnlyRemaining) {
          const currentTime = now.toLocaleTimeString("en-US", { 
            hour: "numeric", 
            minute: "2-digit", 
            hour12: true 
          });
          output += `## ⏰ What's Left (as of ${currentTime})\n\n`;
        }
        
        // Day Overview with focus areas
        const mainThemes = themes.filter(t => t.isMainFocus);
        if (mainThemes.length > 0) {
          output += `## 🎯 Today's Focus\n\n`;
          for (const theme of mainThemes.slice(0, 2)) {
            output += `- **${theme.theme}** — ${theme.items.length} related items\n`;
          }
          output += `\n---\n\n`;
        }
        
        // Quick stats line
        if (showOnlyRemaining && timeline.length === 0) {
          output += `🎉 **All done for today!** No remaining items scheduled.\n\n`;
        } else {
          output += `📊 **${timedMeetings} meeting${timedMeetings !== 1 ? "s" : ""} remaining** · **${hours}h ${minutes}m focus time left** · **${linearIssues.length} tasks** due within 7 days\n\n`;
        }
        
        // Productivity Insights
        if (insights.length > 0) {
          output += `---\n\n## 💡 Productivity Tips\n\n`;
          for (const insight of insights) {
            output += `- ${insight}\n`;
          }
          output += `\n---\n\n`;
        } else {
          // Add separator before "Your Day" even if no insights
          output += `---\n\n`;
        }
        
        // Schedule
        if (showOnlyRemaining) {
          output += `## 📋 What's Remaining\n\n`;
        } else {
          output += `## 📋 Your Day\n\n`;
        }
        
        if (timeline.length === 0 && showOnlyRemaining) {
          output += `✨ Nothing scheduled for the rest of today!\n\n`;
        } else {
          output += buildListOutput(timeline);
        }
        
        // Lookahead / Prep
        if (lookahead.length > 0) {
          output += `\n---\n\n## 🔮 Looking Ahead\n\n`;
          for (const item of lookahead) {
            if (item.link) {
              // Use provided linkText, or extract issue ID, or fall back to "View"
              let linkText = item.linkText;
              if (!linkText) {
                const issueMatch = item.link.match(/issue\/([A-Z]+-\d+)/);
                linkText = issueMatch ? issueMatch[1] : "View";
              }
              output += `- ${item.text} [${linkText}](${item.link})\n`;
            } else {
              output += `- ${item.text}\n`;
            }
          }
          output += `\n`;
        }
        
        // Remaining tasks not scheduled
        const scheduledIssueIds = new Set<string>();
        for (const item of timeline) {
          if (item.links.linear) {
            // Extract issue ID from URL
            const match = item.links.linear.match(/issue\/([A-Z]+-\d+)/);
            if (match) scheduledIssueIds.add(match[1]);
          }
        }
        const unscheduledIssues = linearIssues.filter(i => !scheduledIssueIds.has(i.identifier));
        const hasOtherTasks = unscheduledIssues.length > 0 || githubPRs.length > 0 || githubIssues.length > 0 || gmailTodos.length > 0 || assignedActions.length > 0;
        
        if (hasOtherTasks) {
          output += `---\n\n## 📌 Other Tasks (not scheduled today)\n\n`;
          
          // Linear issues - always use black circle emoji
          if (unscheduledIssues.length > 0) {
            for (const issue of unscheduledIssues.slice(0, 5)) {
              const dueStr = issue.dueDate 
                ? `due ${new Date(issue.dueDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
                : "no due date";
              output += `- ⚫ [${issue.identifier}](${issue.url}): ${issue.title} (${dueStr})\n`;
            }
            if (unscheduledIssues.length > 5) {
              output += `- ... and ${unscheduledIssues.length - 5} more Linear issues\n`;
            }
            if (githubPRs.length > 0 || githubIssues.length > 0 || gmailTodos.length > 0 || assignedActions.length > 0) {
              output += `\n`;
            }
          }
          
          // Gmail todos - prioritize by importance and recency
          if (gmailTodos.length > 0) {
            const now = new Date();
            const sortedEmails = [...gmailTodos].sort((a, b) => {
              const aPriority = calculateQuickActionPriority(
                { 
                  type: "email", 
                  timestamp: a.timestamp, 
                  isImportant: a.isImportant,
                  isFromIndividual: a.isFromIndividual,
                  needsReply: a.needsReply,
                  hasActionItems: a.hasActionItems,
                },
                now
              );
              const bPriority = calculateQuickActionPriority(
                { 
                  type: "email", 
                  timestamp: b.timestamp, 
                  isImportant: b.isImportant,
                  isFromIndividual: b.isFromIndividual,
                  needsReply: b.needsReply,
                  hasActionItems: b.hasActionItems,
                },
                now
              );
              return bPriority - aPriority;
            });
            
            for (const email of sortedEmails.slice(0, 5)) {
              const updated = email.timestamp ? new Date(email.timestamp) : null;
              let timeAgo = "";
              if (updated) {
                const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
                timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
              }
              
              // Build urgency indicators
              let urgencyIndicators = "";
              if (email.isFromIndividual) {
                if (email.hasActionItems) {
                  urgencyIndicators += "🔴 "; // Urgent: action items from individual
                } else if (email.needsReply) {
                  urgencyIndicators += "⚠️ "; // Needs reply from individual
                }
              }
              const important = email.isImportant ? "⭐ " : "";
              
              // Extract name from "from" field - handle both "Name <email>" and just "email" formats
              const fromMatch = email.from.match(/^(.+?)\s*<.+>$/);
              const fromName = fromMatch ? fromMatch[1].trim() : email.from.split("@")[0] || email.from;
              
              // Highlight individual emails
              const fromDisplay = email.isFromIndividual ? `**${fromName}**` : fromName;
              
              output += `- 📧 ${urgencyIndicators}${important}[${email.subject}](${email.link})${timeAgo ? ` (${timeAgo})` : ""} — ${fromDisplay}\n`;
            }
            if (gmailTodos.length > 5) {
              output += `- ... and ${gmailTodos.length - 5} more emails\n`;
            }
            if (assignedActions.length > 0 || githubPRs.length > 0 || githubIssues.length > 0) {
              output += `\n`;
            }
          }
          
          // Assigned actions from Google Docs
          if (assignedActions.length > 0) {
            const now = new Date();
            const sortedActions = [...assignedActions].sort((a, b) => {
              const aPriority = calculateQuickActionPriority(
                { type: "doc", timestamp: a.timestamp, isAssignment: a.isAssignment },
                now
              );
              const bPriority = calculateQuickActionPriority(
                { type: "doc", timestamp: b.timestamp, isAssignment: b.isAssignment },
                now
              );
              return bPriority - aPriority;
            });
            
            for (const action of sortedActions.slice(0, 5)) {
              const actionType = action.isAssignment ? "assigned" : "mentioned";
              const linkText = action.fileLink ? `[${action.fileTitle}](${action.fileLink})` : action.fileTitle;
              output += `- 📝 ${linkText} (${actionType} in comment)\n`;
            }
            if (assignedActions.length > 5) {
              output += `- ... and ${assignedActions.length - 5} more doc actions\n`;
            }
            if (githubPRs.length > 0 || githubIssues.length > 0) {
              output += `\n`;
            }
          }
          
          // GitHub PRs and Issues
          // Show review-requested PRs first (usually more urgent)
          const reviewPRs = githubPRs.filter(pr => pr.type === "review");
          if (reviewPRs.length > 0) {
            for (const pr of reviewPRs) {
              const draft = pr.isDraft ? "📝 [DRAFT] " : "";
              const updated = new Date(pr.updatedAt);
              const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
              const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
              output += `- 👀 ${draft}[${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (updated ${timeAgo})\n`;
            }
          }

          // Then assigned PRs
          const assignedPRs = githubPRs.filter(pr => pr.type === "assigned");
          if (assignedPRs.length > 0) {
            for (const pr of assignedPRs) {
              const draft = pr.isDraft ? "📝 [DRAFT] " : "";
              const updated = new Date(pr.updatedAt);
              const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
              const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
              output += `- 🔀 ${draft}[${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (updated ${timeAgo})\n`;
            }
          }

          // Then issues
          if (githubIssues.length > 0) {
            for (const issue of githubIssues) {
              const updated = new Date(issue.updatedAt);
              const daysAgo = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
              const timeAgo = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
              const labels = issue.labels && issue.labels.length > 0 
                ? ` • ${issue.labels.slice(0, 3).map(l => `\`${l}\``).join(", ")}`
                : "";
              output += `- 🐛 [${issue.repo}#${issue.number}](${issue.url}): ${issue.title} (updated ${timeAgo}${labels})\n`;
            }
          }
          
          output += `\n`;
        }

        if (errors.length > 0) {
          output += `⚠️ **Some sources couldn't be accessed:**\n${errors.map(e => `- ${e}`).join("\n")}`;

          // Add troubleshooting footer if there are auth-related errors
          const hasAuthErrors = errors.some(e =>
            e.includes("Authentication") ||
            e.includes("check-auth") ||
            e.includes("re-authorize")
          );
          output += getErrorFooter(hasAuthErrors);
        }

        return {
          content: [{
            type: "text",
            text: output
          }]
        };

      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{
            type: "text",
            text: `❌ Error aggregating todos: ${message}`
          }]
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof todayTodosInputSchema>
  );
}
