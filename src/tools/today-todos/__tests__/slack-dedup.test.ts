/**
 * Tests for Slack message deduplication via deduplicateAndGroup().
 *
 * This function merges results from four parallel Slack searches
 * (saved, mentions, threads, DMs) into a single deduplicated list.
 * Correctness is critical: a dedup bug silently hides messages or
 * shows duplicates in the user's daily task list.
 *
 * Key invariants tested:
 *   1. Priority ordering: saved > mentions > threads > DMs
 *   2. Dedup key: thread_ts || ts — first occurrence wins
 *   3. Self-thread filtering: user's own threads are excluded
 *   4. DismissalId format: "{channelId}:{ts}" (matches UI contract)
 *   5. Output sorted by timestamp descending (most recent first)
 */

import { deduplicateAndGroup } from "../slack-utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal raw Slack message for testing. */
function makeRaw(overrides: {
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  channel?: { id: string; name: string };
  permalink?: string;
  username?: string;
}) {
  return {
    type: "message" as const,
    user: overrides.user ?? "U_OTHER",
    ts: overrides.ts,
    text: overrides.text ?? "hello",
    channel: overrides.channel ?? { id: "C123", name: "general" },
    permalink: overrides.permalink,
    username: overrides.username,
    thread_ts: overrides.thread_ts,
  };
}

const USER_ID = "U_SELF";

// ── Deduplication: key = thread_ts || ts ────────────────────────────────────

