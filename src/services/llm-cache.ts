import fs from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../observability/logger";

/**
 * Cached extraction result for a single meeting note document.
 * Stores the combined regex + LLM items so the entire extraction
 * pipeline can be skipped on cache hit.
 */
export interface CachedExtractionResult {
  items: CachedActionItem[];
  cachedAt: string; // ISO 8601 timestamp
}

/**
 * Shape of an extracted action item in the cache.
 * Matches the ExtractedActionItem interface in granola-utils.ts.
 */
export interface CachedActionItem {
  text: string;
  assignee?: string;
  isUrgent: boolean;
}

/**
 * In-memory representation of the cache file.
 * Callers use loadCache/saveCache for a read-once/write-once session
 * to avoid race conditions and redundant file I/O.
 */
export interface ExtractionCacheData {
  /** Map of documentId → extraction result */
  entries: Record<string, CachedExtractionResult>;
}

const CACHE_FILE_PATH =
  process.env.LLM_CACHE_FILE_PATH ||
  path.join(process.cwd(), "data", "llm-extraction-cache.json");

/**
 * Ensure the data directory exists
 */
async function ensureDataDir(): Promise<void> {
  const dir = path.dirname(CACHE_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Load the full cache from disk into memory.
 * Returns an empty cache if the file doesn't exist or is invalid.
 * Call this once at the start of a fetch cycle, then operate on the
 * returned object in-memory to avoid race conditions.
 */
export async function loadCache(): Promise<ExtractionCacheData> {
  try {
    const content = await fs.readFile(CACHE_FILE_PATH, "utf-8");
    return JSON.parse(content) as ExtractionCacheData;
  } catch {
    return { entries: {} };
  }
}

/**
 * Persist the in-memory cache to disk.
 * Call this once at the end of a fetch cycle after all entries
 * have been read/written in-memory.
 */
export async function saveCache(data: ExtractionCacheData): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
}

/**
 * Look up cached extraction results for a document.
 * Operates on the in-memory cache object (no file I/O).
 */
export function getCachedItems(
  cache: ExtractionCacheData,
  documentId: string
): CachedActionItem[] | null {
  const entry = cache.entries[documentId];
  if (!entry) return null;
  return entry.items;
}

/**
 * Store extraction results in the in-memory cache.
 * Does NOT write to disk — call saveCache() when done.
 */
export function setCachedItems(
  cache: ExtractionCacheData,
  documentId: string,
  items: CachedActionItem[]
): void {
  cache.entries[documentId] = {
    items,
    cachedAt: new Date().toISOString(),
  };
}

/**
 * Remove cache entries for documents no longer in the eligible set.
 * Operates in-memory — call saveCache() to persist.
 * Returns the number of entries removed.
 */
export function pruneCacheEntries(
  cache: ExtractionCacheData,
  eligibleDocIds: Set<string>
): number {
  const logger = getLogger().withOperation("llm_cache_prune");
  const beforeCount = Object.keys(cache.entries).length;

  for (const docId of Object.keys(cache.entries)) {
    if (!eligibleDocIds.has(docId)) {
      delete cache.entries[docId];
    }
  }

  const pruned = beforeCount - Object.keys(cache.entries).length;

  if (pruned > 0) {
    logger.info(`Pruned ${pruned} stale cache entries`);
  }

  return pruned;
}
