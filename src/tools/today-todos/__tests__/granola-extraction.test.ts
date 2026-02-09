/**
 * Tests for meeting note action item extraction.
 *
 * extractActionItemsFromContent is a pure function: text in, actions out.
 * It uses 5 regex patterns to find action items, plus deduplication and
 * assignee/urgency detection. Subtle regex bugs double-count or miss items.
 */

import { extractActionItemsFromContent } from "../granola-utils";

// ── Pattern 1: Checkboxes ──

describe("checkbox extraction ([ ] items)", () => {
  it("should extract unchecked checkbox items", () => {
    const content = "[ ] Fix the login bug\n[ ] Update the docs";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("Fix the login bug");
    expect(items[1].text).toBe("Update the docs");
  });

  it("should extract dash-prefixed checkboxes", () => {
    const content = "- [ ] Review PR #45\n- [ ] Deploy to staging";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("Review PR #45");
  });

  it("should NOT extract checked checkboxes", () => {
    const content = "[x] Already done\n[ ] Still pending";
    const items = extractActionItemsFromContent(content);
    // [x] doesn't match the \[\s?\] pattern
    expect(items.some((i) => i.text === "Already done")).toBe(false);
    expect(items.some((i) => i.text === "Still pending")).toBe(true);
  });

  it("should handle checkbox with optional space inside brackets", () => {
    const content = "[] No space inside\n[ ] With space inside";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
  });
});

// ── Pattern 2: Action Items section ──

describe("action items section extraction", () => {
  it("should extract bullets under 'Action Items:' header", () => {
    const content = [
      "Discussion notes here...",
      "",
      "Action Items:",
      "- Send the report to management",
      "- Schedule follow-up meeting",
      "",
      "Other notes...",
    ].join("\n");
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("Send the report to management");
    expect(items[1].text).toBe("Schedule follow-up meeting");
  });

  it("should handle singular 'Action Item:' header", () => {
    const content = "Action Item:\n- Do the thing";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
  });

  it("should handle case-insensitive header", () => {
    const content = "ACTION ITEMS:\n- Fix bug\n- Update tests";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
  });

  it("should support bullet styles: dash, bullet, asterisk", () => {
    const content = "Action Items:\n- Dash item\n• Bullet item\n* Asterisk item";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(3);
  });
});

// ── Pattern 3: TODO/ACTION/FIXME markers ──

describe("TODO/ACTION/FIXME marker extraction", () => {
  it("should extract TODO: items", () => {
    const content = "TODO: Write the migration script";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Write the migration script");
  });

  it("should extract ACTION: items", () => {
    const content = "ACTION: Review the security audit findings";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
  });

  it("should extract FIXME: items", () => {
    const content = "FIXME: Handle the edge case for empty arrays";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
  });

  it("should be case-insensitive", () => {
    const content = "todo: lowercase todo\nTodo: Mixed case todo";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
  });
});

// ── Pattern 4: @mention with action verbs ──

describe("@mention action extraction", () => {
  it("should extract @mention please patterns", () => {
    const content = "@kim please review the PR before EOD.";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("@kim review the PR before EOD");
    expect(items[0].assignee).toBe("kim");
  });

  it("should extract @mention needs to patterns", () => {
    const content = "@alex needs to update the deployment docs.";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
    expect(items[0].assignee).toBe("alex");
  });

  it("should extract @mention should patterns", () => {
    const content = "@team should migrate to the new API.";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
  });
});

// ── Pattern 5: Next steps section ──

describe("next steps section extraction", () => {
  it("should extract items under 'Next Steps:' header", () => {
    const content = [
      "Summary...",
      "",
      "Next Steps:",
      "- Finalize the design",
      "- Begin implementation",
    ].join("\n");
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
  });

  it("should support numbered steps", () => {
    const content = "Next steps:\n1. First thing\n2. Second thing";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(2);
  });
});

