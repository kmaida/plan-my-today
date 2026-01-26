import type { CalendarEventDetail, TimeBlock } from "./types";

/**
 * Fetches today's calendar events with full details
 */
export async function fetchTodayCalendarEvents(accessToken: string): Promise<CalendarEventDetail[]> {
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
 * Analyzes calendar events to find available time blocks
 */
export function findAvailableTimeBlocks(
  calendarEvents: CalendarEventDetail[],
  workStartHour: number = 9,
  workEndHour: number = 17
): TimeBlock[] {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), workStartHour, 0);
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), workEndHour, 0);

  // Sort events by start time
  const sortedEvents = calendarEvents
    .filter(e => e.start?.dateTime && e.end?.dateTime) // Only timed events with both start and end
    .map(e => ({
      start: new Date(e.start!.dateTime!),
      end: new Date(e.end!.dateTime!),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const blocks: TimeBlock[] = [];
  let currentTime = startOfDay;

  for (const event of sortedEvents) {
    // If there's a gap before this event
    if (currentTime < event.start) {
      const durationMinutes = Math.floor((event.start.getTime() - currentTime.getTime()) / (1000 * 60));
      if (durationMinutes >= 15) { // Only suggest blocks of 15+ minutes
        blocks.push({
          start: new Date(currentTime),
          end: new Date(event.start),
          durationMinutes,
        });
      }
    }
    // Move current time to end of this event
    currentTime = event.end > currentTime ? event.end : currentTime;
  }

  // Check for time after last event
  if (currentTime < endOfDay) {
    const durationMinutes = Math.floor((endOfDay.getTime() - currentTime.getTime()) / (1000 * 60));
    if (durationMinutes >= 15) {
      blocks.push({
        start: new Date(currentTime),
        end: new Date(endOfDay),
        durationMinutes,
      });
    }
  }

  return blocks;
}