describe("deduplicateAndGroup", () => {
  describe("basic deduplication", () => {
    it("should deduplicate messages with the same ts across categories", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup(
        [msg], // mentions
        [],    // threads
        [msg], // dms (same ts)
        [],    // saved
        USER_ID,
      );

      expect(result).toHaveLength(1);
      // Mentions are processed before DMs, so type should be "mention"
      expect(result[0].type).toBe("mention");
    });

    it("should deduplicate using thread_ts when present", () => {
      // Two messages in the same thread — different ts, same thread_ts
      const mentionMsg = makeRaw({ ts: "1001.000000", thread_ts: "1000.000000" });
      const dmMsg = makeRaw({ ts: "1002.000000", thread_ts: "1000.000000" });

      const result = deduplicateAndGroup(
        [mentionMsg], // mentions
        [],
        [dmMsg], // dms
        [],
        USER_ID,
      );

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("mention");
    });

    it("should keep messages with different dedup keys", () => {
      const msg1 = makeRaw({ ts: "1000.000000" });
      const msg2 = makeRaw({ ts: "2000.000000" });

      const result = deduplicateAndGroup([msg1], [], [msg2], [], USER_ID);

      expect(result).toHaveLength(2);
    });

    it("should treat messages without thread_ts as keyed by ts", () => {
      const msg1 = makeRaw({ ts: "1000.000000" }); // no thread_ts → key = ts
      const msg2 = makeRaw({ ts: "1000.000000", thread_ts: undefined });

      const result = deduplicateAndGroup([msg1], [], [msg2], [], USER_ID);

      // Same ts, both without thread_ts → same key → deduplicated
      expect(result).toHaveLength(1);
    });
  });

  // ── Priority ordering: saved > mentions > threads > DMs ─────────────────

  describe("priority ordering", () => {
    it("should prefer saved over mention for same message", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup(
        [msg], // mentions
        [],
        [],
        [msg], // saved (processed first)
        USER_ID,
      );

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("saved");
    });

    it("should prefer saved over DM for same message", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([], [], [msg], [msg], USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("saved");
    });

    it("should prefer mention over thread for same message", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([msg], [msg], [], [], USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("mention");
    });

    it("should prefer mention over DM for same message", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([msg], [], [msg], [], USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("mention");
    });

    it("should prefer thread over DM for same message", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([], [msg], [msg], [], USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("thread");
    });

    it("should process all four categories in order with mixed messages", () => {
      // 4 messages, each appearing in a different category
      const saved = makeRaw({ ts: "1000.000000" });
      const mention = makeRaw({ ts: "2000.000000" });
      const thread = makeRaw({ ts: "3000.000000" });
      const dm = makeRaw({ ts: "4000.000000" });

      const result = deduplicateAndGroup(
        [mention],
        [thread],
        [dm],
        [saved],
        USER_ID,
      );

      expect(result).toHaveLength(4);
      // Sorted by timestamp descending
      const types = result.map((r) => r.type);
      expect(types).toContain("saved");
      expect(types).toContain("mention");
      expect(types).toContain("thread");
      expect(types).toContain("dm");
    });
  });

  // ── Self-thread filtering ───────────────────────────────────────────────

  describe("self-thread filtering", () => {
    it("should exclude threads where user is the poster", () => {
      const selfThread = makeRaw({ ts: "1000.000000", user: USER_ID });

      const result = deduplicateAndGroup([], [selfThread], [], [], USER_ID);

      expect(result).toHaveLength(0);
    });

    it("should include threads from other users", () => {
      const otherThread = makeRaw({ ts: "1000.000000", user: "U_OTHER" });

      const result = deduplicateAndGroup([], [otherThread], [], [], USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("thread");
    });

    it("should not filter self-messages in non-thread categories", () => {
      // Mentions and DMs from the user themselves should still appear
      const selfMention = makeRaw({ ts: "1000.000000", user: USER_ID });
      const selfDm = makeRaw({ ts: "2000.000000", user: USER_ID });

      const result = deduplicateAndGroup([selfMention], [], [selfDm], [], USER_ID);

      expect(result).toHaveLength(2);
    });

    it("should add replyCount: 1 for thread messages", () => {
      const thread = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([], [thread], [], [], USER_ID);

      expect(result[0].replyCount).toBe(1);
    });

    it("should not add replyCount for non-thread messages", () => {
      const mention = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([mention], [], [], [], USER_ID);

      expect(result[0].replyCount).toBeUndefined();
    });
  });

  // ── DismissalId format ──────────────────────────────────────────────────

  describe("dismissalId contract", () => {
    it("should format dismissalId as {channelId}:{ts}", () => {
      const msg = makeRaw({
        ts: "1707654321.123456",
        channel: { id: "C_ABC", name: "general" },
      });

      const result = deduplicateAndGroup([msg], [], [], [], USER_ID);

      expect(result[0].dismissalId).toBe("C_ABC:1707654321.123456");
    });

    it("should use message ts (not thread_ts) in dismissalId", () => {
      const msg = makeRaw({
        ts: "1002.000000",
        thread_ts: "1000.000000",
        channel: { id: "C123", name: "general" },
      });

      const result = deduplicateAndGroup([msg], [], [], [], USER_ID);

      // dismissalId uses the message's own ts, not thread_ts
      expect(result[0].dismissalId).toBe("C123:1002.000000");
    });

    it("should set dismissalId to undefined when channel is missing", () => {
      // Construct directly to avoid makeRaw's default channel
      const msg = {
        type: "message" as const,
        user: "U_OTHER",
        ts: "1000.000000",
        text: "hello",
      };

      const result = deduplicateAndGroup([msg], [], [], [], USER_ID);

      // channelId is empty string → guard (channelId && msg.ts) is falsy → undefined
      expect(result[0].dismissalId).toBeUndefined();
    });
  });

  // ── Timestamp sorting ──────────────────────────────────────────────────

  describe("output ordering", () => {
    it("should sort results by timestamp descending (most recent first)", () => {
      const old = makeRaw({ ts: "1000.000000" });
      const mid = makeRaw({ ts: "2000.000000" });
      const recent = makeRaw({ ts: "3000.000000" });

      // Feed in reverse order to confirm sorting happens
      const result = deduplicateAndGroup([old, recent, mid], [], [], [], USER_ID);

      expect(result.map((r) => r.timestamp)).toEqual([
        "3000.000000",
        "2000.000000",
        "1000.000000",
      ]);
    });

    it("should sort correctly when messages come from different categories", () => {
      const savedOld = makeRaw({ ts: "1000.000000" });
      const mentionNew = makeRaw({ ts: "3000.000000" });
      const dmMid = makeRaw({ ts: "2000.000000" });

      const result = deduplicateAndGroup(
        [mentionNew],
        [],
        [dmMid],
        [savedOld],
        USER_ID,
      );

      expect(result.map((r) => r.timestamp)).toEqual([
        "3000.000000",
        "2000.000000",
        "1000.000000",
      ]);
    });
  });

  // ── Field mapping ──────────────────────────────────────────────────────

  describe("field mapping from raw to detail", () => {
    it("should map all fields from raw message to SlackMessageDetail", () => {
      const msg = makeRaw({
        ts: "1000.000000",
        text: "review the PR please",
        user: "U_SENDER",
        username: "sender-name",
        channel: { id: "C_CHAN", name: "dev" },
        permalink: "https://slack.com/archives/C_CHAN/p1000",
        thread_ts: "999.000000",
      });

      const result = deduplicateAndGroup([msg], [], [], [], USER_ID);

      expect(result[0]).toMatchObject({
        text: "review the PR please",
        timestamp: "1000.000000",
        channel: "C_CHAN",
        channelName: "dev",
        user: "U_SENDER",
        userName: "sender-name",
        permalink: "https://slack.com/archives/C_CHAN/p1000",
        threadTs: "999.000000",
        type: "mention",
        dismissalId: "C_CHAN:1000.000000",
      });
    });

    it("should handle missing optional fields gracefully", () => {
      const msg = {
        type: "message" as const,
        user: "U_OTHER",
        ts: "1000.000000",
        text: "",
      };

      const result = deduplicateAndGroup([msg], [], [], [], USER_ID);

      expect(result[0].text).toBe("");
      expect(result[0].channel).toBe("");
      expect(result[0].channelName).toBeUndefined();
      expect(result[0].userName).toBeUndefined();
      expect(result[0].permalink).toBeUndefined();
      expect(result[0].threadTs).toBeUndefined();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should return empty array when all inputs are empty", () => {
      const result = deduplicateAndGroup([], [], [], [], USER_ID);
      expect(result).toEqual([]);
    });

    it("should handle a single message in a single category", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([], [], [], [msg], USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("saved");
    });

    it("should handle the same message appearing in all four categories", () => {
      const msg = makeRaw({ ts: "1000.000000" });

      const result = deduplicateAndGroup([msg], [msg], [msg], [msg], USER_ID);

      // saved wins (processed first), only one result
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("saved");
    });
  });
});
