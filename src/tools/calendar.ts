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

        const data = await calendarResponse.json() as { items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string }> };
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
        let output = `📅 **Upcoming Events** (${events.length}):\n\n`;
        for (const event of events) {
          const start = event.start?.dateTime || event.start?.date || "Unknown";
          const title = event.summary || "Untitled";
          const location = event.location ? ` 📍 ${event.location}` : "";
          output += `• **${title}**\n  ${start}${location}\n\n`;
        }

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
