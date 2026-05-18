/**
 * Tests for task-store-utils — removeTaskFromStore evicts a single task
 * from the task store JSON file (data/latest-tasks.json).
 *
 * This is the only path through which the dashboard can mutate the
 * task store. The agent writes the entire file via list-all-tasks-today.
 * Both actors doing read-modify-write on the same file creates a race
 * condition documented in the skipped test below.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { mutateTaskStore, removeTaskFromStore, writeTaskStore } from "../task-store-utils";

const TEST_STORE_PATH = path.join(process.cwd(), "data", "test-store.json");

beforeEach(async () => {
  await fs.mkdir(path.dirname(TEST_STORE_PATH), { recursive: true });
});

afterEach(async () => {
  await fs.unlink(TEST_STORE_PATH).catch(() => {});
});

/** Write test data to the task store file */
async function writeStore(data: Record<string, unknown>): Promise<void> {
  await fs.writeFile(TEST_STORE_PATH, JSON.stringify(data, null, 2));
}

/** Read test data from the task store file */
async function readStore(): Promise<Record<string, unknown>> {
  const content = await fs.readFile(TEST_STORE_PATH, "utf-8");
  return JSON.parse(content);
}

// ── Basic removal ────────────────────────────────────────────────────────────

describe("removeTaskFromStore", () => {
  it("should remove a task from a flat array section", async () => {
    await writeStore({
      linear: [
        { taskId: "task-1", title: "Keep me" },
        { taskId: "task-2", title: "Remove me" },
      ],
      metadata: { fetched_at: "2026-02-11" },
    });

    await removeTaskFromStore("task-2", TEST_STORE_PATH);

    const data = await readStore();
    expect(data.linear).toEqual([{ taskId: "task-1", title: "Keep me" }]);
  });

  it("should remove a task from a nested object section (github.prs)", async () => {
    await writeStore({
      github: {
        prs: [
          { taskId: "pr-1", title: "Keep" },
          { taskId: "pr-2", title: "Remove" },
        ],
        issues: [{ taskId: "issue-1", title: "Keep" }],
      },
      metadata: { fetched_at: "2026-02-11" },
    });

    await removeTaskFromStore("pr-2", TEST_STORE_PATH);

    const data = await readStore();
    const github = data.github as { prs: unknown[]; issues: unknown[] };
    expect(github.prs).toEqual([{ taskId: "pr-1", title: "Keep" }]);
    expect(github.issues).toEqual([{ taskId: "issue-1", title: "Keep" }]);
  });

  it("should skip the metadata key", async () => {
    await writeStore({
      linear: [{ taskId: "task-1" }],
      metadata: { fetched_at: "2026-02-11", date: "2026-02-11" },
    });

    await removeTaskFromStore("task-1", TEST_STORE_PATH);

    const data = await readStore();
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
    await writeStore(original);

    await removeTaskFromStore("nonexistent", TEST_STORE_PATH);

    const data = await readStore();
    expect(data).toEqual(original);
  });

  it("should not write the file when nothing was removed", async () => {
    await writeStore({
      linear: [{ taskId: "task-1" }],
    });

    const statBefore = await fs.stat(TEST_STORE_PATH);

    // Small delay to ensure mtime would differ if file were written
    await new Promise((r) => setTimeout(r, 50));

    await removeTaskFromStore("nonexistent", TEST_STORE_PATH);

    const statAfter = await fs.stat(TEST_STORE_PATH);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("should remove a task that appears in multiple sections", async () => {
    // Unusual but possible if taskId is shared across sources
    await writeStore({
      linear: [{ taskId: "shared-id", title: "Linear" }],
      slack: [{ taskId: "shared-id", text: "Slack" }],
    });

    await removeTaskFromStore("shared-id", TEST_STORE_PATH);

    const data = await readStore();
    expect(data.linear).toEqual([]);
    expect(data.slack).toEqual([]);
  });
});

// ── Error handling ───────────────────────────────────────────────────────────

describe("Error handling", () => {
  it("should silently handle missing store file", async () => {
    // File doesn't exist — should not throw
    await expect(
      removeTaskFromStore("task-1", "/tmp/nonexistent-store-file.json")
    ).resolves.not.toThrow();
  });

  it("should silently handle malformed JSON", async () => {
    await fs.writeFile(TEST_STORE_PATH, "not valid json{{{");

    await expect(removeTaskFromStore("task-1", TEST_STORE_PATH)).resolves.not.toThrow();
  });
});

// ── Concurrent writes (serialized by the module's async-lock) ────────────────

describe("Concurrent writes", () => {
  it("agent full-refresh and dashboard eviction don't lose each other's writes", async () => {
    // Seed initial state — two old tasks.
    await writeStore({
      linear: [
        { taskId: "old-1", title: "Old" },
        { taskId: "old-2", title: "Old" },
      ],
    });

    // Fire concurrently:
    //   - Agent does a full refresh (writeTaskStore replaces the file).
    //   - Dashboard removes an old task (removeTaskFromStore RMW).
    // With the lock, either ordering is valid; the agent's fresh write must
    // never be silently overwritten by a stale-read removal.
    await Promise.all([
      writeTaskStore({ linear: [{ taskId: "new-1", title: "Fresh" }] }, TEST_STORE_PATH),
      removeTaskFromStore("old-1", TEST_STORE_PATH),
    ]);

    const data = await readStore();
    const linear = data.linear as Array<{ taskId: string }>;
    // Whichever order the lock granted, the final state must be the agent's data
    // (if dashboard went first, agent overwrote; if agent went first, dashboard
    // tried to remove a now-absent "old-1" and no-op'd).
    expect(linear).toEqual([{ taskId: "new-1", title: "Fresh" }]);
  });

  it("concurrent removeTaskFromStore on different ids both persist", async () => {
    await writeStore({
      linear: [
        { taskId: "task-1", title: "One" },
        { taskId: "task-2", title: "Two" },
        { taskId: "task-3", title: "Three" },
      ],
    });

    await Promise.all([
      removeTaskFromStore("task-1", TEST_STORE_PATH),
      removeTaskFromStore("task-2", TEST_STORE_PATH),
    ]);

    const data = await readStore();
    expect(data.linear).toEqual([{ taskId: "task-3", title: "Three" }]);
  });

  it("concurrent mutateTaskStore mutations both persist", async () => {
    await writeStore({ linear: [{ taskId: "task-1", flag: false }] });

    await Promise.all([
      mutateTaskStore((d) => {
        const arr = d.linear as Array<{ taskId: string; flag?: boolean; mutA?: boolean }>;
        arr[0].mutA = true;
        return true;
      }, TEST_STORE_PATH),
      mutateTaskStore((d) => {
        const arr = d.linear as Array<{ taskId: string; flag?: boolean; mutB?: boolean }>;
        arr[0].mutB = true;
        return true;
      }, TEST_STORE_PATH),
    ]);

    const data = await readStore();
    const task = (data.linear as Array<{ mutA?: boolean; mutB?: boolean }>)[0];
    expect(task.mutA).toBe(true);
    expect(task.mutB).toBe(true);
  });
});
