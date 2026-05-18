import fs from "node:fs/promises";
import path from "node:path";
import AsyncLock from "async-lock";
import type { ActionSource } from "../utils/action-identifiers";

export interface CompletedAction {
  source: ActionSource;
  identifier: string;
  completedAt: string; // ISO 8601 timestamp
  metadata?: Record<string, unknown>; // Optional contextual info
}

export interface CompletedActionsData {
  completions: Record<string, CompletedAction>; // key = {source}:{identifier}
  lastPruned?: string; // ISO 8601 timestamp
}

const COMPLETIONS_FILE_PATH =
  process.env.COMPLETIONS_FILE_PATH || path.join(process.cwd(), "data", "completed-actions.json");

const PRUNE_DAYS = 30; // Delete completions older than 30 days
const PRUNE_INTERVAL_HOURS = 24; // Only prune once per 24 hours

// Module-scoped lock — serializes all read/write to COMPLETIONS_FILE_PATH.
// `readCompletionsFileUnlocked` can auto-prune (i.e. write), so reads must
// also acquire the lock or two concurrent reads could double-prune.
// AsyncLock does not re-enter on the same key, so every callable that may
// invoke a `*Unlocked` helper MUST already hold the lock — never call a
// public method from inside another public method's lock block.
const lock = new AsyncLock();
const LOCK_KEY = "completions";

/**
 * Ensure data directory exists
 */
async function ensureDataDir(): Promise<void> {
  const dir = path.dirname(COMPLETIONS_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read completions file from disk. Auto-prunes if needed.
 *
 * Caller MUST hold `lock` for LOCK_KEY — the auto-prune path writes to disk.
 */
async function readCompletionsFileUnlocked(): Promise<CompletedActionsData> {
  try {
    const content = await fs.readFile(COMPLETIONS_FILE_PATH, "utf-8");
    const data: CompletedActionsData = JSON.parse(content);

    if (shouldPrune(data)) {
      const pruned = pruneOldCompletions(data, PRUNE_DAYS);
      await writeCompletionsFileUnlocked(pruned);
      return pruned;
    }

    return data;
  } catch {
    // File doesn't exist or is invalid - return empty
    return { completions: {} };
  }
}

/**
 * Write completions file to disk.
 *
 * Caller MUST hold `lock` for LOCK_KEY.
 */
async function writeCompletionsFileUnlocked(data: CompletedActionsData): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(COMPLETIONS_FILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Check if pruning should run
 */
function shouldPrune(data: CompletedActionsData): boolean {
  if (!data.lastPruned) {
    return true; // Never pruned before
  }

  const lastPruned = new Date(data.lastPruned);
  const now = new Date();
  const hoursSinceLastPrune = (now.getTime() - lastPruned.getTime()) / (1000 * 60 * 60);

  return hoursSinceLastPrune >= PRUNE_INTERVAL_HOURS;
}

/**
 * Remove completions older than specified days
 */
function pruneOldCompletions(data: CompletedActionsData, daysBack: number): CompletedActionsData {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  const pruned: CompletedActionsData = {
    completions: {},
    lastPruned: new Date().toISOString(),
  };

  for (const [key, completion] of Object.entries(data.completions)) {
    const completedAt = new Date(completion.completedAt);
    if (completedAt >= cutoffDate) {
      pruned.completions[key] = completion;
    }
  }

  return pruned;
}

/**
 * Build composite key from source and identifier
 */
function buildKey(source: ActionSource, identifier: string): string {
  return `${source}:${identifier}`;
}

/**
 * Mark an action as complete
 */
export async function markActionComplete(
  source: ActionSource,
  identifier: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await lock.acquire(LOCK_KEY, async () => {
    const data = await readCompletionsFileUnlocked();
    const key = buildKey(source, identifier);

    data.completions[key] = {
      source,
      identifier,
      completedAt: new Date().toISOString(),
      metadata,
    };

    await writeCompletionsFileUnlocked(data);
  });
}

/**
 * Mark an action as incomplete (remove completion)
 */
export async function markActionIncomplete(
  source: ActionSource,
  identifier: string
): Promise<void> {
  await lock.acquire(LOCK_KEY, async () => {
    const data = await readCompletionsFileUnlocked();
    const key = buildKey(source, identifier);

    delete data.completions[key];

    await writeCompletionsFileUnlocked(data);
  });
}

/**
 * Check if an action is marked as complete
 */
export async function isActionCompleted(
  source: ActionSource,
  identifier: string
): Promise<boolean> {
  return lock.acquire(LOCK_KEY, async () => {
    const data = await readCompletionsFileUnlocked();
    const key = buildKey(source, identifier);
    return key in data.completions;
  });
}

/**
 * Get all completed identifiers for a given source as a Set.
 * Returns identifier strings (without the source prefix).
 * Useful for bulk filtering without repeated file reads.
 */
export async function getCompletedBySource(source: ActionSource): Promise<Set<string>> {
  const result = await getCompletedBySources([source]);
  return result.get(source) ?? new Set();
}

/**
 * Get completed identifiers for multiple sources in a single file read.
 * Returns a Map from source → Set of identifiers (without the source prefix).
 */
export async function getCompletedBySources(
  sources: readonly ActionSource[]
): Promise<Map<ActionSource, Set<string>>> {
  return lock.acquire(LOCK_KEY, async () => {
    const data = await readCompletionsFileUnlocked();
    const result = new Map<ActionSource, Set<string>>(sources.map((s) => [s, new Set<string>()]));

    for (const key of Object.keys(data.completions)) {
      for (const source of sources) {
        const prefix = `${source}:`;
        if (key.startsWith(prefix)) {
          result.get(source)!.add(key.slice(prefix.length));
          break; // A key can only match one source prefix
        }
      }
    }

    return result;
  });
}

/**
 * Manually trigger pruning (for testing)
 */
export async function forcePrune(daysBack: number = PRUNE_DAYS): Promise<number> {
  return lock.acquire(LOCK_KEY, async () => {
    const data = await readCompletionsFileUnlocked();
    const beforeCount = Object.keys(data.completions).length;
    const pruned = pruneOldCompletions(data, daysBack);
    await writeCompletionsFileUnlocked(pruned);
    const afterCount = Object.keys(pruned.completions).length;
    return beforeCount - afterCount; // Return number of items pruned
  });
}
