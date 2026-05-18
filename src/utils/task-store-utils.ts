import fs from "node:fs/promises";
import path from "node:path";
import AsyncLock from "async-lock";
import { PATHS } from "../constants";

const TASK_STORE_PATH = path.join(process.cwd(), PATHS.TASK_STORE);

// Module-scoped lock — serializes every write/RMW touching the task store.
// Independent from the completion-store lock: different file, no causal coupling.
// Reads are intentionally NOT locked — unlike the completion store, this file
// is not auto-pruned on read, so reads can't trigger writes.
const lock = new AsyncLock();
const LOCK_KEY = "task-store";

/**
 * Write the full task store, serialized via the module lock.
 * Replaces any prior content. Use for full-refresh writes (e.g. from
 * `list-all-tasks-today`). For partial mutations, prefer `mutateTaskStore`.
 *
 * @param data - The full task store payload to persist
 * @param storePath - Override path (tests only)
 */
export async function writeTaskStore(
  data: unknown,
  storePath: string = TASK_STORE_PATH
): Promise<void> {
  await lock.acquire(LOCK_KEY, async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(data, null, 2));
  });
}

/**
 * Read-modify-write the task store under the module lock. The mutator
 * receives the parsed JSON and should return `true` if it changed anything
 * (so we only write when needed) or `false` to skip the write.
 *
 * Non-fatal on errors — silently swallows read failures (returns without
 * writing). Matches the prior behavior of `removeTaskFromStore`.
 *
 * @param mutator - Function that mutates `data` in place and returns whether to persist
 * @param storePath - Override path (tests only)
 */
export async function mutateTaskStore(
  mutator: (data: Record<string, unknown>) => boolean | Promise<boolean>,
  storePath: string = TASK_STORE_PATH
): Promise<void> {
  await lock.acquire(LOCK_KEY, async () => {
    try {
      const raw = await fs.readFile(storePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const shouldWrite = await mutator(data);
      if (shouldWrite) {
        await fs.writeFile(storePath, JSON.stringify(data, null, 2));
      }
    } catch {
      // Non-fatal — callers (dismiss, priority override) treat the store
      // as a cache and have other sources of truth.
    }
  });
}

/**
 * Remove a completed task from the task store JSON file by taskId.
 * Searches both flat arrays (e.g., `linear: [...]`) and nested objects
 * (e.g., `github: { prs: [...], issues: [...] }`). Skips the `metadata` key.
 *
 * Non-fatal on errors — the UI still works via optimistic removal.
 *
 * @param taskId - The taskId to remove from the task store
 * @param storePath - Path to the JSON file (defaults to data/latest-tasks.json)
 */
export async function removeTaskFromStore(
  taskId: string,
  storePath: string = TASK_STORE_PATH
): Promise<void> {
  await mutateTaskStore((data) => {
    let removed = false;

    for (const key of Object.keys(data)) {
      if (key === "metadata") continue;
      const section = data[key];

      if (Array.isArray(section)) {
        const before = section.length;
        const filtered = section.filter((item: { taskId?: string }) => item.taskId !== taskId);
        if (filtered.length < before) {
          data[key] = filtered;
          removed = true;
        }
      } else if (section && typeof section === "object") {
        // Nested objects like github: { prs: [], issues: [] }
        const nested = section as Record<string, unknown>;
        for (const subKey of Object.keys(nested)) {
          const sub = nested[subKey];
          if (Array.isArray(sub)) {
            const before = sub.length;
            const filtered = sub.filter((item: { taskId?: string }) => item.taskId !== taskId);
            if (filtered.length < before) {
              nested[subKey] = filtered;
              removed = true;
            }
          }
        }
      }
    }

    return removed;
  }, storePath);
}
