import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod";
import { stsClient } from "../services/sts-client";

const CALENDAR_RESOURCE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const LINEAR_RESOURCE = "https://api.linear.app";
const LINEAR_SCOPES = ["read"];
const GMAIL_RESOURCE = "https://www.googleapis.com/gmail/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const DRIVE_ACTIVITY_RESOURCE = "https://driveactivity.googleapis.com";
const DRIVE_ACTIVITY_SCOPES = ["https://www.googleapis.com/auth/drive.activity.readonly"];

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
};

/**
 * Calendar event with full details
 */
interface CalendarEventDetail {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string;
      uri?: string;
    }>;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    self?: boolean;
  }>;
}

/**
 * Fetches today's calendar events with full details
 */
async function fetchTodayCalendarEvents(accessToken: string): Promise<CalendarEventDetail[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    new URLSearchParams({
      maxResults: "20",
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as { items?: CalendarEventDetail[] };
  return data.items || [];
}

/**
 * Linear issue with full details
 */
interface LinearIssueDetail {
  identifier: string;
  title: string;
  priority: number;
  priorityLabel: string;
  url: string;
  state: { name: string; type: string } | null;
  dueDate: string | null;
  estimate: number | null;
  project: { name: string } | null;
}

/**
 * Fetches Linear issues assigned to the user
 */
async function fetchLinearIssues(accessToken: string): Promise<LinearIssueDetail[]> {
  const query = `
    query MyIssues($first: Int, $filter: IssueFilter) {
      viewer {
        assignedIssues(first: $first, filter: $filter) {
          nodes {
            id
            identifier
            title
            priority
            priorityLabel
            url
            state {
              name
              type
            }
            dueDate
            estimate
            project {
              name
            }
          }
        }
      }
    }
  `;

  const filter = {
    state: { type: { nin: ["completed", "canceled"] } }
  };

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query,
      variables: { first: 20, filter },
    }),
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as {
    data?: {
      viewer?: {
        assignedIssues?: {
          nodes: LinearIssueDetail[];
        };
      };
    };
  };

  const issues = data.data?.viewer?.assignedIssues?.nodes || [];
  
  // Filter for issues due today or overdue
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  return issues.filter(issue => {
    if (!issue.dueDate) return true; // Include issues without due dates
    const dueDate = new Date(issue.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    return dueDate <= today; // Include today or overdue
  });
}

/**
 * Gmail message detail
 */
interface GmailMessageDetail {
  id: string;
  subject: string;
  from: string;
  link: string;
}

/**
 * Fetches Gmail todos
 */
async function fetchGmailTodos(accessToken: string): Promise<GmailMessageDetail[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const afterDate = Math.floor(today.getTime() / 1000);
  
  const query = `(is:unread OR is:important) after:${afterDate}`;

  const messagesResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?` +
    new URLSearchParams({
      q: query,
      maxResults: "10",
    }),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!messagesResponse.ok) {
    return [];
  }

  const messagesData = await messagesResponse.json() as { messages?: Array<{ id: string }> };
  if (!messagesData.messages || messagesData.messages.length === 0) {
    return [];
  }

  // Fetch message details
  const messagePromises = messagesData.messages.slice(0, 10).map(msg =>
    fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    ).then(r => r.ok ? r.json() : null)
  );

  const messages = (await Promise.all(messagePromises)).filter(Boolean) as Array<{
    payload?: {
      headers?: Array<{ name?: string; value?: string }>;
    };
    snippet?: string;
    id: string;
  }>;

  return messages.map(message => {
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) => 
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;
    
    return {
      id: message.id,
      subject: getHeader("subject") || "(No subject)",
      from: getHeader("from") || "Unknown",
      link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
    };
  });
}

/**
 * Assigned action detail
 */
interface AssignedActionDetail {
  fileTitle: string;
  actionType: string;
  fileLink: string | null;
}

/**
 * Fetches assigned actions from Google Docs
 */
async function fetchAssignedActions(accessToken: string): Promise<AssignedActionDetail[]> {
  const daysBack = 7;
  const maxResults = 20;
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - daysBack);

  const response = await fetch(
    "https://driveactivity.googleapis.com/v2/activity:query",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pageSize: maxResults,
        filter: `time >= "${startTime.toISOString()}" AND detail.action_detail_case:COMMENT`,
      }),
    }
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as {
    activities?: Array<{
      primaryActionDetail?: {
        comment?: {
          mentionedUsers?: Array<{ knownUser?: { isCurrentUser?: boolean } }>;
          assignment?: {
            assignedUser?: { knownUser?: { isCurrentUser?: boolean } };
          };
        };
      };
      targets?: Array<{
        driveItem?: {
          title?: string;
          name?: string;
        };
      }>;
      timestamp?: string;
    }>;
  };

  const activities = data.activities || [];
  const actionItems: AssignedActionDetail[] = [];

  for (const activity of activities) {
    const comment = activity.primaryActionDetail?.comment;
    if (!comment) continue;

    const wasAssigned = comment.assignment?.assignedUser?.knownUser?.isCurrentUser;
    const wasMentioned = comment.mentionedUsers?.some(u => u.knownUser?.isCurrentUser);

    if (wasAssigned || wasMentioned) {
      const target = activity.targets?.[0];
      const fileTitle = target?.driveItem?.title || "Untitled";
      const fileId = target?.driveItem?.name?.match(/^items\/(.+)$/)?.[1];
      const fileLink = fileId ? `https://docs.google.com/document/d/${fileId}` : null;
      
      let actionType = "";
      if (comment.assignment) {
        actionType = "assigned to you";
      } else if (wasMentioned) {
        actionType = "mentioned you";
      }

      actionItems.push({
        fileTitle,
        actionType,
        fileLink,
      });
    }
  }

  return actionItems;
}

