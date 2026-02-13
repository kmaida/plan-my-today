import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../constants";

const TASK_STORE_PATH = path.join(process.cwd(), PATHS.TASK_STORE);

/**
 * Remove a completed task from the task store JSON file by taskId.
 * Searches both flat arrays (e.g., `linear: [...]`) and nested objects
 * (e.g., `github: { prs: [...], issues: [...] }`). Skips the `metadata` key.
 *
 * Non-fatal on errors — the UI still works via optimistic removal.
 *
 * KNOWN ISSUE: This does read-modify-write with no file locking.
 * If the agent writes a full refresh of latest-tasks.json at the same
 * time the dashboard evicts a single task, one write can overwrite the other.
 *
 * @param taskId - The taskId to remove from the task store
 * @param storePath - Path to the JSON file (defaults to data/latest-tasks.json)
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reads, mutates, and writes task store JSON
export async function removeTaskFromStore(
  taskId: string,
  storePath: string = TASK_STORE_PATH
): Promise<void> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const data = JSON.parse(raw);
    let removed = false;

    for (const key of Object.keys(data)) {
      if (key === "metadata") continue;
      const section = data[key];

      if (Array.isArray(section)) {
        const before = section.length;
        data[key] = section.filter((item: { taskId?: string }) => item.taskId !== taskId);
        if (data[key].length < before) removed = true;
      } else if (section && typeof section === "object") {
        // Nested objects like github: { prs: [], issues: [] }
        for (const subKey of Object.keys(section)) {
          if (Array.isArray(section[subKey])) {
            const before = section[subKey].length;
            section[subKey] = section[subKey].filter(
              (item: { taskId?: string }) => item.taskId !== taskId
            );
            if (section[subKey].length < before) removed = true;
          }
        }
      }
    }

    if (removed) {
      await fs.writeFile(storePath, JSON.stringify(data, null, 2));
    }
  } catch {
    // Non-fatal — optimistic UI removal still works
  }
}
