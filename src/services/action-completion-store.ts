import fs from "node:fs/promises";
import path from "node:path";
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

const COMPLETIONS_FILE_PATH = process.env.COMPLETIONS_FILE_PATH
  || path.join(process.cwd(), "data", "completed-actions.json");

const PRUNE_DAYS = 30; // Delete completions older than 30 days
const PRUNE_INTERVAL_HOURS = 24; // Only prune once per 24 hours

/**
 * Ensure data directory exists
 */
async function ensureDataDir(): Promise<void> {
  const dir = path.dirname(COMPLETIONS_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read completions file from disk
 * Automatically prunes old completions if needed
 */
async function readCompletionsFile(): Promise<CompletedActionsData> {
  try {
    const content = await fs.readFile(COMPLETIONS_FILE_PATH, "utf-8");
    const data: CompletedActionsData = JSON.parse(content);

    // Auto-prune if needed
    if (shouldPrune(data)) {
      return await pruneAndSave(data);
    }

    return data;
  } catch {
    // File doesn't exist or is invalid - return empty
    return { completions: {} };
  }
}

/**
 * Write completions file to disk
 */
async function writeCompletionsFile(data: CompletedActionsData): Promise<void> {
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
 * Prune old completions and save to disk
 */
async function pruneAndSave(data: CompletedActionsData): Promise<CompletedActionsData> {
  const pruned = pruneOldCompletions(data, PRUNE_DAYS);
  await writeCompletionsFile(pruned);
  return pruned;
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
  const data = await readCompletionsFile();
  const key = buildKey(source, identifier);

  data.completions[key] = {
    source,
    identifier,
    completedAt: new Date().toISOString(),
    metadata,
  };

  await writeCompletionsFile(data);
}

/**
 * Mark an action as incomplete (remove completion)
 */
export async function markActionIncomplete(
  source: ActionSource,
  identifier: string
): Promise<void> {
  const data = await readCompletionsFile();
  const key = buildKey(source, identifier);

  delete data.completions[key];

  await writeCompletionsFile(data);
}

/**
 * Check if an action is marked as complete
 */
export async function isActionCompleted(
  source: ActionSource,
  identifier: string
): Promise<boolean> {
  const data = await readCompletionsFile();
  const key = buildKey(source, identifier);
  return key in data.completions;
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
  const data = await readCompletionsFile();
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
}

/**
 * Manually trigger pruning (for testing)
 */
export async function forcePrune(daysBack: number = PRUNE_DAYS): Promise<number> {
  const data = await readCompletionsFile();
  const beforeCount = Object.keys(data.completions).length;
  const pruned = pruneOldCompletions(data, daysBack);
  await writeCompletionsFile(pruned);
  const afterCount = Object.keys(pruned.completions).length;
  return beforeCount - afterCount; // Return number of items pruned
}
