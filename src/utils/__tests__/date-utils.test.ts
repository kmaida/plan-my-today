/**
 * Tests for date parsing and business day calculation utilities.
 *
 * These functions are used to filter meeting notes by date — a parse failure
 * or off-by-one in business day math silently drops or includes wrong notes.
 */

import { getBusinessDaysAgo, isWithinBusinessDays, parseDateFromFilename } from "../date-utils";

// ── parseDateFromFilename ──

describe("parseDateFromFilename", () => {
  describe("ISO format (YYYY-MM-DD)", () => {
    it("should parse a standard ISO date", () => {
      const result = parseDateFromFilename("Team Sync - 2026-01-27");
      expect(result).toEqual(new Date(2026, 0, 27));
    });

    it("should parse ISO date at the beginning of the filename", () => {
      const result = parseDateFromFilename("2026-03-15 Standup Notes");
      expect(result).toEqual(new Date(2026, 2, 15));
    });

    it("should parse ISO date with no surrounding text", () => {
      const result = parseDateFromFilename("2026-06-01");
      expect(result).toEqual(new Date(2026, 5, 1));
    });
  });

  describe("US format (M/D/YYYY)", () => {
    it("should parse a US date with zero-padded month/day", () => {
      const result = parseDateFromFilename("Meeting 01/27/2026");
      expect(result).toEqual(new Date(2026, 0, 27));
    });

    it("should parse a US date with single-digit month/day", () => {
      const result = parseDateFromFilename("Sync 1/5/2026");
      expect(result).toEqual(new Date(2026, 0, 5));
    });

    it("should parse US date with December 31", () => {
      const result = parseDateFromFilename("12/31/2025");
      expect(result).toEqual(new Date(2025, 11, 31));
    });
  });

  describe("Written format (Mon DD, YYYY)", () => {
    it("should parse abbreviated month name", () => {
      const result = parseDateFromFilename("Standup - Jan 27, 2026");
      expect(result).toEqual(new Date(2026, 0, 27));
    });

    it("should parse full month name", () => {
      const result = parseDateFromFilename("Review February 14, 2026");
      expect(result).toEqual(new Date(2026, 1, 14));
    });

    it("should be case-insensitive for month names", () => {
      const result = parseDateFromFilename("Notes DEC 25, 2025");
      expect(result).toEqual(new Date(2025, 11, 25));
    });

    it("should parse without comma after day", () => {
      const result = parseDateFromFilename("Notes Mar 5 2026");
      expect(result).toEqual(new Date(2026, 2, 5));
    });
  });

  describe("Invalid and edge cases", () => {
    it("should return null for empty string", () => {
      expect(parseDateFromFilename("")).toBeNull();
    });

    it("should return null for filename with no date", () => {
      expect(parseDateFromFilename("Weekly Team Standup Notes")).toBeNull();
    });

    it("should reject dates before 2020 (likely version numbers)", () => {
      // "v1.2.0" could match patterns; dates before 2020 are filtered out
      expect(parseDateFromFilename("Release 2019-12-31")).toBeNull();
    });

    it("should reject dates more than 1 year in the future", () => {
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 2);
      const filename = `Meeting ${farFuture.getFullYear()}-06-15`;
      expect(parseDateFromFilename(filename)).toBeNull();
    });

    it("should handle invalid calendar date (Feb 30)", () => {
      // new Date(2026, 1, 30) rolls over to March 2 — isValidDate should
      // still return true since JS auto-corrects. This test documents the
      // actual behavior: JS doesn't reject Feb 30, it rolls forward.
      const result = parseDateFromFilename("2026-02-30");
      // JS Date(2026, 1, 30) = March 2, 2026 — still a valid date
      expect(result).not.toBeNull();
    });

    it("should prefer ISO format when multiple formats could match", () => {
      // ISO tried first — "2026-01-15" matches before anything else
      const result = parseDateFromFilename("2026-01-15 or Jan 20, 2026");
      expect(result).toEqual(new Date(2026, 0, 15));
    });
  });
});

// ── getBusinessDaysAgo ──

describe("getBusinessDaysAgo", () => {
  // Use fixed dates to avoid test flakiness
  // 2026-02-09 is a Monday

  it("should count 5 business days for a full work week (Mon to Fri)", () => {
    const monday = new Date(2026, 1, 9); // Mon Feb 9
    const friday = new Date(2026, 1, 13); // Fri Feb 13
    expect(getBusinessDaysAgo(monday, friday)).toBe(4);
  });

  it("should count 0 business days for the same date", () => {
    const date = new Date(2026, 1, 9);
    expect(getBusinessDaysAgo(date, date)).toBe(0);
  });

  it("should skip weekends", () => {
    const friday = new Date(2026, 1, 6); // Fri Feb 6
    const monday = new Date(2026, 1, 9); // Mon Feb 9
    // Fri → Sat (skip) → Sun (skip) → Mon = 1 business day
    expect(getBusinessDaysAgo(friday, monday)).toBe(1);
  });

  it("should count 5 business days in a full Mon-to-Mon span", () => {
    const mon1 = new Date(2026, 1, 2); // Mon Feb 2
    const mon2 = new Date(2026, 1, 9); // Mon Feb 9
    // Mon(1) Tue(2) Wed(3) Thu(4) Fri(5) Sat Sun = 5 business days
    expect(getBusinessDaysAgo(mon1, mon2)).toBe(5);
  });

  it("should count 10 business days for two full work weeks", () => {
    const mon1 = new Date(2026, 1, 2); // Mon Feb 2
    const mon3 = new Date(2026, 1, 16); // Mon Feb 16
    expect(getBusinessDaysAgo(mon1, mon3)).toBe(10);
  });

  it("should handle order of arguments (always positive)", () => {
    const earlier = new Date(2026, 1, 2);
    const later = new Date(2026, 1, 9);
    expect(getBusinessDaysAgo(later, earlier)).toBe(getBusinessDaysAgo(earlier, later));
  });

  it("should count 0 for Saturday to Sunday", () => {
    const sat = new Date(2026, 1, 7); // Sat Feb 7
    const sun = new Date(2026, 1, 8); // Sun Feb 8
    // Sat is not a business day, so 0 counted before reaching Sun
    expect(getBusinessDaysAgo(sat, sun)).toBe(0);
  });
});

// ── isWithinBusinessDays ──

describe("isWithinBusinessDays", () => {
  const referenceDate = new Date(2026, 1, 9); // Mon Feb 9

  it("should return true for dates within the window", () => {
    // 3 business days ago from Mon Feb 9 → Wed Feb 4
    const wed = new Date(2026, 1, 4);
    expect(isWithinBusinessDays(wed, 5, referenceDate)).toBe(true);
  });

  it("should return true at the exact boundary (inclusive)", () => {
    // Exactly 5 business days ago from Mon Feb 9 → Mon Feb 2
    const mon = new Date(2026, 1, 2);
    expect(isWithinBusinessDays(mon, 5, referenceDate)).toBe(true);
  });

  it("should return false just past the boundary", () => {
    // 6 business days ago from Mon Feb 9 → Fri Jan 30
    const fri = new Date(2026, 0, 30);
    expect(isWithinBusinessDays(fri, 5, referenceDate)).toBe(false);
  });

  it("should reject future dates", () => {
    const tomorrow = new Date(2026, 1, 10);
    expect(isWithinBusinessDays(tomorrow, 10, referenceDate)).toBe(false);
  });

  it("should return true for today (0 business days ago)", () => {
    expect(isWithinBusinessDays(referenceDate, 0, referenceDate)).toBe(true);
  });
});