// ── Deduplication ──

describe("deduplication", () => {
  it("should not duplicate items that match multiple patterns", () => {
    // This text matches both checkbox pattern AND could be in an action items section
    const content = [
      "Action Items:",
      "- Fix the login bug",
      "",
      "[ ] Fix the login bug",
    ].join("\n");
    const items = extractActionItemsFromContent(content);
    const fixBugItems = items.filter((i) =>
      i.text.toLowerCase().includes("fix the login bug")
    );
    expect(fixBugItems).toHaveLength(1);
  });

  it("should deduplicate case-insensitively", () => {
    const content = "TODO: Fix the bug\nTODO: fix the bug";
    const items = extractActionItemsFromContent(content);
    expect(items).toHaveLength(1);
  });
});

// ── Urgency detection ──

describe("urgency detection", () => {
  it("should mark items containing 'urgent' as urgent", () => {
    const content = "[ ] Urgent: fix the production crash";
    const items = extractActionItemsFromContent(content);
    expect(items[0].isUrgent).toBe(true);
  });

  it("should mark items containing 'asap' as urgent", () => {
    const content = "[ ] Deploy the hotfix asap";
    const items = extractActionItemsFromContent(content);
    expect(items[0].isUrgent).toBe(true);
  });

  it("should mark items containing 'today' as urgent", () => {
    const content = "[ ] Send the report today";
    const items = extractActionItemsFromContent(content);
    expect(items[0].isUrgent).toBe(true);
  });

  it("should mark items containing 'eod' as urgent", () => {
    const content = "[ ] Complete review by eod";
    const items = extractActionItemsFromContent(content);
    expect(items[0].isUrgent).toBe(true);
  });

  it("should mark items containing 'critical' as urgent", () => {
    const content = "[ ] Fix critical security vulnerability";
    const items = extractActionItemsFromContent(content);
    expect(items[0].isUrgent).toBe(true);
  });

  it("should NOT mark regular items as urgent", () => {
    const content = "[ ] Update the README with new examples";
    const items = extractActionItemsFromContent(content);
    expect(items[0].isUrgent).toBe(false);
  });
});

// ── Assignee extraction ──

describe("assignee extraction", () => {
  it("should extract @mention assignees from checkbox items", () => {
    const content = "[ ] @kim review the PR";
    const items = extractActionItemsFromContent(content);
    expect(items[0].assignee).toBe("kim");
  });

  it("should extract 'assigned to Name' pattern", () => {
    const content = "[ ] Update docs assigned to Sarah";
    const items = extractActionItemsFromContent(content);
    expect(items[0].assignee).toBe("Sarah");
  });

  it("should extract 'assigned to First Last' pattern", () => {
    const content = "[ ] Review code assigned to Kim Lee";
    const items = extractActionItemsFromContent(content);
    expect(items[0].assignee).toBe("Kim Lee");
  });

  it("should extract 'for Name' pattern", () => {
    const content = "[ ] Setup environment for Alex";
    const items = extractActionItemsFromContent(content);
    expect(items[0].assignee).toBe("Alex");
  });

  it("should return undefined when no assignee found", () => {
    const content = "[ ] Fix the deployment pipeline";
    const items = extractActionItemsFromContent(content);
    expect(items[0].assignee).toBeUndefined();
  });
});

// ── Empty / no-match cases ──

describe("edge cases", () => {
  it("should return empty array for empty content", () => {
    expect(extractActionItemsFromContent("")).toHaveLength(0);
  });

  it("should return empty array for content with no action items", () => {
    const content = "We discussed the roadmap and agreed on priorities.\nNo action needed.";
    expect(extractActionItemsFromContent(content)).toHaveLength(0);
  });

  it("should skip checked checkboxes [x]", () => {
    const content = "[x] Done item\n[X] Also done";
    expect(extractActionItemsFromContent(content)).toHaveLength(0);
  });
});
