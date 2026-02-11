/**
 * Tests for cache-utils — removeTaskFromCache evicts a single task
 * from the cached tasks JSON file (data/latest-tasks.json).
 *
 * This is the only path through which the dashboard can mutate the
 * tasks cache. The agent writes the entire file via list-all-tasks-today.
 * Both actors doing read-modify-write on the same file creates a race
 * condition documented in the skipped test below.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { removeTaskFromCache } from "../cache-utils";

const TEST_CACHE_PATH = path.join(process.cwd(), "data", "test-cache.json");

beforeEach(async () => {
  await fs.mkdir(path.dirname(TEST_CACHE_PATH), { recursive: true });
});

afterEach(async () => {
  await fs.unlink(TEST_CACHE_PATH).catch(() => {});
});

/** Write test data to the cache file */
async function writeCache(data: Record<string, unknown>): Promise<void> {
  await fs.writeFile(TEST_CACHE_PATH, JSON.stringify(data, null, 2));
}

/** Read test data from the cache file */
async function readCache(): Promise<Record<string, unknown>> {
  const content = await fs.readFile(TEST_CACHE_PATH, "utf-8");
  return JSON.parse(content);
}

// ── Basic removal ────────────────────────────────────────────────────────────

describe("removeTaskFromCache", () => {
  it("should remove a task from a flat array section", async () => {
    await writeCache({
      linear: [
        { taskId: "task-1", title: "Keep me" },
        { taskId: "task-2", title: "Remove me" },
      ],
      metadata: { fetched_at: "2026-02-11" },
    });

    await removeTaskFromCache("task-2", TEST_CACHE_PATH);

    const data = await readCache();
    expect(data.linear).toEqual([{ taskId: "task-1", title: "Keep me" }]);
  });

  it("should remove a task from a nested object section (github.prs)", async () => {
    await writeCache({
      github: {
        prs: [
          { taskId: "pr-1", title: "Keep" },
          { taskId: "pr-2", title: "Remove" },
        ],
        issues: [{ taskId: "issue-1", title: "Keep" }],
      },
      metadata: { fetched_at: "2026-02-11" },
    });

    await removeTaskFromCache("pr-2", TEST_CACHE_PATH);

    const data = await readCache();
    const github = data.github as { prs: unknown[]; issues: unknown[] };
    expect(github.prs).toEqual([{ taskId: "pr-1", title: "Keep" }]);
    expect(github.issues).toEqual([{ taskId: "issue-1", title: "Keep" }]);
  });

  it("should skip the metadata key", async () => {
    await writeCache({
      linear: [{ taskId: "task-1" }],
      metadata: { fetched_at: "2026-02-11", date: "2026-02-11" },
    });

    await removeTaskFromCache("task-1", TEST_CACHE_PATH);

    const data = await readCache();
    // metadata should be completely untouched
    expect(data.metadata).toEqual({
      fetched_at: "2026-02-11",
      date: "2026-02-11",
    });
  });

  it("should be a no-op when taskId is not found", async () => {
    const original = {
      linear: [{ taskId: "task-1", title: "Task" }],
      metadata: { fetched_at: "2026-02-11" },
    };
    await writeCache(original);

    await removeTaskFromCache("nonexistent", TEST_CACHE_PATH);

    const data = await readCache();
    expect(data).toEqual(original);
  });

  it("should not write the file when nothing was removed", async () => {
    await writeCache({
      linear: [{ taskId: "task-1" }],
    });

    const statBefore = await fs.stat(TEST_CACHE_PATH);

    // Small delay to ensure mtime would differ if file were written
    await new Promise((r) => setTimeout(r, 50));

    await removeTaskFromCache("nonexistent", TEST_CACHE_PATH);

    const statAfter = await fs.stat(TEST_CACHE_PATH);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("should remove a task that appears in multiple sections", async () => {
    // Unusual but possible if taskId is shared across sources
    await writeCache({
      linear: [{ taskId: "shared-id", title: "Linear" }],
      slack: [{ taskId: "shared-id", text: "Slack" }],
    });

    await removeTaskFromCache("shared-id", TEST_CACHE_PATH);

    const data = await readCache();
    expect(data.linear).toEqual([]);
    expect(data.slack).toEqual([]);
  });
});

// ── Error handling ───────────────────────────────────────────────────────────

describe("Error handling", () => {
  it("should silently handle missing cache file", async () => {
    // File doesn't exist — should not throw
    await expect(
      removeTaskFromCache("task-1", "/tmp/nonexistent-cache-file.json")
    ).resolves.not.toThrow();
  });

  it("should silently handle malformed JSON", async () => {
    await fs.writeFile(TEST_CACHE_PATH, "not valid json{{{");

    await expect(removeTaskFromCache("task-1", TEST_CACHE_PATH)).resolves.not.toThrow();
  });
});

// ── Concurrent write race condition (KNOWN ISSUE) ────────────────────────────

describe("Concurrent writes", () => {
  // KNOWN ISSUE: The agent writes the full tasks cache via
  // list-all-tasks-today while the dashboard calls removeTaskFromCache.
  // Both do read → modify → write without locking:
  //
  // 1. Dashboard reads file (has tasks A, B, C)
  // 2. Agent reads file (has tasks A, B, C)
  // 3. Agent writes file (new data: tasks D, E, F)
  // 4. Dashboard writes file (removes B from old data: tasks A, C)
  //    → Agent's refresh is lost!
  //
  // Alternatively:
  // 1. Agent writes fresh data
  // 2. Dashboard removes one task from the now-stale read
  //    → The removal overwrites the agent's fresh data
  //
  // Possible fixes:
  // - Write to temp file + atomic rename
  // - Advisory file lock (e.g., proper-lockfile)
  // - In-memory cache with write queue
  it.skip("dashboard eviction should not overwrite agent refresh (TOCTOU race)", async () => {
    await writeCache({
      linear: [
        { taskId: "old-1", title: "Old" },
        { taskId: "old-2", title: "Old" },
      ],
    });

    // Simulate: agent writes new data, dashboard removes from stale read
    const dashboardRead = fs.readFile(TEST_CACHE_PATH, "utf-8");
    const agentData = { linear: [{ taskId: "new-1", title: "Fresh" }] };
    await fs.writeFile(TEST_CACHE_PATH, JSON.stringify(agentData));

    // Dashboard now writes its filtered version of the OLD data
    const oldData = JSON.parse(await dashboardRead);
    oldData.linear = oldData.linear.filter((t: { taskId: string }) => t.taskId !== "old-1");
    await fs.writeFile(TEST_CACHE_PATH, JSON.stringify(oldData));

    // The agent's fresh data should be preserved — but it's overwritten
    const data = await readCache();
    expect((data.linear as unknown[]).length).toBe(1);
    expect((data.linear as Array<{ taskId: string }>)[0].taskId).toBe("new-1");
  });
});
