/**
 * Tests for Slack message priority scoring.
 *
 * These functions run per-message during every list-all-tasks-today call,
 * so correctness matters: a wrong score silently re-orders the user's day.
 *
 * The two public functions share an internal analyzeSlackMessage() helper.
 * A key invariant is that both always return the same score for the same input.
 */

import {
  calculateSlackPriority,
  calculateSlackPriorityWithMetadata,
} from "../slack-utils";
import type { SlackMessageDetail } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal SlackMessageDetail for testing. */
function makeMessage(
  overrides: Partial<SlackMessageDetail> & { type: SlackMessageDetail["type"] }
): SlackMessageDetail {
  const { type, ...rest } = overrides;
  return {
    text: "hello",
    timestamp: toSlackTs(new Date()),
    channel: "C123",
    user: "U123",
    type,
    ...rest,
  };
}

/** Convert a Date to Slack's epoch-seconds timestamp format. */
function toSlackTs(date: Date): string {
  return (date.getTime() / 1000).toFixed(6);
}

/** Create a Date that is `hours` hours before `now`. */
function hoursAgo(hours: number, now: Date = new Date("2026-02-11T12:00:00Z")): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

// Fixed "now" for deterministic tests
const NOW = new Date("2026-02-11T12:00:00Z");

// ── Score-only path (calculateSlackPriority) ─────────────────────────────────

describe("calculateSlackPriority", () => {
  describe("type scoring", () => {
    // All messages use old timestamp (>24h) and neutral text to isolate type score
    const oldTs = toSlackTs(hoursAgo(48, NOW));

    it("should score saved messages at 100", () => {
      const msg = makeMessage({ type: "saved", text: "hello", timestamp: oldTs });
      expect(calculateSlackPriority(msg, NOW)).toBe(100);
    });

    it("should score mentions at 90", () => {
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: oldTs });
      expect(calculateSlackPriority(msg, NOW)).toBe(90);
    });

    it("should score DMs at 70", () => {
      const msg = makeMessage({ type: "dm", text: "hello", timestamp: oldTs });
      expect(calculateSlackPriority(msg, NOW)).toBe(70);
    });

    it("should score thread type at 0 (no type bonus)", () => {
      const msg = makeMessage({ type: "thread" as SlackMessageDetail["type"], text: "hello", timestamp: oldTs });
      expect(calculateSlackPriority(msg, NOW)).toBe(0);
    });
  });

  describe("keyword content scoring", () => {
    // Use old timestamp and "saved" type (100) as stable base
    const oldTs = toSlackTs(hoursAgo(48, NOW));
    const base = 100; // saved type score

    it("should add 80 for urgency keywords", () => {
      const msg = makeMessage({ type: "saved", text: "this is urgent please help", timestamp: oldTs });
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 80);
    });

    it("should add 40 for question keywords (when no urgency)", () => {
      const msg = makeMessage({ type: "saved", text: "can you take a look at this spec", timestamp: oldTs });
      // "can you" is a question keyword, "take a look" is an action keyword
      // Question wins because it's checked before action in the else-if chain
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 40);
    });

    it("should add 50 for action keywords (when no urgency or question)", () => {
      const msg = makeMessage({ type: "saved", text: "please review the PR", timestamp: oldTs });
      // "please" is a question keyword — so this actually matches question first
      // Use a message with only action keywords
      const actionOnly = makeMessage({ type: "saved", text: "review the PR", timestamp: oldTs });
      expect(calculateSlackPriority(actionOnly, NOW)).toBe(base + 50);
    });

    it("should only apply the first matching keyword category (urgency > question > action)", () => {
      // "urgent" (urgency) + "can you" (question) + "review" (action)
      const msg = makeMessage({ type: "saved", text: "urgent: can you review this", timestamp: oldTs });
      // Only urgency bonus should apply
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 80);
    });

    it("should be case-insensitive for keyword matching", () => {
      const msg = makeMessage({ type: "saved", text: "URGENT: FIX THIS NOW", timestamp: oldTs });
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 80);
    });

    it("should add 0 for messages with no keyword matches", () => {
      const msg = makeMessage({ type: "saved", text: "sounds good, thanks", timestamp: oldTs });
      expect(calculateSlackPriority(msg, NOW)).toBe(base);
    });
  });

  describe("recency scoring", () => {
    // Use neutral text and "mention" type (90) as stable base
    const base = 90;

    it("should add 50 for messages < 1 hour old", () => {
      const ts = toSlackTs(hoursAgo(0.5, NOW));
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: ts });
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 50);
    });

    it("should add 30 for messages 1–4 hours old", () => {
      const ts = toSlackTs(hoursAgo(2, NOW));
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: ts });
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 30);
    });

    it("should add 15 for messages 4–12 hours old", () => {
      const ts = toSlackTs(hoursAgo(8, NOW));
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: ts });
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 15);
    });

    it("should add 5 for messages 12–24 hours old", () => {
      const ts = toSlackTs(hoursAgo(18, NOW));
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: ts });
      expect(calculateSlackPriority(msg, NOW)).toBe(base + 5);
    });

    it("should add 0 for messages > 24 hours old", () => {
      const ts = toSlackTs(hoursAgo(48, NOW));
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: ts });
      expect(calculateSlackPriority(msg, NOW)).toBe(base);
    });
  });

  describe("combined scoring", () => {
    it("should sum type + content + recency", () => {
      // saved (100) + urgent (80) + very recent (50) = 230
      const ts = toSlackTs(hoursAgo(0.25, NOW));
      const msg = makeMessage({ type: "saved", text: "urgent blocker", timestamp: ts });
      expect(calculateSlackPriority(msg, NOW)).toBe(230);
    });

    it("should classify a high-scoring message as critical (>= 180)", () => {
      // saved (100) + urgent (80) + any recency = 180+
      const ts = toSlackTs(hoursAgo(48, NOW));
      const msg = makeMessage({ type: "saved", text: "urgent blocker", timestamp: ts });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.score).toBe(180);
      expect(metadata.category).toBe("critical");
    });
  });
});

