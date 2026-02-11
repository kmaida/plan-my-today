import { CALENDAR } from "../../constants";
import { AuthenticationError } from "../../utils/error-utils";
import { calculateProximity, categorizeScore, type PriorityMetadata } from "./priority-utils";
import type { CalendarEventDetail, TimeBlock } from "./types";

/**
 * Fetches calendar events within a specified time range
 *
 * @param accessToken - Google Calendar API access token
 * @param options - Fetch options
 * @returns Array of calendar event details
 */
export async function fetchCalendarEvents(
  accessToken: string,
  options: {
    timeMin: string;
    timeMax: string;
    maxResults?: number;
  }
): Promise<CalendarEventDetail[]> {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      new URLSearchParams({
        maxResults: String(options.maxResults || CALENDAR.MAX_RESULTS),
        timeMin: options.timeMin,
        timeMax: options.timeMax,
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
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError("Google Calendar", response.status);
    }
    return [];
  }

  const data = (await response.json()) as { items?: CalendarEventDetail[] };
  return data.items || [];
}

/**
 * Fetches today's calendar events with full details
 *
 * @param accessToken - Google Calendar API access token
 * @returns Array of today's calendar event details
 */
export async function fetchTodayCalendarEvents(
  accessToken: string
): Promise<CalendarEventDetail[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  return fetchCalendarEvents(accessToken, {
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
  });
}

/**
 * Analyzes calendar events to find available time blocks
 */
export function findAvailableTimeBlocks(
  calendarEvents: CalendarEventDetail[],
  workStartHour: number = CALENDAR.WORK_START_HOUR,
  workEndHour: number = CALENDAR.WORK_END_HOUR
): TimeBlock[] {
  const today = new Date();
  const startOfDay = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    workStartHour,
    0
  );
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), workEndHour, 0);

  // Sort events by start time
  const sortedEvents = calendarEvents
    .filter((e) => e.start?.dateTime && e.end?.dateTime) // Only timed events with both start and end
    .map((e) => ({
      start: new Date(e.start!.dateTime!),
      end: new Date(e.end!.dateTime!),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const blocks: TimeBlock[] = [];
  let currentTime = startOfDay;

  for (const event of sortedEvents) {
    // If there's a gap before this event
    if (currentTime < event.start) {
      const durationMinutes = Math.floor(
        (event.start.getTime() - currentTime.getTime()) / (1000 * 60)
      );
      if (durationMinutes >= CALENDAR.MIN_TIME_BLOCK_MINUTES) {
        // Only suggest blocks of 15+ minutes
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

/**
 * Calculates priority metadata for calendar events
 *
 * @param event - Calendar event detail
 * @param now - Current date/time for proximity calculations
 * @returns Priority metadata
 */
export function calculateCalendarPriority(event: CalendarEventDetail, now: Date): PriorityMetadata {
  let score = 50; // Base
  const reasons: string[] = [];

  const startTime = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  const minutesUntilStart = startTime ? (startTime.getTime() - now.getTime()) / (1000 * 60) : 999;
  const minutesUntilEnd = endTime ? (endTime.getTime() - now.getTime()) / (1000 * 60) : undefined;

  const proximity = calculateProximity(minutesUntilStart, minutesUntilEnd);

  // Boost for imminent meetings; past events get no boost
  if (proximity === "past") {
    score = 10;
    reasons.push("Event ended");
  } else if (proximity === "happening_now") {
    score += 150;
    reasons.push("Happening now");
  } else if (proximity === "very_soon") {
    score += 100;
    reasons.push("Starting very soon");
  } else if (proximity === "upcoming") {
    score += 50;
    reasons.push("Starting soon");
  }

  const attendeeCount = event.attendees?.length || 0;
  const hasVideo = !!(event.conferenceData?.entryPoints || event.hangoutLink);
  const isSoloFocusBlock = attendeeCount === 1 && !hasVideo;

  if (attendeeCount > 5) {
    score += 10;
    reasons.push("Large meeting");
  }

  if (isSoloFocusBlock) {
    reasons.push("Focus block");
  }

  return {
    score,
    category: categorizeScore(score),
    signals: {
      eventType: isSoloFocusBlock ? "focus_block" : event.start?.date ? "all_day" : "meeting",
      hasVideoLink: hasVideo,
      attendeeCount,
      isSoloFocusBlock,
      minutesUntilStart,
      proximity,
    },
    reasons,
  };
}
