import { config } from "../../config";
import { CALENDAR } from "../../constants";
import { AuthenticationError } from "../../utils/error-utils";
import { parseLocalDate } from "../../utils/date-utils";
import { calculateProximity, categorizeScore, type PriorityMetadata } from "./priority-utils";
import type { CalendarEventDetail } from "./types";

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
 * Regex matching titles that start with an emoji (personal/reserved blocks).
 * Uses Extended_Pictographic (not Emoji_Presentation) to catch text-style emoji
 * with variation selectors (✈️), flags (🇺🇸), keycaps (1️⃣), etc.
 */
const EMOJI_TITLE_PATTERN = /^\p{Extended_Pictographic}/u;

/**
 * Checks if an event title starts with an emoji, indicating a reserved personal block.
 *
 * @param summary - Event title/summary
 * @returns True if the title starts with an emoji
 */
function isReservedByEmoji(summary?: string): boolean {
  return !!summary && EMOJI_TITLE_PATTERN.test(summary);
}

/**
 * Calculates priority metadata for calendar events.
 *
 * Scoring branches by Google Calendar's `eventType` field:
 * - `"focusTime"`: Low priority (informational). Available work time unless emoji-titled (reserved).
 * - `"outOfOffice"`: Low priority (informational). Immovable, user unavailable.
 * - `"workingLocation"` / `"birthday"` / `"fromGmail"`: Very low, purely informational.
 * - `"default"` or missing: Standard meeting scoring with proximity boosts.
 *
 * Emoji check (universal): Any event whose title starts with an emoji is flagged
 * "Reserved (personal)" — the agent should remind the user about it but not schedule tasks.
 *
 * Note: `signals.eventType` uses Google API values for non-default types ("focusTime",
 * "outOfOffice", etc.) but derived values for default events ("meeting", "focus_block",
 * "all_day"). Signals are internal scoring data; the top-level `event.eventType` field
 * is the canonical API value shown to consumers.
 *
 * @param event - Calendar event detail
 * @param now - Current date/time for proximity calculations
 * @returns Priority metadata
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-signal priority scoring
export function calculateCalendarPriority(event: CalendarEventDetail, now: Date): PriorityMetadata {
  const startTime = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;

  // All-day events have `start.date` (YYYY-MM-DD) instead of `start.dateTime`.
  // Parse with parseLocalDate() to avoid the UTC-midnight off-by-one bug.
  // Today → minutesUntilStart = 0 (happening_now), Tomorrow → 90 (upcoming), Future → 999.
  // Leave minutesUntilEnd undefined for all-day events — no meaningful end time,
  // and setting it would cause false "past" classification.
  let minutesUntilStart: number;
  let minutesUntilEnd: number | undefined;

  if (startTime) {
    minutesUntilStart = (startTime.getTime() - now.getTime()) / (1000 * 60);
    minutesUntilEnd = endTime ? (endTime.getTime() - now.getTime()) / (1000 * 60) : undefined;
  } else if (event.start?.date) {
    const eventDate = parseLocalDate(event.start.date);
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysDiff = Math.round(
      (eventDate.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysDiff <= 0) {
      minutesUntilStart = 0; // today or past → "happening_now"
    } else if (daysDiff === 1) {
      minutesUntilStart = 90; // tomorrow → "upcoming"
    } else {
      minutesUntilStart = 999; // future → no boost
    }
    minutesUntilEnd = undefined;
  } else {
    minutesUntilStart = 999; // no start info at all → safe fallback
    minutesUntilEnd = undefined;
  }

  const proximity = calculateProximity(minutesUntilStart, minutesUntilEnd);

  const attendeeCount = event.attendees?.length || 0;
  const hasVideo = !!(event.conferenceData?.entryPoints || event.hangoutLink);
  const reserved = isReservedByEmoji(event.summary);

  const apiEventType = event.eventType || "default";

  // ── Non-meeting event types: informational, no proximity boost ──

  if (apiEventType === "focusTime") {
    const isPrep =
      !!event.summary &&
      event.summary.toLowerCase().startsWith(config.calendarPrepPrefix.toLowerCase());
    const reasons: string[] = [isPrep ? "Meeting prep" : "Focus Time"];
    if (reserved) reasons.push("Reserved (personal)");
    if (proximity === "past") reasons.push("Ended");
    // Prep blocks get a slight boost (30 vs 20) since they're time-sensitive
    const score = proximity === "past" ? 5 : isPrep ? 30 : 20;
    return {
      score,
      category: categorizeScore(score),
      signals: {
        eventType: "focusTime",
        reserved,
        isPrep,
        hasVideoLink: hasVideo,
        attendeeCount,
        minutesUntilStart,
        proximity,
      },
      reasons,
    };
  }

  if (apiEventType === "outOfOffice") {
    const reasons: string[] = ["Out of office"];
    if (proximity === "past") reasons.push("Ended");
    const score = proximity === "past" ? 5 : 10;
    return {
      score,
      category: categorizeScore(score),
      signals: {
        eventType: "outOfOffice",
        reserved,
        hasVideoLink: false,
        attendeeCount,
        minutesUntilStart,
        proximity,
      },
      reasons,
    };
  }

  if (
    apiEventType === "workingLocation" ||
    apiEventType === "birthday" ||
    apiEventType === "fromGmail"
  ) {
    const labelMap: Record<string, string> = {
      workingLocation: "Working location",
      birthday: "Birthday",
      fromGmail: "Auto-created from email",
    };
    return {
      score: apiEventType === "birthday" ? 5 : 10,
      category: "low",
      signals: {
        eventType: apiEventType,
        reserved,
        hasVideoLink: false,
        attendeeCount,
        minutesUntilStart,
        proximity,
      },
      reasons: [labelMap[apiEventType]],
    };
  }

  // ── Default event type: standard meeting scoring ──

  let score = 50;
  const reasons: string[] = [];
  const isSoloFocusBlock = attendeeCount === 1 && !hasVideo;

  if (reserved) reasons.push("Reserved (personal)");

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
      reserved,
      hasVideoLink: hasVideo,
      attendeeCount,
      isSoloFocusBlock,
      minutesUntilStart,
      proximity,
    },
    reasons,
  };
}