// ── Metadata path (calculateSlackPriorityWithMetadata) ───────────────────────

describe("calculateSlackPriorityWithMetadata", () => {
  it("should return the same score as calculateSlackPriority", () => {
    const messages = [
      makeMessage({ type: "saved", text: "urgent fix needed", timestamp: toSlackTs(hoursAgo(0.5, NOW)) }),
      makeMessage({ type: "mention", text: "can you review this", timestamp: toSlackTs(hoursAgo(3, NOW)) }),
      makeMessage({ type: "dm", text: "hello there", timestamp: toSlackTs(hoursAgo(10, NOW)) }),
      makeMessage({ type: "saved", text: "sounds good", timestamp: toSlackTs(hoursAgo(48, NOW)) }),
    ];

    for (const msg of messages) {
      const score = calculateSlackPriority(msg, NOW);
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.score).toBe(score);
    }
  });

  describe("signals", () => {
    it("should set hasUrgentKeywords when urgency keywords are present", () => {
      const msg = makeMessage({ type: "mention", text: "this is urgent", timestamp: toSlackTs(hoursAgo(2, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.signals.hasUrgentKeywords).toBe(true);
      expect(metadata.signals.hasQuestion).toBe(false);
      expect(metadata.signals.hasActionRequest).toBe(false);
    });

    it("should set hasQuestion when question keywords are present", () => {
      const msg = makeMessage({ type: "dm", text: "can you help with this", timestamp: toSlackTs(hoursAgo(2, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.signals.hasQuestion).toBe(true);
    });

    it("should set hasActionRequest when action keywords are present", () => {
      const msg = makeMessage({ type: "dm", text: "review the PR", timestamp: toSlackTs(hoursAgo(2, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.signals.hasActionRequest).toBe(true);
    });

    it("should include message type in signals", () => {
      const msg = makeMessage({ type: "saved", text: "hello", timestamp: toSlackTs(hoursAgo(2, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.signals.type).toBe("saved");
    });

    it("should include ageHours and recencyBoost in signals", () => {
      const ts = toSlackTs(hoursAgo(0.5, NOW));
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: ts });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.signals.ageHours).toBeCloseTo(0.5, 1);
      expect(metadata.signals.recencyBoost).toBe("very_recent");
    });
  });

  describe("reasons", () => {
    it("should include type reason for saved messages", () => {
      const msg = makeMessage({ type: "saved", text: "hello", timestamp: toSlackTs(hoursAgo(48, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.reasons).toContain("Saved with emoji");
    });

    it("should include type reason for mentions", () => {
      const msg = makeMessage({ type: "mention", text: "hello", timestamp: toSlackTs(hoursAgo(48, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.reasons).toContain("@Mention");
    });

    it("should include type reason for DMs", () => {
      const msg = makeMessage({ type: "dm", text: "hello", timestamp: toSlackTs(hoursAgo(48, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.reasons).toContain("Direct message");
    });

    it("should include 'Urgent keywords' when urgency keywords match", () => {
      const msg = makeMessage({ type: "saved", text: "asap please", timestamp: toSlackTs(hoursAgo(48, NOW)) });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.reasons).toContain("Urgent keywords");
    });

    it("should include 'Very recent' for messages < 1 hour old", () => {
      const ts = toSlackTs(hoursAgo(0.25, NOW));
      const msg = makeMessage({ type: "saved", text: "hello", timestamp: ts });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.reasons).toContain("Very recent");
    });

    it("should NOT include 'Very recent' for messages > 1 hour old", () => {
      const ts = toSlackTs(hoursAgo(2, NOW));
      const msg = makeMessage({ type: "saved", text: "hello", timestamp: ts });
      const metadata = calculateSlackPriorityWithMetadata(msg, NOW);
      expect(metadata.reasons).not.toContain("Very recent");
    });
  });

  describe("category", () => {
    it("should categorize based on score using standard thresholds", () => {
      // DM (70) + no keywords + >24h = 70 → low
      const low = makeMessage({ type: "dm", text: "hello", timestamp: toSlackTs(hoursAgo(48, NOW)) });
      expect(calculateSlackPriorityWithMetadata(low, NOW).category).toBe("low");

      // mention (90) + no keywords + >24h = 90 → medium
      const medium = makeMessage({ type: "mention", text: "hello", timestamp: toSlackTs(hoursAgo(48, NOW)) });
      expect(calculateSlackPriorityWithMetadata(medium, NOW).category).toBe("medium");

      // saved (100) + question (40) + >24h = 140 → high
      const high = makeMessage({ type: "saved", text: "can you look at this", timestamp: toSlackTs(hoursAgo(48, NOW)) });
      expect(calculateSlackPriorityWithMetadata(high, NOW).category).toBe("high");

      // saved (100) + urgent (80) + very recent (50) = 230 → critical
      const critical = makeMessage({ type: "saved", text: "urgent fix now", timestamp: toSlackTs(hoursAgo(0.25, NOW)) });
      expect(calculateSlackPriorityWithMetadata(critical, NOW).category).toBe("critical");
    });
  });
});
