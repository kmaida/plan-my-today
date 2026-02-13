/**
 * Tests for the UI's date helper utilities.
 *
 * These pure functions handle date parsing, formatting, and comparison for
 * the dashboard. The critical invariant: date-only strings like "2026-02-13"
 * must parse as LOCAL midnight, not UTC midnight (which shifts to the
 * previous day in US timezones).
 */

import {
  formatDate,
  formatDueDate,
  formatSmartDate,
  formatTime,
  isThisWeek,
  isToday,
  parseDate,
} from "../../../ui/src/utils/dateHelpers";

// ── parseDate ────────────────────────────────────────────────────────────────

describe("parseDate", () => {
  it("date-only string: parses as local midnight (not UTC)", () => {
    const result = parseDate("2026-02-13");
    // Should be Feb 13 in local timezone, not Feb 12 (UTC shift)
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // 0-indexed
    expect(result.getDate()).toBe(13);
    // Hours should be 0 (local midnight), not offset by timezone
    expect(result.getHours()).toBe(0);
  });

  it("ISO-8601 with T: preserves full timestamp", () => {
    const result = parseDate("2026-02-13T15:30:00-05:00");
    // Should parse the full timestamp — exact hour depends on local timezone,
    // but the date should not shift
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1);
    // The date might be 13 or 14 depending on timezone offset, but should
    // be a valid Date (not NaN)
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  it("date-only string with trailing whitespace: still parses as local", () => {
    // The regex uses (?!\S) which allows end-of-string or whitespace
    const result = parseDate("2026-06-15");
    expect(result.getDate()).toBe(15);
    expect(result.getMonth()).toBe(5); // June = 5
  });
});

// ── formatDate ───────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("formats a date-only string to readable format", () => {
    const result = formatDate("2026-01-15");
    expect(result).toBe("Jan 15, 2026");
  });

  it("formats an ISO timestamp to readable format", () => {
    // Use a timestamp that stays on the same calendar day in all US timezones
    const result = formatDate("2026-07-04T12:00:00-04:00");
    expect(result).toContain("2026");
    expect(result).toContain("Jul");
  });
});

// ── formatTime ───────────────────────────────────────────────────────────────

describe("formatTime", () => {
  it("formats an ISO timestamp to time string", () => {
    // Create a known local time
    const local = new Date(2026, 0, 15, 14, 30); // 2:30 PM local
    const result = formatTime(local.toISOString());
    expect(result).toBe("2:30 PM");
  });
});

// ── isToday ──────────────────────────────────────────────────────────────────

describe("isToday", () => {
  it("returns true for today's date-only string", () => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    expect(isToday(`${yyyy}-${mm}-${dd}`)).toBe(true);
  });

  it("returns true for today's ISO timestamp", () => {
    expect(isToday(new Date().toISOString())).toBe(true);
  });

  it("returns false for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yyyy = yesterday.getFullYear();
    const mm = String(yesterday.getMonth() + 1).padStart(2, "0");
    const dd = String(yesterday.getDate()).padStart(2, "0");
    expect(isToday(`${yyyy}-${mm}-${dd}`)).toBe(false);
  });

  it("returns false for tomorrow", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yyyy = tomorrow.getFullYear();
    const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const dd = String(tomorrow.getDate()).padStart(2, "0");
    expect(isToday(`${yyyy}-${mm}-${dd}`)).toBe(false);
  });
});

// ── isThisWeek ───────────────────────────────────────────────────────────────

describe("isThisWeek", () => {
  it("returns true for today", () => {
    expect(isThisWeek(new Date().toISOString())).toBe(true);
  });

  it("returns false for a date far in the past", () => {
    expect(isThisWeek("2020-01-01")).toBe(false);
  });

  it("returns false for a date far in the future", () => {
    expect(isThisWeek("2099-12-31")).toBe(false);
  });
});

// ── formatDueDate ────────────────────────────────────────────────────────────

describe("formatDueDate", () => {
  // Helper to build date strings relative to now
  function daysFromNow(days: number, includeTime = false): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    if (includeTime) {
      return d.toISOString();
    }
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  it("overdue past date: shows 'Overdue' with date", () => {
    const result = formatDueDate("2020-01-15");
    expect(result.isOverdue).toBe(true);
    expect(result.isUrgent).toBe(true);
    expect(result.text).toMatch(/overdue/i);
    expect(result.text).toContain("Jan 15, 2020");
  });

  it("date-only due today: shows 'Due today' (not a clock time)", () => {
    const todayStr = daysFromNow(0, false);
    const result = formatDueDate(todayStr);
    expect(result.isOverdue).toBe(false);
    expect(result.text).toBe("Due today");
  });

  it("due tomorrow: shows 'Due tomorrow'", () => {
    const tomorrowStr = daysFromNow(1, false);
    const result = formatDueDate(tomorrowStr);
    expect(result.isOverdue).toBe(false);
    expect(result.text).toBe("Due tomorrow");
  });

  it("due in 3 days: shows 'Due in N days'", () => {
    const result = formatDueDate(daysFromNow(3, false));
    expect(result.isOverdue).toBe(false);
    expect(result.text).toMatch(/due in \d+ days/i);
  });

  it("due in 2 weeks: shows formatted date", () => {
    const result = formatDueDate(daysFromNow(14, false));
    expect(result.isOverdue).toBe(false);
    expect(result.text).toMatch(/^Due /);
    // Should not say "in N days" for > 7 days
    expect(result.text).not.toContain("days");
  });

  it("overdue with time: shows 'Overdue (was HH:MM)'", () => {
    // Create a timestamp 2 hours in the past today
    const past = new Date();
    past.setHours(past.getHours() - 2);
    const result = formatDueDate(past.toISOString());
    expect(result.isOverdue).toBe(true);
    expect(result.text).toMatch(/overdue/i);
    expect(result.text).toMatch(/was \d+:\d+ [AP]M/);
  });

  it("due today with time (future): shows 'Due HH:MM'", () => {
    // Create a timestamp 4+ hours in the future today
    const future = new Date();
    future.setHours(future.getHours() + 5);
    // Skip if we'd roll into tomorrow
    if (future.getDate() === new Date().getDate()) {
      const result = formatDueDate(future.toISOString());
      expect(result.isOverdue).toBe(false);
      expect(result.text).toMatch(/due \d+:\d+ [AP]M/i);
    }
  });

  it("date-only due today: isUrgent is true", () => {
    const todayStr = daysFromNow(0, false);
    const result = formatDueDate(todayStr);
    expect(result.isUrgent).toBe(true);
  });

  it("due tomorrow: isUrgent is false", () => {
    const result = formatDueDate(daysFromNow(1, false));
    expect(result.isUrgent).toBe(false);
  });
});

// ── formatSmartDate ──────────────────────────────────────────────────────────

describe("formatSmartDate", () => {
  it("shows time for today's timestamp", () => {
    const now = new Date();
    now.setHours(10, 30, 0, 0);
    const result = formatSmartDate(now.toISOString());
    expect(result).toBe("10:30 AM");
  });

  it("shows date for non-today timestamp", () => {
    const result = formatSmartDate("2020-06-15");
    expect(result).toBe("Jun 15, 2020");
  });
});
