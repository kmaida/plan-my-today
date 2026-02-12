import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
import { PATHS } from "../constants";
import { removeOverride, setOverride } from "../services/priority-override-store";
import { categorizeScore } from "../tools/today-todos/priority-utils";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";

const TASKS_CACHE_PATH = path.join(process.cwd(), PATHS.TASKS_CACHE);

/**
 * Map priority category names to midpoint scores.
 * These sit comfortably within each category's range.
 */
const PRIORITY_TO_SCORE: Record<string, number> = {
  critical: 200,
  high: 150,
  medium: 100,
  low: 40,
};

/**
 * Input schema for the set-task-priority tool
 */
const setTaskPriorityInputSchema = {
  stableId: z
    .string()
    .describe(
      "The task's stableId (e.g., 'linear:KEY-123', 'gmail:abc123', 'slack:C012:1234567890.123'). " +
        "Found in the task data returned by list-all-tasks-today or read-dashboard-tasks."
    ),
  priority: z
    .enum(["critical", "high", "medium", "low"])
    .describe(
      "Target priority category. Maps to scores: critical=200, high=150, medium=100, low=40. " +
        "Use 'score' instead for exact positioning (e.g., 300 for absolute top)."
    )
    .optional(),
  score: z
    .number()
    .min(0)
    .max(300)
    .describe(
      "Exact priority score (0-300). Takes precedence over 'priority' if both given. " +
        "Use 300 for absolute top of the list, or specific values for relative ordering."
    )
    .optional(),
  reason: z
    .string()
    .describe(
      "Why this override is being applied (e.g., 'User says this is the top priority today')"
    ),
  clear: z
    .boolean()
    .describe("Set to true to remove the override and restore automatic scoring")
    .optional(),
};

// ── Cache helpers ────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- cache items are untyped JSON */

/** Extract a display title from any cache item, falling back to stableId. */
function getTaskTitle(item: any, fallback: string): string {
  return item.title || item.summary || item.subject || item.text || item.fileTitle || fallback;
}

/**
 * Walk every array in the cache (flat or nested one level) and call `callback`
 * for each item matching `stableId`. Returns the containing array if found.
 *
 * The cache shape is `{ calendar: [...], github: { prs: [...], issues: [...] }, ... }`.
 * This traversal handles both cases without duplication.
 */