/**
 * Registers the list-today-todos tool with the MCP server
 *
 * This tool aggregates tasks from multiple sources:
 * - Calendar events for today
 * - Linear issues due today or overdue
 * - Gmail emails needing attention
 * - Assigned actions from Google Docs
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerTodayTodosTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-today-todos",
    {
      title: "List Today's Todos",
      description: "Get a comprehensive view of everything you need to do today, aggregated from Calendar, Linear, Gmail, and Google Docs. Use this when the user asks 'what do I have to do today?', 'what's on my plate?', or 'show me my tasks'.",
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

      const errors: string[] = [];
      let calendarEvents: CalendarEventDetail[] = [];
      let linearIssues: LinearIssueDetail[] = [];
      let gmailTodos: GmailMessageDetail[] = [];
      let assignedActions: AssignedActionDetail[] = [];

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
            errors.push(`Calendar: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        // Fetch Linear issues
        if (includeLinear) {
          try {
            const linearToken = await stsClient.exchange(
              authInfo,
              LINEAR_RESOURCE,
              LINEAR_SCOPES
            );
            linearIssues = await fetchLinearIssues(linearToken.access_token);
          } catch (error) {
            errors.push(`Linear: ${error instanceof Error ? error.message : "Unknown error"}`);
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
            errors.push(`Gmail: ${error instanceof Error ? error.message : "Unknown error"}`);
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
            errors.push(`Assigned Actions: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        // Build calendar-style output
        const today = new Date();
        const todayStr = today.toLocaleDateString("en-US", { 
          weekday: "long", 
          year: "numeric", 
          month: "long", 
          day: "numeric" 
        });

        let output = `# 📅 ${todayStr}\n\n`;

        // Sort calendar events by time
        calendarEvents.sort((a, b) => {
          const aTime = a.start?.dateTime ? new Date(a.start.dateTime).getTime() : 0;
          const bTime = b.start?.dateTime ? new Date(b.start.dateTime).getTime() : 0;
          return aTime - bTime;
        });

        // Build time-ordered calendar view
        if (calendarEvents.length > 0) {
          output += `## 📅 Schedule\n\n`;
          
          for (const event of calendarEvents) {
            const title = event.summary || "Untitled";
            const startRaw = event.start?.dateTime || event.start?.date || "";
            const isAllDay = !event.start?.dateTime;
            
            let timeStr = "";
            if (isAllDay) {
              timeStr = "**All day**";
            } else if (startRaw) {
              const startDate = new Date(startRaw);
              const endDate = event.end?.dateTime ? new Date(event.end.dateTime) : null;
              
              timeStr = `**${startDate.toLocaleTimeString("en-US", { 
                hour: "numeric", 
                minute: "2-digit",
                hour12: true 
              })}**`;
              
              if (endDate) {
                timeStr += ` - ${endDate.toLocaleTimeString("en-US", { 
                  hour: "numeric", 
                  minute: "2-digit",
                  hour12: true 
                })}`;
              }
            }

            output += `### ${timeStr} | ${title}\n`;
            
            if (event.location) {
              output += `📍 ${event.location}\n`;
            }
            
            // Get meeting link (prefer conferenceData, fall back to hangoutLink)
            let meetingLink = "";
            if (event.conferenceData?.entryPoints) {
              const videoEntry = event.conferenceData.entryPoints.find(
                ep => ep.entryPointType === "video"
              );
              if (videoEntry?.uri) {
                meetingLink = videoEntry.uri;
              }
            } else if (event.hangoutLink) {
              meetingLink = event.hangoutLink;
            }
            
            if (meetingLink) {
              output += `🔗 [Join Meeting](${meetingLink})\n`;
            }
            
            if (event.htmlLink) {
              output += `📎 [View in Calendar](${event.htmlLink})\n`;
            }
            
            output += `\n`;
          }
        }

        // Add Linear issues
        if (linearIssues.length > 0) {
          output += `## 📋 Tasks & Issues\n\n`;
          
          for (const issue of linearIssues) {
            const priorityEmojis: Record<number, string> = {
              0: "⚪",
              1: "🔴",
              2: "🟠",
              3: "🟡",
              4: "🟢",
            };
            const priority = `${priorityEmojis[issue.priority] || "⚪"} ${issue.priorityLabel}`;
            const estimate = issue.estimate ? `[${issue.estimate}pts]` : "";
            const project = issue.project?.name ? `(${issue.project.name})` : "";
            
            output += `### ${issue.identifier}: ${issue.title}\n`;
            output += `${priority} ${estimate} ${project}\n`;
            
            if (issue.dueDate) {
              const due = new Date(issue.dueDate);
              const daysUntilDue = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              if (daysUntilDue < 0) {
                output += `⚠️ **OVERDUE**\n`;
              } else if (daysUntilDue === 0) {
                output += `🔥 **Due today**\n`;
              }
            }
            
            output += `🔗 [View in Linear](${issue.url})\n\n`;
          }
        }

        // Add Gmail todos
        if (gmailTodos.length > 0) {
          output += `## 📧 Email - Needs Attention\n\n`;
          
          for (const email of gmailTodos) {
            output += `### ${email.subject}\n`;
            output += `From: ${email.from}\n`;
            output += `🔗 [Open in Gmail](${email.link})\n\n`;
          }
        }

        // Add assigned actions
        if (assignedActions.length > 0) {
          output += `## 📝 Assigned Actions\n\n`;
          
          for (const action of assignedActions) {
            output += `### ${action.fileTitle}\n`;
            output += `${action.actionType}\n`;
            if (action.fileLink) {
              output += `🔗 [Open Document](${action.fileLink})\n`;
            }
            output += `\n`;
          }
        }

        // Summary
        if (calendarEvents.length === 0 && linearIssues.length === 0 && 
            gmailTodos.length === 0 && assignedActions.length === 0) {
          output += `🎉 **Nothing scheduled!** You're all caught up.\n\n`;
          output += "No calendar events, Linear issues due today, urgent emails, or assigned actions found.";
        } else {
          const totalItems = calendarEvents.length + linearIssues.length + 
                           gmailTodos.length + assignedActions.length;
          output += `---\n\n`;
          output += `**Summary:** ${calendarEvents.length} events, ${linearIssues.length} issues, `;
          output += `${gmailTodos.length} emails, ${assignedActions.length} actions (${totalItems} total)`;
        }

        if (errors.length > 0) {
          output += `\n\n⚠️ **Some sources couldn't be accessed:**\n${errors.map(e => `- ${e}`).join("\n")}`;
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
