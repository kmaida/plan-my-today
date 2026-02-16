/**
 * Tests for calendar event priority scoring, specifically all-day event handling.
 *
 * Bug: All-day events (all-hands, deadlines, birthdays) always scored ~50 (Medium)
 * because `minutesUntilStart` defaulted to 999 when there was no `dateTime`.
 * Fix: Parse `event.start.date` with `parseLocalDate()` and assign proximity
 * based on whether it's today, tomorrow, or further out.
 */

import { calculateCalendarPriority } from "../calendar-utils";
import type { CalendarEventDetail } from "../types";

// ── Helpers ──

/** Create a minimal all-day event with just `start.date` (no dateTime). */
function makeAllDayEvent(
  dateStr: string,
  overrides: Partial<CalendarEventDetail> = {},
): CalendarEventDetail {
  return {
    summary: "All-Day Event",
    start: { date: dateStr },
    end: { date: dateStr },
    ...overrides,
  };
}

/** Create a timed event with `start.dateTime` and `end.dateTime`. */
function makeTimedEvent(
  startISO: string,
  endISO: string,
  overrides: Partial<CalendarEventDetail> = {},
): CalendarEventDetail {
  return {
    summary: "Timed Meeting",
    start: { dateTime: startISO },
    end: { dateTime: endISO },
    ...overrides,
  };
}

/**
 * Build a local-timezone YYYY-MM-DD string for today/tomorrow/future
 * without using new Date("YYYY-MM-DD") (UTC midnight bug).
 */
function localDateStr(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── All-day event priority tests ──

describe("calculateCalendarPriority — all-day events", () => {
  const now = new Date();

  it("all-day event today → happening_now proximity, score 200 (critical)", () => {
    const event = makeAllDayEvent(localDateStr(0));
    const result = calculateCalendarPriority(event, now);

    expect(result.signals.proximity).toBe("happening_now");
    expect(result.score).toBe(200); // base 50 + 150 happening_now boost
    expect(result.category).toBe("critical");
    expect(result.signals.eventType).toBe("all_day");
  });

  it("all-day event tomorrow → upcoming proximity, score 100 (medium)", () => {
    const event = makeAllDayEvent(localDateStr(1));
    const result = calculateCalendarPriority(event, now);

    expect(result.signals.proximity).toBe("upcoming");
    expect(result.score).toBe(100); // base 50 + 50 upcoming boost
    expect(result.category).toBe("medium");
  });

  it("all-day event 3 days from now → future proximity, score 50 (low)", () => {
    const event = makeAllDayEvent(localDateStr(3));
    const result = calculateCalendarPriority(event, now);

    expect(result.signals.proximity).toBe("future");
    expect(result.score).toBe(50); // base only, no boost
    expect(result.category).toBe("low");
  });

  it("all-day event does not get classified as past", () => {
    // Today's all-day event should never be "past" — no meaningful end time
    const event = makeAllDayEvent(localDateStr(0));
    const result = calculateCalendarPriority(event, now);

    expect(result.signals.proximity).not.toBe("past");
  });

  it("all-day event yesterday → happening_now (daysDiff <= 0)", () => {
    // Past all-day events still get daysDiff <= 0 → minutesUntilStart = 0
    // This is acceptable: the event was "today or past"
    const event = makeAllDayEvent(localDateStr(-1));
    const result = calculateCalendarPriority(event, now);

    expect(result.signals.proximity).toBe("happening_now");
  });
});

// ── Edge case: no start info at all ──

describe("calculateCalendarPriority — missing start data", () => {
  const now = new Date();

  it("event with no start.date AND no start.dateTime → safe fallback (score 50)", () => {
    const event: CalendarEventDetail = {
      summary: "Mystery Event",
      start: {},
      end: {},
    };
    const result = calculateCalendarPriority(event, now);

    expect(result.signals.proximity).toBe("future");
    expect(result.score).toBe(50); // base only, no boost
  });

  it("event with undefined start → safe fallback (score 50)", () => {
    const event: CalendarEventDetail = {
      summary: "No Start Event",
    };
    const result = calculateCalendarPriority(event, now);

    expect(result.signals.proximity).toBe("future");
    expect(result.score).toBe(50);
  });
});

// ── Regression: timed events unchanged ──

describe("calculateCalendarPriority — timed events (regression)", () => {
  it("timed event happening now → happening_now proximity", () => {
    const now = new Date();
    const startISO = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const endISO = new Date(now.getTime() + 25 * 60 * 1000).toISOString(); // 25 min from now
    const event = makeTimedEvent(startISO, endISO, { attendees: [{ email: "a@b.com" }] });

    const result = calculateCalendarPriority(event, now);
    expect(result.signals.proximity).toBe("happening_now");
    expect(result.score).toBeGreaterThanOrEqual(200);
  });

  it("timed event starting in 60 min → upcoming proximity", () => {
    const now = new Date();
    const startISO = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const endISO = new Date(now.getTime() + 90 * 60 * 1000).toISOString();
    const event = makeTimedEvent(startISO, endISO);

    const result = calculateCalendarPriority(event, now);
    expect(result.signals.proximity).toBe("upcoming");
    expect(result.score).toBe(100); // base 50 + 50 upcoming
  });

  it("timed event that already ended → past proximity, score 10", () => {
    const now = new Date();
    const startISO = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1 hr ago
    const endISO = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const event = makeTimedEvent(startISO, endISO);

    const result = calculateCalendarPriority(event, now);
    expect(result.signals.proximity).toBe("past");
    expect(result.score).toBe(10);
  });

  it("timed event 3 hours away → future proximity, score 50", () => {
    const now = new Date();
    const startISO = new Date(now.getTime() + 180 * 60 * 1000).toISOString();
    const endISO = new Date(now.getTime() + 210 * 60 * 1000).toISOString();
    const event = makeTimedEvent(startISO, endISO);

    const result = calculateCalendarPriority(event, now);
    expect(result.signals.proximity).toBe("future");
    expect(result.score).toBe(50);
  });
});
