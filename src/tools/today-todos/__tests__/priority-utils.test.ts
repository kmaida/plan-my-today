/**
 * Tests for priority scoring threshold functions.
 *
 * These pure functions classify scores and time values into categories used
 * across ALL data sources (calendar, email, Slack, meeting notes, etc.).
 * A wrong boundary silently mis-prioritizes every task in the system.
 */

import { calculateProximity, calculateRecencyBoost, categorizeScore } from "../priority-utils";

// ── categorizeScore ──
// Thresholds: CRITICAL >= 180, HIGH >= 130, MEDIUM >= 80

describe("categorizeScore", () => {
  it("should classify 0 as low", () => {
    expect(categorizeScore(0)).toBe("low");
  });

  it("should classify 79 as low (just below medium)", () => {
    expect(categorizeScore(79)).toBe("low");
  });

  it("should classify 80 as medium (exact boundary)", () => {
    expect(categorizeScore(80)).toBe("medium");
  });

  it("should classify 129 as medium (just below high)", () => {
    expect(categorizeScore(129)).toBe("medium");
  });

  it("should classify 130 as high (exact boundary)", () => {
    expect(categorizeScore(130)).toBe("high");
  });

  it("should classify 179 as high (just below critical)", () => {
    expect(categorizeScore(179)).toBe("high");
  });

  it("should classify 180 as critical (exact boundary)", () => {
    expect(categorizeScore(180)).toBe("critical");
  });

  it("should classify negative scores as low", () => {
    expect(categorizeScore(-10)).toBe("low");
  });
});

// ── calculateRecencyBoost ──
// Boundaries: < 1h = very_recent, < 4h = recent, < 24h = moderate, >= 24h = old

describe("calculateRecencyBoost", () => {
  it("should classify 0 hours as very_recent", () => {
    expect(calculateRecencyBoost(0)).toBe("very_recent");
  });

  it("should classify 0.99 hours as very_recent (just under boundary)", () => {
    expect(calculateRecencyBoost(0.99)).toBe("very_recent");
  });

  it("should classify exactly 1 hour as recent (boundary)", () => {
    expect(calculateRecencyBoost(1)).toBe("recent");
  });

  it("should classify 3.99 hours as recent (just under boundary)", () => {
    expect(calculateRecencyBoost(3.99)).toBe("recent");
  });

  it("should classify exactly 4 hours as moderate (boundary)", () => {
    expect(calculateRecencyBoost(4)).toBe("moderate");
  });

  it("should classify 23.99 hours as moderate (just under boundary)", () => {
    expect(calculateRecencyBoost(23.99)).toBe("moderate");
  });

  it("should classify exactly 24 hours as old (boundary)", () => {
    expect(calculateRecencyBoost(24)).toBe("old");
  });

});

// ── calculateProximity ──
// past: minutesUntilEnd <= 0
// happening_now: minutesUntilStart <= 5
// very_soon: minutesUntilStart <= 30
// upcoming: minutesUntilStart <= 120
// future: otherwise

describe("calculateProximity", () => {
  describe("past events", () => {
    it("should classify event that ended as past", () => {
      expect(calculateProximity(30, -10)).toBe("past");
    });

    it("should classify event ending exactly now as past (minutesUntilEnd = 0)", () => {
      expect(calculateProximity(-30, 0)).toBe("past");
    });
  });

  describe("happening now", () => {
    it("should classify event starting now as happening_now", () => {
      expect(calculateProximity(0)).toBe("happening_now");
    });

    it("should classify event already started (negative minutesUntilStart)", () => {
      expect(calculateProximity(-15, 30)).toBe("happening_now");
    });

    it("should classify event starting in 5 minutes as happening_now (boundary)", () => {
      expect(calculateProximity(5)).toBe("happening_now");
    });
  });

  describe("very soon", () => {
    it("should classify event starting in 6 minutes as very_soon", () => {
      expect(calculateProximity(6)).toBe("very_soon");
    });

    it("should classify event starting in 30 minutes as very_soon (boundary)", () => {
      expect(calculateProximity(30)).toBe("very_soon");
    });
  });

  describe("upcoming", () => {
    it("should classify event starting in 31 minutes as upcoming", () => {
      expect(calculateProximity(31)).toBe("upcoming");
    });

    it("should classify event starting in 120 minutes as upcoming (boundary)", () => {
      expect(calculateProximity(120)).toBe("upcoming");
    });
  });

  describe("future", () => {
    it("should classify event starting in 121 minutes as future", () => {
      expect(calculateProximity(121)).toBe("future");
    });
  });

  describe("end time takes priority over start time", () => {
    it("past event beats happening_now when end <= 0", () => {
      // Event started (minutesUntilStart = -60) but also ended (minutesUntilEnd = -5)
      expect(calculateProximity(-60, -5)).toBe("past");
    });
  });
});
