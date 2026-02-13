import fs from "node:fs/promises";
import path from "node:path";
import { categorizeScore, type PriorityMetadata } from "../tools/today-todos/priority-utils";

/**
 * A single priority override for a task.
 * Keyed by the task's stableId in the overrides map.
 */
export interface PriorityOverride {
  overrideScore: number; // The user-requested score (0-300)
  originalScore: number; // The automated score at time of override
  reason: string; // Why the override was applied
  appliedAt: string; // ISO 8601 timestamp
  lastSeenAt: string; // Updated each fetch cycle (for pruning)
}

export interface PriorityOverridesData {
  overrides: Record<string, PriorityOverride>; // key = stableId
  lastPruned?: string; // ISO 8601 timestamp
}

const OVERRIDES_FILE_PATH =
  process.env.OVERRIDES_FILE_PATH || path.join(process.cwd(), "data", "priority-overrides.json");

const PRUNE_DAYS = 30;
const PRUNE_INTERVAL_HOURS = 24;

// ── File I/O ────────────────────────────────────────────────────────

async function ensureDataDir(): Promise<void> {
  const dir = path.dirname(OVERRIDES_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read overrides file from disk.
 * Automatically prunes stale overrides if needed.
 */
export async function readOverrides(): Promise<PriorityOverridesData> {
  try {
    const content = await fs.readFile(OVERRIDES_FILE_PATH, "utf-8");
    const data: PriorityOverridesData = JSON.parse(content);

    if (shouldPrune(data)) {
      return await pruneAndSave(data);
    }

    return data;
  } catch {
    return { overrides: {} };
  }
}

async function writeOverrides(data: PriorityOverridesData): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(OVERRIDES_FILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Pruning ─────────────────────────────────────────────────────────

function shouldPrune(data: PriorityOverridesData): boolean {
  if (!data.lastPruned) return true;
  const hoursSince = (Date.now() - new Date(data.lastPruned).getTime()) / (1000 * 60 * 60);
  return hoursSince >= PRUNE_INTERVAL_HOURS;
}

function pruneOldOverrides(
  data: PriorityOverridesData,
  daysBack: number = PRUNE_DAYS
): PriorityOverridesData {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const pruned: PriorityOverridesData = {
    overrides: {},
    lastPruned: new Date().toISOString(),
  };

  for (const [key, override] of Object.entries(data.overrides)) {
    if (new Date(override.lastSeenAt) >= cutoff) {
      pruned.overrides[key] = override;
    }
  }

  return pruned;
}

async function pruneAndSave(data: PriorityOverridesData): Promise<PriorityOverridesData> {
  const pruned = pruneOldOverrides(data);
  await writeOverrides(pruned);
  return pruned;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Set or update a priority override for a task.
 */
export async function setOverride(stableId: string, override: PriorityOverride): Promise<void> {
  const data = await readOverrides();
  data.overrides[stableId] = override;
  await writeOverrides(data);
}

/**
 * Remove a priority override for a task, restoring automatic scoring.
 */
export async function removeOverride(stableId: string): Promise<void> {
  const data = await readOverrides();
  delete data.overrides[stableId];
  await writeOverrides(data);
}

// ── Apply overrides to enriched tasks ───────────────────────────────

/**
 * Loose shape for tasks that can receive overrides.
 * Matches any enriched type that has stableId + priorityMetadata.
 */
interface OverridableTask {
  stableId: string;
  priorityMetadata?: PriorityMetadata;
}

/**
 * Apply stored priority overrides to enriched task arrays.
 * Mutates tasks in place (same pattern as filterCompletedTasks).
 *
 * For each task whose stableId has a stored override:
 * - Saves the original score in priorityMetadata.override
 * - Replaces score and category with override values
 * - Updates lastSeenAt on the override for pruning
 *
 * Writes updated lastSeenAt timestamps back to the store.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: iterates nested task arrays to apply overrides
export async function applyOverridesToTasks(...taskArrays: OverridableTask[][]): Promise<void> {
  const data = await readOverrides();
  const overrides = data.overrides;

  if (Object.keys(overrides).length === 0) return;

  const seenIds: string[] = [];

  for (const tasks of taskArrays) {
    for (const task of tasks) {
      if (!task.stableId || !task.priorityMetadata) continue;

      const override = overrides[task.stableId];
      if (!override) continue;

      // Preserve original score before overriding
      task.priorityMetadata.override = {
        originalScore: task.priorityMetadata.score,
        reason: override.reason,
        appliedAt: override.appliedAt,
      };

      // Apply the override
      task.priorityMetadata.score = override.overrideScore;
      task.priorityMetadata.category = categorizeScore(override.overrideScore);
      task.priorityMetadata.reasons.push(`Priority override: ${override.reason}`);

      seenIds.push(task.stableId);
    }
  }

  // Batch-update lastSeenAt for overrides we encountered
  if (seenIds.length > 0) {
    const now = new Date().toISOString();
    for (const id of seenIds) {
      if (overrides[id]) {
        overrides[id].lastSeenAt = now;
      }
    }
    await writeOverrides(data);
  }
}

/**
 * Manually trigger pruning (for testing).
 * Delegates to pruneOldOverrides to avoid duplicating the filtering logic.
 */
export async function forcePrune(daysBack: number = PRUNE_DAYS): Promise<number> {
  const data = await readOverrides();
  const beforeCount = Object.keys(data.overrides).length;
  const pruned = pruneOldOverrides(data, daysBack);
  await writeOverrides(pruned);
  return beforeCount - Object.keys(pruned.overrides).length;
}
