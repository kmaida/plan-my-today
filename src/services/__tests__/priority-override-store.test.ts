/**
 * Tests for the priority-override-store — the file-based JSON store
 * that tracks per-task priority overrides applied by the agent.
 *
 * Mirrors the action-completion-store test patterns: isolated test
 * file via OVERRIDES_FILE_PATH env var, same beforeEach reset.
 *
 * KNOWN ISSUE: Same TOCTOU race as the completion store — concurrent
 * writes can lose data. See action-completion-store.test.ts for details.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PriorityMetadata } from "../../tools/today-todos/priority-utils";
import {
  applyOverridesToTasks,
  forcePrune,
  readOverrides,
  removeOverride,
  setOverride,
} from "../priority-override-store";

const OVERRIDES_FILE = path.join(process.cwd(), "data", "test-priority-overrides.json");

beforeEach(async () => {
  await fs.mkdir(path.dirname(OVERRIDES_FILE), { recursive: true });
  await fs.writeFile(
    OVERRIDES_FILE,
    JSON.stringify({ overrides: {}, lastPruned: new Date().toISOString() })
  );
});

// ── setOverride + readOverrides ──────────────────────────────────────

describe("setOverride", () => {
  it("should persist an override and retrieve it via readOverrides", async () => {
    const now = new Date().toISOString();
    await setOverride("linear:KEY-42", {
      overrideScore: 200,
      originalScore: 100,
      reason: "User says this is critical",
      appliedAt: now,
      lastSeenAt: now,
    });

    const data = await readOverrides();
    expect(data.overrides["linear:KEY-42"]).toBeDefined();
    expect(data.overrides["linear:KEY-42"].overrideScore).toBe(200);
    expect(data.overrides["linear:KEY-42"].originalScore).toBe(100);
    expect(data.overrides["linear:KEY-42"].reason).toBe("User says this is critical");
  });

  it("should overwrite an existing override for the same stableId", async () => {
    const now = new Date().toISOString();
    await setOverride("gmail:abc123", {
      overrideScore: 150,
      originalScore: 80,
      reason: "First override",
      appliedAt: now,
      lastSeenAt: now,
    });

    await setOverride("gmail:abc123", {
      overrideScore: 250,
      originalScore: 80,
      reason: "Changed my mind",
      appliedAt: now,
      lastSeenAt: now,
    });

    const data = await readOverrides();
    expect(data.overrides["gmail:abc123"].overrideScore).toBe(250);
    expect(data.overrides["gmail:abc123"].reason).toBe("Changed my mind");
  });

  it("should not affect other overrides when setting a new one", async () => {
    const now = new Date().toISOString();
    await setOverride("linear:KEY-1", {
      overrideScore: 200,
      originalScore: 100,
      reason: "Critical",
      appliedAt: now,
      lastSeenAt: now,
    });

    await setOverride("slack:C012:123.456", {
      overrideScore: 40,
      originalScore: 120,
      reason: "Deprioritize",
      appliedAt: now,
      lastSeenAt: now,
    });

    const data = await readOverrides();
    expect(Object.keys(data.overrides)).toHaveLength(2);
    expect(data.overrides["linear:KEY-1"].overrideScore).toBe(200);
    expect(data.overrides["slack:C012:123.456"].overrideScore).toBe(40);
  });
});

// ── removeOverride ──────────────────────────────────────────────────

describe("removeOverride", () => {
  it("should remove a previously set override", async () => {
    const now = new Date().toISOString();
    await setOverride("linear:KEY-42", {
      overrideScore: 200,
      originalScore: 100,
      reason: "Boost",
      appliedAt: now,
      lastSeenAt: now,
    });

    await removeOverride("linear:KEY-42");

    const data = await readOverrides();
    expect(data.overrides["linear:KEY-42"]).toBeUndefined();
  });

  it("should be a no-op when the override doesn't exist", async () => {
    await expect(removeOverride("nonexistent")).resolves.not.toThrow();
  });

  it("should not affect other overrides", async () => {
    const now = new Date().toISOString();
    await setOverride("linear:KEY-1", {
      overrideScore: 200,
      originalScore: 100,
      reason: "A",
      appliedAt: now,
      lastSeenAt: now,
    });
    await setOverride("linear:KEY-2", {
      overrideScore: 150,
      originalScore: 90,
      reason: "B",
      appliedAt: now,
      lastSeenAt: now,
    });

    await removeOverride("linear:KEY-1");

    const data = await readOverrides();
    expect(data.overrides["linear:KEY-1"]).toBeUndefined();
    expect(data.overrides["linear:KEY-2"]).toBeDefined();
  });
});

// ── applyOverridesToTasks ───────────────────────────────────────────

describe("applyOverridesToTasks", () => {
  it("should mutate matching tasks with override scores", async () => {
    const now = new Date().toISOString();
    await setOverride("linear:KEY-42", {
      overrideScore: 250,
      originalScore: 100,
      reason: "Top priority",
      appliedAt: now,
      lastSeenAt: now,
    });

    const tasks: Array<{ stableId: string; priorityMetadata: PriorityMetadata }> = [
      {
        stableId: "linear:KEY-42",
        priorityMetadata: {
          score: 100,
          category: "medium",
          signals: {},
          reasons: ["Has due date"],
        },
      },
      {
        stableId: "linear:KEY-99",
        priorityMetadata: {
          score: 150,
          category: "high",
          signals: {},
          reasons: ["Urgent label"],
        },
      },
    ];

    await applyOverridesToTasks(tasks);

    // Overridden task
    expect(tasks[0].priorityMetadata.score).toBe(250);
    expect(tasks[0].priorityMetadata.category).toBe("critical");
    expect(tasks[0].priorityMetadata.override).toEqual({
      originalScore: 100,
      reason: "Top priority",
      appliedAt: now,
    });
    expect(tasks[0].priorityMetadata.reasons).toContain("Priority override: Top priority");

    // Non-overridden task should be unchanged
    expect(tasks[1].priorityMetadata.score).toBe(150);
    expect(tasks[1].priorityMetadata.override).toBeUndefined();
  });

  it("should handle multiple task arrays (spread args)", async () => {
    const now = new Date().toISOString();
    await setOverride("gmail:abc", {
      overrideScore: 40,
      originalScore: 120,
      reason: "Deprioritize",
      appliedAt: now,
      lastSeenAt: now,
    });

    const array1 = [
      {
        stableId: "linear:KEY-1",
        priorityMetadata: { score: 100, category: "medium" as const, signals: {}, reasons: [] },
      },
    ];
    const array2 = [
      {
        stableId: "gmail:abc",
        priorityMetadata: { score: 120, category: "medium" as const, signals: {}, reasons: [] },
      },
    ];

    await applyOverridesToTasks(array1, array2);

    // Only the gmail task should be affected
    expect(array1[0].priorityMetadata.score).toBe(100);
    expect(array2[0].priorityMetadata.score).toBe(40);
    expect(array2[0].priorityMetadata.category).toBe("low");
  });

  it("should skip tasks without stableId or priorityMetadata", async () => {
    const now = new Date().toISOString();
    await setOverride("linear:KEY-1", {
      overrideScore: 200,
      originalScore: 100,
      reason: "Boost",
      appliedAt: now,
      lastSeenAt: now,
    });

    const tasks = [
      {
        stableId: "",
        priorityMetadata: { score: 100, category: "medium" as const, signals: {}, reasons: [] },
      },
      { stableId: "linear:KEY-1", priorityMetadata: undefined },
    ];

    // Should not throw
    await expect(applyOverridesToTasks(tasks)).resolves.not.toThrow();
  });

  it("should be a no-op when no overrides exist", async () => {
    const tasks = [
      {
        stableId: "linear:KEY-1",
        priorityMetadata: { score: 100, category: "medium" as const, signals: {}, reasons: [] },
      },
    ];

    await applyOverridesToTasks(tasks);

    expect(tasks[0].priorityMetadata.score).toBe(100);
  });

  it("should update lastSeenAt on matched overrides", async () => {
    const oldDate = "2024-01-01T00:00:00.000Z";
    await setOverride("linear:KEY-42", {
      overrideScore: 200,
      originalScore: 100,
      reason: "Boost",
      appliedAt: oldDate,
      lastSeenAt: oldDate,
    });

    const tasks = [
      {
        stableId: "linear:KEY-42",
        priorityMetadata: { score: 100, category: "medium" as const, signals: {}, reasons: [] },
      },
    ];

    await applyOverridesToTasks(tasks);

    const data = await readOverrides();
    const lastSeen = new Date(data.overrides["linear:KEY-42"].lastSeenAt);
    expect(lastSeen.getTime()).toBeGreaterThan(new Date(oldDate).getTime());
  });
});

// ── Pruning ─────────────────────────────────────────────────────────

describe("forcePrune", () => {
  it("should remove overrides older than the specified days", async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 45);
    const data = {
      overrides: {
        "linear:old": {
          overrideScore: 200,
          originalScore: 100,
          reason: "Old override",
          appliedAt: oldDate.toISOString(),
          lastSeenAt: oldDate.toISOString(),
        },
        "linear:recent": {
          overrideScore: 150,
          originalScore: 90,
          reason: "Recent override",
          appliedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      },
      lastPruned: new Date().toISOString(),
    };
    await fs.writeFile(OVERRIDES_FILE, JSON.stringify(data));

    const pruned = await forcePrune(30);

    expect(pruned).toBe(1);
    const result = await readOverrides();
    expect(result.overrides["linear:old"]).toBeUndefined();
    expect(result.overrides["linear:recent"]).toBeDefined();
  });

  it("should return 0 when nothing needs pruning", async () => {
    const now = new Date().toISOString();
    await setOverride("linear:KEY-1", {
      overrideScore: 200,
      originalScore: 100,
      reason: "Fresh",
      appliedAt: now,
      lastSeenAt: now,
    });

    const pruned = await forcePrune(30);
    expect(pruned).toBe(0);
  });
});

// ── File error handling ─────────────────────────────────────────────

describe("File error handling", () => {
  it("should return empty data when overrides file is missing", async () => {
    await fs.unlink(OVERRIDES_FILE).catch(() => {});

    const data = await readOverrides();
    expect(data.overrides).toEqual({});
  });

  it("should return empty data when overrides file has invalid JSON", async () => {
    await fs.writeFile(OVERRIDES_FILE, "not valid json{{{");

    const data = await readOverrides();
    expect(data.overrides).toEqual({});
  });

  it("should recover by writing a valid file after reading corrupt data", async () => {
    await fs.writeFile(OVERRIDES_FILE, "corrupt");

    const now = new Date().toISOString();
    await setOverride("linear:KEY-1", {
      overrideScore: 200,
      originalScore: 100,
      reason: "After recovery",
      appliedAt: now,
      lastSeenAt: now,
    });

    const data = await readOverrides();
    expect(data.overrides["linear:KEY-1"]).toBeDefined();
    expect(data.overrides["linear:KEY-1"].overrideScore).toBe(200);
  });
});