function traverseCacheArrays(
  data: Record<string, any>,
  stableId: string,
  callback: (item: any) => void
): any[] | null {
  for (const key of Object.keys(data)) {
    if (key === "metadata") continue;
    const section = data[key];

    if (Array.isArray(section)) {
      for (const item of section) {
        if (item.stableId === stableId) {
          callback(item);
          return section;
        }
      }
    } else if (section && typeof section === "object") {
      for (const subKey of Object.keys(section)) {
        if (Array.isArray(section[subKey])) {
          for (const item of section[subKey]) {
            if (item.stableId === stableId) {
              callback(item);
              return section[subKey];
            }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Mutate a single cache item's priorityMetadata to apply or clear an override.
 * Returns true if the item was actually modified.
 */
function mutateTaskOverride(
  item: any,
  overrideScore: number,
  reason: string,
  appliedAt: string,
  clear: boolean
): boolean {
  if (!item.priorityMetadata) return false;

  if (clear) {
    if (!item.priorityMetadata.override) return false;
    item.priorityMetadata.score = item.priorityMetadata.override.originalScore;
    item.priorityMetadata.category = categorizeScore(item.priorityMetadata.override.originalScore);
    item.priorityMetadata.reasons = item.priorityMetadata.reasons.filter(
      (r: string) => !r.startsWith("Priority override:")
    );
    delete item.priorityMetadata.override;
    return true;
  }

  // Preserve the very first original score (don't overwrite on re-override)
  item.priorityMetadata.override = {
    originalScore: item.priorityMetadata.override?.originalScore ?? item.priorityMetadata.score,
    reason,
    appliedAt,
  };
  item.priorityMetadata.score = overrideScore;
  item.priorityMetadata.category = categorizeScore(overrideScore);
  // Replace any existing override reason, then add the new one
  item.priorityMetadata.reasons = item.priorityMetadata.reasons.filter(
    (r: string) => !r.startsWith("Priority override:")
  );
  item.priorityMetadata.reasons.push(`Priority override: ${reason}`);
  return true;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Cache read/write ─────────────────────────────────────────────────

/**
 * Find a task in the cache by stableId and return its current score + title.
 * Returns null if not found or cache is unreadable.
 */
async function findTaskInCache(stableId: string): Promise<{ score: number; title: string } | null> {
  try {
    const raw = await fs.readFile(TASKS_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw);
    let result: { score: number; title: string } | null = null;

    traverseCacheArrays(data, stableId, (item) => {
      result = {
        score: item.priorityMetadata?.score ?? 0,
        title: getTaskTitle(item, stableId),
      };
    });

    return result;
  } catch {
    return null;
  }
}

/**
 * Update the cache in-place: apply or clear override on matching task, re-sort, write back.
 * Non-fatal on errors — the override store is the source of truth.
 */
async function updateCacheWithOverride(
  stableId: string,
  overrideScore: number,
  reason: string,
  appliedAt: string,
  clear: boolean
): Promise<void> {
  try {
    const raw = await fs.readFile(TASKS_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw);
    let modified = false;

    const containingArray = traverseCacheArrays(data, stableId, (item) => {
      modified = mutateTaskOverride(item, overrideScore, reason, appliedAt, clear);
    });

    if (modified && containingArray) {
      containingArray.sort(
        (
          a: { priorityMetadata?: { score?: number } },
          b: { priorityMetadata?: { score?: number } }
        ) => (b.priorityMetadata?.score ?? 0) - (a.priorityMetadata?.score ?? 0)
      );
      await fs.writeFile(TASKS_CACHE_PATH, JSON.stringify(data, null, 2));
    }
  } catch {
    // Non-fatal — override store is the source of truth
  }
}

// ── Tool registration ────────────────────────────────────────────────

/**
 * Registers the set-task-priority tool with the MCP server.
 *
 * Allows the agent to boost or demote a task's priority score.
 * Overrides persist in data/priority-overrides.json and are applied
 * on every list-all-tasks-today call. The dashboard cache is also
 * updated immediately so the UI reflects changes without a full refetch.
 */
export function registerSetTaskPriorityTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "set-task-priority",
    {
      title: "Set Task Priority",
      description:
        "Boost or demote a specific task's priority. Overrides persist until cleared or auto-pruned (30 days). " +
        "Use 'priority' for category-level changes (critical/high/medium/low) or 'score' for exact positioning " +
        "(0-300, where 300 = absolute top). Use 'clear: true' to remove an override and restore automatic scoring. " +
        "No authentication required — stores overrides locally.",
      inputSchema: setTaskPriorityInputSchema,
    },
    (async (args, _extra) => {
      try {
        const { stableId, reason } = args;
        const shouldClear = args.clear ?? false;

        // Handle clear
        if (shouldClear) {
          await removeOverride(stableId);
          await updateCacheWithOverride(stableId, 0, "", "", true);
          return {
            content: [
              {
                type: "text",
                text: `Priority override removed for ${stableId}. Automatic scoring restored.`,
              },
            ],
          };
        }

        // Resolve target score
        let targetScore: number | undefined = args.score;
        if (targetScore == null && args.priority) {
          targetScore = PRIORITY_TO_SCORE[args.priority];
        }
        if (targetScore == null) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Provide either 'priority' (critical/high/medium/low) or 'score' (0-300).",
              },
            ],
          };
        }

        // Look up current score from cache
        const cached = await findTaskInCache(stableId);
        const originalScore = cached?.score ?? 0;
        const taskTitle = cached?.title ?? stableId;

        const now = new Date().toISOString();

        // Write to override store
        await setOverride(stableId, {
          overrideScore: targetScore,
          originalScore,
          reason,
          appliedAt: now,
          lastSeenAt: now,
        });

        // Update cache so dashboard reflects the change immediately
        await updateCacheWithOverride(stableId, targetScore, reason, now, false);

        const oldCategory = categorizeScore(originalScore);
        const newCategory = categorizeScore(targetScore);

        return {
          content: [
            {
              type: "text",
              text:
                `Priority override set for "${taskTitle}":\n` +
                `  Before: ${originalScore} (${oldCategory})\n` +
                `  After:  ${targetScore} (${newCategory})\n` +
                `  Reason: ${reason}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error setting priority override: ${message}`,
            },
          ],
        };
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof setTaskPriorityInputSchema>
  );
}
