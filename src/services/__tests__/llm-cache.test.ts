/**
 * Tests for the LLM extraction cache — the file-based JSON store
 * that persists combined regex + LLM extraction results so documents
 * are only analyzed once.
 *
 * Uses LLM_CACHE_FILE_PATH env var (set in tests/setup.ts) to isolate
 * from the live cache file, following the same pattern as the
 * action-completion-store tests.
 *
 * The cache uses a "session" pattern (loadCache → in-memory ops → saveCache)
 * to avoid the race condition that would occur with per-call file I/O
 * when multiple documents are processed concurrently in Promise.all batches.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionCacheData } from "../llm-cache";
import {
  getCachedItems,
  loadCache,
  pruneCacheEntries,
  saveCache,
  setCachedItems,
} from "../llm-cache";

const CACHE_FILE = process.env.LLM_CACHE_FILE_PATH as string; // set per jest worker in tests/setup.ts

// ── Mock logger ──

jest.mock("../../observability/logger", () => ({
  getLogger: () => ({
    withOperation: () => ({
      info: jest.fn(),
      warn: jest.fn(),
    }),
  }),
}));

beforeEach(async () => {
  // Start each test with a clean slate — remove any leftover cache file
  await fs.unlink(CACHE_FILE).catch(() => {});
});

afterAll(async () => {
  await fs.unlink(CACHE_FILE).catch(() => {});
});

// ── loadCache ─────────────────────────────────────────────────────────────────

describe("loadCache", () => {
  it("returns empty cache when file does not exist", async () => {
    const cache = await loadCache();

    expect(cache).toEqual({ entries: {} });
  });

  it("returns empty cache when file contains invalid JSON", async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, "not valid json{{{");

    const cache = await loadCache();

    expect(cache).toEqual({ entries: {} });
  });

  it("loads existing cache entries from disk", async () => {
    const data: ExtractionCacheData = {
      entries: {
        "doc-1": {
          items: [{ text: "Follow up with vendor", isUrgent: false }],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
      },
    };
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(data));

    const cache = await loadCache();

    expect(cache.entries["doc-1"]).toBeDefined();
    expect(cache.entries["doc-1"].items).toHaveLength(1);
    expect(cache.entries["doc-1"].items[0].text).toBe("Follow up with vendor");
  });
});

// ── getCachedItems ────────────────────────────────────────────────────────────

describe("getCachedItems", () => {
  it("returns null for a cache miss", () => {
    const cache: ExtractionCacheData = { entries: {} };

    expect(getCachedItems(cache, "nonexistent-doc")).toBeNull();
  });

  it("returns items for a cache hit", () => {
    const items = [
      { text: "Ship auth changes", isUrgent: true },
      { text: "Review PR #456", assignee: "Kim", isUrgent: false },
    ];
    const cache: ExtractionCacheData = {
      entries: {
        "doc-abc": { items, cachedAt: "2026-02-17T10:00:00.000Z" },
      },
    };

    const result = getCachedItems(cache, "doc-abc");

    expect(result).toEqual(items);
  });
});

// ── setCachedItems ────────────────────────────────────────────────────────────

describe("setCachedItems", () => {
  it("writes items to the in-memory cache (no disk I/O)", () => {
    const cache: ExtractionCacheData = { entries: {} };
    const items = [{ text: "New action item", isUrgent: false }];

    setCachedItems(cache, "doc-new", items);

    expect(cache.entries["doc-new"]).toBeDefined();
    expect(cache.entries["doc-new"].items).toEqual(items);
    expect(cache.entries["doc-new"].cachedAt).toBeDefined();
  });

  it("overwrites existing entry for the same document", () => {
    const cache: ExtractionCacheData = {
      entries: {
        "doc-1": {
          items: [{ text: "Old item", isUrgent: false }],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
      },
    };
    const newItems = [{ text: "Updated item", isUrgent: true }];

    setCachedItems(cache, "doc-1", newItems);

    expect(cache.entries["doc-1"].items).toEqual(newItems);
  });
});

// ── saveCache ─────────────────────────────────────────────────────────────────

describe("saveCache", () => {
  it("persists cache to disk and can be re-loaded", async () => {
    const cache: ExtractionCacheData = { entries: {} };
    setCachedItems(cache, "doc-roundtrip", [
      { text: "Roundtrip test item", assignee: "Kim", isUrgent: true },
    ]);

    await saveCache(cache);

    // Re-load from disk to verify persistence
    const reloaded = await loadCache();
    expect(reloaded.entries["doc-roundtrip"]).toBeDefined();
    expect(reloaded.entries["doc-roundtrip"].items[0].text).toBe("Roundtrip test item");
    expect(reloaded.entries["doc-roundtrip"].items[0].assignee).toBe("Kim");
    expect(reloaded.entries["doc-roundtrip"].items[0].isUrgent).toBe(true);
  });
});

// ── pruneCacheEntries ─────────────────────────────────────────────────────────

describe("pruneCacheEntries", () => {
  it("removes entries not in the eligible set", () => {
    const cache: ExtractionCacheData = {
      entries: {
        "doc-keep": {
          items: [{ text: "Keep me", isUrgent: false }],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
        "doc-stale": {
          items: [{ text: "Remove me", isUrgent: false }],
          cachedAt: "2026-02-15T10:00:00.000Z",
        },
      },
    };

    const pruned = pruneCacheEntries(cache, new Set(["doc-keep"]));

    expect(pruned).toBe(1);
    expect(cache.entries["doc-keep"]).toBeDefined();
    expect(cache.entries["doc-stale"]).toBeUndefined();
  });

  it("returns 0 when all entries are eligible", () => {
    const cache: ExtractionCacheData = {
      entries: {
        "doc-a": {
          items: [],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
        "doc-b": {
          items: [],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
      },
    };

    const pruned = pruneCacheEntries(cache, new Set(["doc-a", "doc-b"]));

    expect(pruned).toBe(0);
    expect(Object.keys(cache.entries)).toHaveLength(2);
  });

  it("removes all entries when eligible set is empty", () => {
    const cache: ExtractionCacheData = {
      entries: {
        "doc-a": {
          items: [{ text: "Item A", isUrgent: false }],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
        "doc-b": {
          items: [{ text: "Item B", isUrgent: false }],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
      },
    };

    const pruned = pruneCacheEntries(cache, new Set());

    expect(pruned).toBe(2);
    expect(Object.keys(cache.entries)).toHaveLength(0);
  });

  it("handles empty cache gracefully", () => {
    const cache: ExtractionCacheData = { entries: {} };

    const pruned = pruneCacheEntries(cache, new Set(["doc-a"]));

    expect(pruned).toBe(0);
  });
});

// ── Session pattern (race condition fix) ──────────────────────────────────────

describe("Session pattern (concurrent safety)", () => {
  it("concurrent setCachedItems on the SAME in-memory object all persist", () => {
    // This is the key test: because setCachedItems is synchronous and operates
    // on the same object reference, concurrent calls within a Promise.all
    // batch all write to the same object — no lost updates.
    const cache: ExtractionCacheData = { entries: {} };

    // Simulate what happens in fetchMeetingNoteActions:
    // 3 concurrent docs all call setCachedItems on the same cache object
    setCachedItems(cache, "doc-1", [{ text: "Item from doc 1", isUrgent: false }]);
    setCachedItems(cache, "doc-2", [{ text: "Item from doc 2", isUrgent: true }]);
    setCachedItems(cache, "doc-3", [{ text: "Item from doc 3", isUrgent: false }]);

    // All three should be present
    expect(Object.keys(cache.entries)).toHaveLength(3);
    expect(getCachedItems(cache, "doc-1")).toHaveLength(1);
    expect(getCachedItems(cache, "doc-2")).toHaveLength(1);
    expect(getCachedItems(cache, "doc-3")).toHaveLength(1);
  });

  it("full session lifecycle: load → get/set → prune → save", async () => {
    // Seed the cache file with one existing entry
    const seed: ExtractionCacheData = {
      entries: {
        "doc-existing": {
          items: [{ text: "Cached item", isUrgent: false }],
          cachedAt: "2026-02-17T10:00:00.000Z",
        },
        "doc-stale": {
          items: [{ text: "Stale item", isUrgent: false }],
          cachedAt: "2026-02-15T10:00:00.000Z",
        },
      },
    };
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(seed));

    // 1. Load cache once
    const cache = await loadCache();
    expect(Object.keys(cache.entries)).toHaveLength(2);

    // 2. Cache hit for existing doc
    const existing = getCachedItems(cache, "doc-existing");
    expect(existing).toHaveLength(1);

    // 3. Cache miss for new doc → process and store
    expect(getCachedItems(cache, "doc-new")).toBeNull();
    setCachedItems(cache, "doc-new", [{ text: "New item from extraction", isUrgent: true }]);

    // 4. Prune stale entries (doc-stale not in eligible set)
    const pruned = pruneCacheEntries(cache, new Set(["doc-existing", "doc-new"]));
    expect(pruned).toBe(1);

    // 5. Save once at the end
    await saveCache(cache);

    // 6. Verify by re-loading from disk
    const reloaded = await loadCache();
    expect(Object.keys(reloaded.entries)).toHaveLength(2);
    expect(reloaded.entries["doc-existing"]).toBeDefined();
    expect(reloaded.entries["doc-new"]).toBeDefined();
    expect(reloaded.entries["doc-stale"]).toBeUndefined();
  });
});
