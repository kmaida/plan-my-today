/**
 * Tests for enrichRelations — merges API-sourced Linear relations into
 * dependencyMetadata (blocking) and crossReferenceMetadata (all relations).
 */

import { enrichRelations } from "../relation-utils";
import type { EnrichedLinearIssue, LinearRelatedIssueRef } from "../types";

// ── Helpers ──

/** Minimal ref for a related issue */
function makeRef(identifier: string, title = `Title for ${identifier}`): LinearRelatedIssueRef {
  return {
    identifier,
    title,
    url: `https://linear.app/team/issue/${identifier}`,
    state: { name: "In Progress", type: "started" },
  };
}

/** Builds a minimal EnrichedLinearIssue for testing */
function makeIssue(
  identifier: string,
  overrides: Partial<EnrichedLinearIssue> = {}
): EnrichedLinearIssue {
  return {
    identifier,
    title: `Test issue ${identifier}`,
    priority: 3,
    priorityLabel: "Medium",
    url: `https://linear.app/team/issue/${identifier}`,
    state: { name: "In Progress", type: "started" },
    dueDate: null,
    estimate: null,
    project: null,
    taskId: `task-${identifier}`,
    stableId: `linear:${identifier}`,
    priorityMetadata: {
      score: 70,
      category: "medium",
      signals: {},
      reasons: ["Test"],
    },
    ...overrides,
  } as EnrichedLinearIssue;
}

// ── Blocking relation merge ──

describe("blocking relation merge into dependencyMetadata", () => {
  it("should add API 'blocks' to dependencyMetadata.blocks", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "blocks", relatedIssue: makeRef("KIM-2") }],
        },
      }),
      makeIssue("KIM-2"),
    ];

    enrichRelations(issues);

    expect(issues[0].dependencyMetadata?.blocks).toContain("KIM-2");
  });

  it("should dedup with title-parsed blocks", () => {
    const issues = [
      makeIssue("KIM-1", {
        dependencyMetadata: {
          blockedBy: [],
          blocks: ["KIM-2"], // Already from title parsing
          waitingOn: [],
          blockedByExternal: false,
        },
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "blocks", relatedIssue: makeRef("KIM-2") }],
        },
      }),
    ];

    enrichRelations(issues);

    // Should not duplicate KIM-2
    expect(issues[0].dependencyMetadata!.blocks).toEqual(["KIM-2"]);
  });

  it("should add inverse blocking to target's blockedBy", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "blocks", relatedIssue: makeRef("KIM-2") }],
        },
      }),
      makeIssue("KIM-2"),
    ];

    enrichRelations(issues);

    expect(issues[1].dependencyMetadata?.blockedBy).toContain("KIM-1");
  });

  it("should dedup inverse blocking with title-parsed blockedBy", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "blocks", relatedIssue: makeRef("KIM-2") }],
        },
      }),
      makeIssue("KIM-2", {
        dependencyMetadata: {
          blockedBy: ["KIM-1"], // Already from title parsing
          blocks: [],
          waitingOn: [],
          blockedByExternal: false,
        },
      }),
    ];

    enrichRelations(issues);

    expect(issues[1].dependencyMetadata!.blockedBy).toEqual(["KIM-1"]);
  });

  it("should not add inverse for issues not in the fetched set", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "blocks", relatedIssue: makeRef("KIM-999") }],
        },
      }),
    ];

    enrichRelations(issues);

    // KIM-1 should have blocks, but KIM-999 is not in the array
    expect(issues[0].dependencyMetadata?.blocks).toContain("KIM-999");
    // No crash — graceful skip
  });

  it("should create dependencyMetadata if missing on target", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "blocks", relatedIssue: makeRef("KIM-2") }],
        },
      }),
      makeIssue("KIM-2"), // No dependencyMetadata yet
    ];

    enrichRelations(issues);

    expect(issues[1].dependencyMetadata).toBeDefined();
    expect(issues[1].dependencyMetadata!.blockedBy).toContain("KIM-1");
  });
});

// ── Cross-reference injection ──

