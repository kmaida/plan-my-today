/**
 * Tests for the action-completion-store — the file-based JSON store
 * that tracks which tasks a user has dismissed.
 *
 * The existing completion-identifier-consistency.test.ts covers the
 * mark/check roundtrip for identifier formats. This file tests the
 * store's remaining API surface: undo, bulk lookup, pruning, and
 * error recovery.
 *
 * KNOWN ISSUE: The store does read-modify-write on a JSON file with
 * no file locking. Concurrent writes (e.g., dashboard + agent) can
 * lose one writer's changes (TOCTOU race). See the skipped test below.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  forcePrune,
  getCompletedBySource,
  getCompletedBySources,
  isActionCompleted,
  markActionComplete,
  markActionIncomplete,
} from "../action-completion-store";

const COMPLETIONS_FILE = path.join(process.cwd(), "data", "completed-actions.json");

beforeEach(async () => {
  await fs.mkdir(path.dirname(COMPLETIONS_FILE), { recursive: true });
  await fs.writeFile(COMPLETIONS_FILE, JSON.stringify({ completions: {} }));
});

// ── markActionIncomplete (undo) ──────────────────────────────────────────────

describe("markActionIncomplete", () => {
  it("should remove a previously completed action", async () => {
    await markActionComplete("slack", "C123:1234567890.000001");
    expect(await isActionCompleted("slack", "C123:1234567890.000001")).toBe(true);

    await markActionIncomplete("slack", "C123:1234567890.000001");
    expect(await isActionCompleted("slack", "C123:1234567890.000001")).toBe(false);
  });

  it("should be a no-op when the action was never completed", async () => {
    // Should not throw
    await expect(markActionIncomplete("docs", "nonexistent")).resolves.not.toThrow();
  });

  it("should not affect other completions", async () => {
    await markActionComplete("slack", "id-1");
    await markActionComplete("slack", "id-2");

    await markActionIncomplete("slack", "id-1");

    expect(await isActionCompleted("slack", "id-1")).toBe(false);
    expect(await isActionCompleted("slack", "id-2")).toBe(true);
  });
});

// ── getCompletedBySources (bulk lookup) ──────────────────────────────────────

describe("getCompletedBySources", () => {
  it("should return identifiers grouped by source", async () => {
    await markActionComplete("slack", "C123:ts1");
    await markActionComplete("slack", "C456:ts2");
    await markActionComplete("docs", "https://docs.google.com/d/abc");
    await markActionComplete("meeting-note", "doc-xyz");

    const result = await getCompletedBySources(["slack", "docs", "meeting-note"]);

    expect(result.get("slack")).toEqual(new Set(["C123:ts1", "C456:ts2"]));
    expect(result.get("docs")).toEqual(new Set(["https://docs.google.com/d/abc"]));
    expect(result.get("meeting-note")).toEqual(new Set(["doc-xyz"]));
  });

  it("should return empty Sets for sources with no completions", async () => {
    await markActionComplete("slack", "C123:ts1");

    const result = await getCompletedBySources(["docs", "meeting-note"]);

    expect(result.get("docs")).toEqual(new Set());
    expect(result.get("meeting-note")).toEqual(new Set());
  });

  it("should strip the source prefix from identifiers", async () => {
    // The raw store key is "slack:C123:ts1" but getCompletedBySources
    // should return just "C123:ts1" (without the source prefix)
    await markActionComplete("slack", "C123:ts1");

    const result = await getCompletedBySources(["slack"]);
    const ids = result.get("slack")!;

    expect(ids.has("C123:ts1")).toBe(true);
    expect(ids.has("slack:C123:ts1")).toBe(false);
  });
});

// ── getCompletedBySource (single-source convenience) ─────────────────────────

describe("getCompletedBySource", () => {
  it("should return identifiers for a single source", async () => {
    await markActionComplete("docs", "link-1");
    await markActionComplete("docs", "link-2");
    await markActionComplete("slack", "unrelated");

    const result = await getCompletedBySource("docs");

    expect(result).toEqual(new Set(["link-1", "link-2"]));
  });

  it("should return an empty Set when no completions exist for the source", async () => {
    const result = await getCompletedBySource("adhoc");
    expect(result).toEqual(new Set());
  });
});

// ── Pruning ──────────────────────────────────────────────────────────────────

describe("forcePrune", () => {
  it("should remove completions older than the specified days", async () => {
    // Write a completion with a timestamp 45 days ago.
    // Include lastPruned set to now so auto-prune doesn't trigger during
    // readCompletionsFile (which would prune before forcePrune can count).
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 45);
    const data = {
      completions: {
        "slack:old-msg": {
          source: "slack",
          identifier: "old-msg",
          completedAt: oldDate.toISOString(),
        },
        "slack:recent-msg": {
          source: "slack",
          identifier: "recent-msg",
          completedAt: new Date().toISOString(),
        },
      },
      lastPruned: new Date().toISOString(),
    };
    await fs.writeFile(COMPLETIONS_FILE, JSON.stringify(data));

    const pruned = await forcePrune(30);

    expect(pruned).toBe(1); // One item removed
    expect(await isActionCompleted("slack", "recent-msg")).toBe(true);
    expect(await isActionCompleted("slack", "old-msg")).toBe(false);
  });

  it("should remove all old completions when daysBack is small", async () => {
    // Write completions that are 2 days old, then prune with daysBack=1.
    // Include lastPruned=now to suppress auto-prune in readCompletionsFile.
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const data = {
      completions: {
        "slack:id-1": {
          source: "slack",
          identifier: "id-1",
          completedAt: twoDaysAgo.toISOString(),
        },
        "docs:id-2": {
          source: "docs",
          identifier: "id-2",
          completedAt: twoDaysAgo.toISOString(),
        },
      },
      lastPruned: new Date().toISOString(),
    };
    await fs.writeFile(COMPLETIONS_FILE, JSON.stringify(data));

    const pruned = await forcePrune(1);

    expect(pruned).toBe(2);
    expect(await isActionCompleted("slack", "id-1")).toBe(false);
    expect(await isActionCompleted("docs", "id-2")).toBe(false);
  });

  it("should return 0 when nothing needs pruning", async () => {
    await markActionComplete("slack", "recent");

    const pruned = await forcePrune(30);

    expect(pruned).toBe(0);
  });
});

// ── File error handling ──────────────────────────────────────────────────────

describe("File error handling", () => {
  it("should return empty data when completions file is missing", async () => {
    await fs.unlink(COMPLETIONS_FILE).catch(() => {});

    // Should not throw — returns empty store
    const completed = await isActionCompleted("slack", "anything");
    expect(completed).toBe(false);
  });

  it("should return empty data when completions file has invalid JSON", async () => {
    await fs.writeFile(COMPLETIONS_FILE, "not valid json{{{");

    const completed = await isActionCompleted("slack", "anything");
    expect(completed).toBe(false);
  });

  it("should recover by writing a valid file after reading corrupt data", async () => {
    await fs.writeFile(COMPLETIONS_FILE, "corrupt");

    // This reads the corrupt file (gets empty), then writes a valid file
    await markActionComplete("slack", "id-1");

    // Now the file should be valid and the completion should persist
    const completed = await isActionCompleted("slack", "id-1");
    expect(completed).toBe(true);
  });
});

// ── Concurrent write race condition (KNOWN ISSUE) ────────────────────────────

describe("Concurrent writes", () => {
  // KNOWN ISSUE: The store does read → modify → write without file locking.
  // If two writes happen concurrently, the second writer reads the file
  // before the first writer has finished writing, then overwrites the
  // first writer's changes.
  //
  // Possible fixes:
  // - proper-lockfile or fs-ext advisory locks
  // - Atomic write via write-to-temp + rename
  // - In-memory cache with single-writer queue + periodic flush
  it.skip("concurrent markActionComplete calls should both persist (TOCTOU race)", async () => {
    // Fire two marks simultaneously without awaiting between them
    await Promise.all([
      markActionComplete("slack", "id-concurrent-1"),
      markActionComplete("slack", "id-concurrent-2"),
    ]);

    // Both should survive — but one may be lost due to the race
    expect(await isActionCompleted("slack", "id-concurrent-1")).toBe(true);
    expect(await isActionCompleted("slack", "id-concurrent-2")).toBe(true);
  });
});
