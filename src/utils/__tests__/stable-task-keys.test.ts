/**
 * Tests for computeStableId — the pure function that derives a
 * canonical, persistent identifier for each task based on its
 * source-specific natural keys.
 */

import { computeStableId } from "../stable-task-keys";

describe("computeStableId", () => {
  // ── Linear ──────────────────────────────────────────────────────

  it("should produce linear:{identifier}", () => {
    expect(computeStableId("linear", { identifier: "KEY-123" })).toBe("linear:KEY-123");
  });

  it("should return empty string when linear identifier is missing", () => {
    expect(computeStableId("linear", {})).toBe("");
  });

  // ── Gmail ───────────────────────────────────────────────────────

  it("should produce gmail:{id}", () => {
    expect(computeStableId("gmail", { id: "18f3a2b" })).toBe("gmail:18f3a2b");
  });

  it("should handle numeric Gmail ids", () => {
    expect(computeStableId("gmail", { id: 12345 })).toBe("gmail:12345");
  });

  it("should return empty string when gmail id is missing", () => {
    expect(computeStableId("gmail", {})).toBe("");
  });

  // ── Calendar ────────────────────────────────────────────────────

  it("should produce calendar:{id}", () => {
    expect(computeStableId("calendar", { id: "abc@google.com" })).toBe("calendar:abc@google.com");
  });

  it("should return empty string when calendar id is missing", () => {
    expect(computeStableId("calendar", {})).toBe("");
  });

  // ── GitHub PR ───────────────────────────────────────────────────

  it("should produce github-pr:{repo}:{number}", () => {
    expect(computeStableId("github-pr", { repo: "org/repo", number: 42 })).toBe(
      "github-pr:org/repo:42"
    );
  });

  it("should return empty string when repo is missing", () => {
    expect(computeStableId("github-pr", { number: 42 })).toBe("");
  });

  it("should return empty string when number is missing", () => {
    expect(computeStableId("github-pr", { repo: "org/repo" })).toBe("");
  });

  // ── GitHub Issue ────────────────────────────────────────────────

  it("should produce github-issue:{repo}:{number}", () => {
    expect(computeStableId("github-issue", { repo: "org/repo", number: 15 })).toBe(
      "github-issue:org/repo:15"
    );
  });

  // ── Slack ───────────────────────────────────────────────────────

  it("should prefer dismissalId when present", () => {
    expect(
      computeStableId("slack", {
        dismissalId: "C012:1234567890.123",
        channel: "C012",
        timestamp: "1234567890.123",
      })
    ).toBe("slack:C012:1234567890.123");
  });

  it("should fall back to channel:timestamp when dismissalId is missing", () => {
    expect(computeStableId("slack", { channel: "C012", timestamp: "1234567890.123" })).toBe(
      "slack:C012:1234567890.123"
    );
  });

  it("should return empty string when slack has neither dismissalId nor channel+timestamp", () => {
    expect(computeStableId("slack", {})).toBe("");
  });

  // ── Docs ────────────────────────────────────────────────────────

  it("should produce docs:{fileLink} when fileLink present", () => {
    expect(computeStableId("docs", { fileLink: "https://docs.google.com/d/abc" })).toBe(
      "docs:https://docs.google.com/d/abc"
    );
  });

  it("should fall back to fileTitle when fileLink is null", () => {
    expect(computeStableId("docs", { fileLink: null, fileTitle: "My Document" })).toBe(
      "docs:My Document"
    );
  });

  it("should return empty string when docs has neither link nor title", () => {
    expect(computeStableId("docs", {})).toBe("");
  });

  // ── Meeting Notes ───────────────────────────────────────────────

  it("should produce meeting-note:{documentId}:{hash} when actionItem is present", () => {
    const id = computeStableId("meeting-note", {
      documentId: "doc123",
      actionItem: "Follow up on the budget proposal",
    });
    expect(id).toMatch(/^meeting-note:doc123:[a-f0-9]+$/);
  });

  it("should produce meeting-note:{documentId} when actionItem is missing", () => {
    expect(computeStableId("meeting-note", { documentId: "doc123" })).toBe("meeting-note:doc123");
  });

  it("should produce consistent hashes for the same actionItem", () => {
    const a = computeStableId("meeting-note", {
      documentId: "doc123",
      actionItem: "Send the report",
    });
    const b = computeStableId("meeting-note", {
      documentId: "doc123",
      actionItem: "Send the report",
    });
    expect(a).toBe(b);
  });

  it("should return empty string when documentId is missing", () => {
    expect(computeStableId("meeting-note", {})).toBe("");
  });

  // ── Meeting Summary ─────────────────────────────────────────────

  it("should produce meeting-summary:{link}", () => {
    expect(computeStableId("meeting-summary", { link: "https://mail.google.com/..." })).toBe(
      "meeting-summary:https://mail.google.com/..."
    );
  });

  it("should return empty string when meeting-summary link is missing", () => {
    expect(computeStableId("meeting-summary", {})).toBe("");
  });
});