describe("cross-reference injection", () => {
  it("should inject parent into relatedItems", () => {
    const parent = makeRef("KIM-0");
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: { parent, children: [], relations: [] },
      }),
    ];

    enrichRelations(issues);

    const items = issues[0].crossReferenceMetadata?.relatedItems ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("linear");
    expect(items[0].id).toBe("KIM-0");
    expect(items[0].snippet).toBe("Parent: Title for KIM-0");
    expect(items[0].url).toBe(parent.url);
  });

  it("should inject children as sub-issues", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [makeRef("KIM-10"), makeRef("KIM-11")],
          relations: [],
        },
      }),
    ];

    enrichRelations(issues);

    const items = issues[0].crossReferenceMetadata?.relatedItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].snippet).toBe("Sub-issue: Title for KIM-10");
    expect(items[1].snippet).toBe("Sub-issue: Title for KIM-11");
  });

  it("should inject blocking relations with 'Blocks' label", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "blocks", relatedIssue: makeRef("KIM-5") }],
        },
      }),
    ];

    enrichRelations(issues);

    const items = issues[0].crossReferenceMetadata?.relatedItems ?? [];
    const blockItem = items.find((i) => i.id === "KIM-5");
    expect(blockItem?.snippet).toBe("Blocks: Title for KIM-5");
  });

  it("should inject duplicate relations with 'Duplicate of' label", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "duplicate", relatedIssue: makeRef("KIM-3") }],
        },
      }),
    ];

    enrichRelations(issues);

    const items = issues[0].crossReferenceMetadata?.relatedItems ?? [];
    expect(items[0].snippet).toBe("Duplicate of: Title for KIM-3");
  });

  it("should inject related relations with 'Related' label", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: null,
          children: [],
          relations: [{ type: "related", relatedIssue: makeRef("KIM-7") }],
        },
      }),
    ];

    enrichRelations(issues);

    const items = issues[0].crossReferenceMetadata?.relatedItems ?? [];
    expect(items[0].snippet).toBe("Related: Title for KIM-7");
  });

  it("should add 'linear' to mentionedIn", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: makeRef("KIM-0"),
          children: [],
          relations: [],
        },
      }),
    ];

    enrichRelations(issues);

    expect(issues[0].crossReferenceMetadata?.mentionedIn).toContain("linear");
  });

  it("should not duplicate 'linear' in mentionedIn", () => {
    const issues = [
      makeIssue("KIM-1", {
        crossReferenceMetadata: {
          mentionedIn: ["linear"], // Already there
          relatedItems: [],
          totalMentions: 0,
        },
        relationMetadata: {
          parent: makeRef("KIM-0"),
          children: [],
          relations: [],
        },
      }),
    ];

    enrichRelations(issues);

    const mentions = issues[0].crossReferenceMetadata!.mentionedIn;
    expect(mentions.filter((m) => m === "linear")).toHaveLength(1);
  });

  it("should append to existing cross-reference items from other sources", () => {
    const existingItem = {
      source: "gmail",
      id: "msg-123",
      snippet: "Re: KIM-1 follow up",
      url: "https://mail.google.com/...",
    };

    const issues = [
      makeIssue("KIM-1", {
        crossReferenceMetadata: {
          mentionedIn: ["gmail"],
          relatedItems: [existingItem],
          totalMentions: 1,
        },
        relationMetadata: {
          parent: makeRef("KIM-0"),
          children: [],
          relations: [],
        },
      }),
    ];

    enrichRelations(issues);

    const items = issues[0].crossReferenceMetadata!.relatedItems;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(existingItem); // Existing preserved
    expect(items[1].source).toBe("linear"); // New appended
    expect(issues[0].crossReferenceMetadata!.totalMentions).toBe(2);
    expect(issues[0].crossReferenceMetadata!.mentionedIn).toContain("gmail");
    expect(issues[0].crossReferenceMetadata!.mentionedIn).toContain("linear");
  });

  it("should update totalMentions correctly", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: {
          parent: makeRef("KIM-0"),
          children: [makeRef("KIM-10")],
          relations: [{ type: "related", relatedIssue: makeRef("KIM-7") }],
        },
      }),
    ];

    enrichRelations(issues);

    expect(issues[0].crossReferenceMetadata?.totalMentions).toBe(3);
  });
});

// ── No-op cases ──

describe("no-op and graceful handling", () => {
  it("should no-op when relationMetadata is undefined", () => {
    const issues = [makeIssue("KIM-1")];

    enrichRelations(issues);

    expect(issues[0].dependencyMetadata).toBeUndefined();
    expect(issues[0].crossReferenceMetadata).toBeUndefined();
  });

  it("should no-op when relations are all empty", () => {
    const issues = [
      makeIssue("KIM-1", {
        relationMetadata: { parent: null, children: [], relations: [] },
      }),
    ];

    enrichRelations(issues);

    // No crossReferenceMetadata created since there are no items to inject
    expect(issues[0].crossReferenceMetadata).toBeUndefined();
  });

  it("should handle empty issues array", () => {
    expect(() => enrichRelations([])).not.toThrow();
  });
});
