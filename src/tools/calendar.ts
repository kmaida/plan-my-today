import type { McpServer, AuthenticatedToolHandlerWithArgs } from "../types/index";
import { z } from "zod";
import { stsClient } from "../services/sts-client";

const CALENDAR_RESOURCE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const calendarInputSchema = {
  maxResults: z.number()
    .describe("Maximum number of events to return (default: 10)")
    .optional(),
  timeMin: z.string()
    .describe("Start time in ISO format (default: now)")
    .optional(),
  timeMax: z.string()
    .describe("End time in ISO format (default: 7 days from now)")
    .optional(),
};

export function registerCalendarTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "list-calendar-events",
    {
      title: "List Calendar Events",
      description: "Get upcoming events from the user's Google Calendar. Use this when the user asks about their schedule, calendar, meetings, appointments, or what they have coming up.",
      inputSchema: calendarInputSchema,
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

      try {
        // Exchange user's JWT for a Google Calendar access token
        const tokenResponse = await stsClient.exchange(
          authInfo,
          CALENDAR_RESOURCE,
          CALENDAR_SCOPES
        );

        // Set default time range
        const now = new Date();
        const timeMin = args.timeMin || now.toISOString();
        const timeMax = args.timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const maxResults = args.maxResults || 10;

        // Call Google Calendar API
        const calendarResponse = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
          new URLSearchParams({
            maxResults: maxResults.toString(),
            timeMin: timeMin,
            timeMax: timeMax,
            singleEvents: "true",
            orderBy: "startTime",
          }),
          {
            headers: {
              Authorization: `Bearer ${tokenResponse.access_token}`,
            },
          }
        );

        if (!calendarResponse.ok) {
          const error = await calendarResponse.text();
          return {
            content: [{
              type: "text",
              text: `❌ Google Calendar API error: ${calendarResponse.status} - ${error}`
            }]
          };
        }

        interface CalendarEvent {
          summary?: string;
          description?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          location?: string;
          htmlLink?: string;
          hangoutLink?: string;
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
            organizer?: boolean;
            responseStatus?: string;
          }>;
          organizer?: {
            email?: string;
            displayName?: string;
            self?: boolean;
          };
        }

        const data = await calendarResponse.json() as { items?: CalendarEvent[] };
        const events = data.items || [];

        if (events.length === 0) {
          return {
            content: [{
              type: "text",
              text: "📅 No upcoming events found in the specified time range."
            }]
          };
        }

        // Format events for display
        const lines: string[] = [`📅 **Upcoming Events** (${events.length}):\n`];

        for (const event of events) {
          const startRaw = event.start?.dateTime || event.start?.date || "";
          const isAllDay = !event.start?.dateTime;
          const title = event.summary || "Untitled";

          // Format time nicely
          let timeStr = "";
          if (isAllDay) {
            timeStr = "All day";
          } else if (startRaw) {
            const startDate = new Date(startRaw);
            timeStr = startDate.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true
            });
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

          // Get attendees (exclude self, limit to 3)
          const otherAttendees = (event.attendees || [])
            .filter(a => !a.self)
            .slice(0, 3);
          const attendeeNames = otherAttendees
            .map(a => a.displayName || a.email?.split("@")[0] || "")
            .filter(Boolean);
          const hasMoreAttendees = (event.attendees || []).filter(a => !a.self).length > 3;

          // Build event entry
          let eventLine = `• 📅 **${title}**\n  ${timeStr}`;

          if (attendeeNames.length > 0) {
            eventLine += ` · with ${attendeeNames.join(", ")}`;
            if (hasMoreAttendees) eventLine += " +more";
          }

          lines.push(eventLine);

          if (event.location) {
            lines.push(`  📍 ${event.location}`);
          }

          if (meetingLink) {
            lines.push(`  🔗 ${meetingLink}`);
          }

          if (event.htmlLink) {
            lines.push(`  📎 ${event.htmlLink}`);
          }

          lines.push(""); // Empty line between events
        }

        const output = lines.join('\n');

        return {
          content: [{
            type: "text",
            text: output
          }]
        };

      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const normalizedMessage = message.toLowerCase();
        const isInvalidGrant = normalizedMessage.includes("invalid_grant")
          || normalizedMessage.includes("not allowed to exchange token");

        if (isInvalidGrant) {
          return {
            content: [{
              type: "text",
              text: [
                `❌ Error: ${message}`,
                "",
                "Possible fixes:",
                "- Verify KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET are set for this server.",
                "- Confirm the Keycard client is allowed to exchange tokens for:",
                `  resource: ${CALENDAR_RESOURCE}`,
                `  scope: ${CALENDAR_SCOPES.join(" ")}`,
                "- Ensure the STS issuer/zone matches the one that issued your MCP token."
              ].join("\n")
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `❌ Error: ${message}`
          }]
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof calendarInputSchema>
  );
}
