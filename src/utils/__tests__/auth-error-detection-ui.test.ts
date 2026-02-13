/**
 * Tests for the UI source error detection utility.
 *
 * These test the actual functions that ChatPanel uses to decide whether to
 * show the reauthorization banner. Detection uses two structured signals:
 *
 * 1. isError flag — from the MCP protocol (individual tool failures)
 * 2. metadata.errors — structured per-source errors (aggregate tool)
 *
 * No string pattern matching is involved.
 */

import {
  extractMetadataErrors,
  extractToolCallAuthErrors,
} from "../../../ui/src/chat/auth-error-detection";

// ── extractMetadataErrors ────────────────────────────────────────────────────

describe("extractMetadataErrors", () => {
  it("should extract errors from valid JSON with metadata.errors", () => {
    const json = JSON.stringify({
      calendar: [],
      metadata: {
        errors: [
          "Gmail: Authentication failed — reauthorize to refresh grants",
          "Slack: Token exchange failed: 500",
        ],
      },
    });
    expect(extractMetadataErrors(json)).toEqual([
      "Gmail: Authentication failed — reauthorize to refresh grants",
      "Slack: Token exchange failed: 500",
    ]);
  });

  it("should return empty array for JSON with metadata but no errors field", () => {
    const json = JSON.stringify({
      calendar: [{ summary: "standup" }],
      metadata: { fetched_at: "2026-01-01T00:00:00Z" },
    });
    expect(extractMetadataErrors(json)).toEqual([]);
  });

  it("should return empty array for JSON with metadata object but no errors key", () => {
    const json = JSON.stringify({ metadata: {} });
    expect(extractMetadataErrors(json)).toEqual([]);
  });

  it("should return null for non-JSON strings", () => {
    expect(extractMetadataErrors("❌ Error: unauthorized")).toBeNull();
    expect(extractMetadataErrors("plain text error")).toBeNull();
  });

  it("should return null for malformed JSON", () => {
    expect(extractMetadataErrors("{invalid json")).toBeNull();
  });

  it("should return null for JSON without a metadata field", () => {
    const json = JSON.stringify({ data: [1, 2, 3] });
    expect(extractMetadataErrors(json)).toBeNull();
  });
});

// ── extractToolCallAuthErrors ────────────────────────────────────────────────

describe("extractToolCallAuthErrors", () => {
  describe("structured JSON results (aggregate tools)", () => {
    it("should return all metadata.errors entries", () => {
      const result = JSON.stringify({
        calendar: [{ summary: "standup" }],
        linear: [],
        metadata: {
          errors: ["Gmail: Authentication failed — reauthorize to refresh grants"],
          fetched_at: "2026-01-01T00:00:00Z",
        },
      });

      const errors = extractToolCallAuthErrors({
        id: "tc_1",
        name: "list-all-tasks-today",
        input: {},
        result,
      });

      expect(errors).toEqual([
        "list-all-tasks-today: Gmail: Authentication failed — reauthorize to refresh grants",
      ]);
    });

    it("should return multiple errors from metadata.errors", () => {
      const result = JSON.stringify({
        metadata: {
          errors: [
            "Gmail: Authentication failed — reauthorize to refresh grants",
            "Slack: Rate limit exceeded",
          ],
        },
      });

      const errors = extractToolCallAuthErrors({
        id: "tc_1",
        name: "list-all-tasks-today",
        input: {},
        result,
      });

      expect(errors).toHaveLength(2);
    });

    it("should NOT report errors when metadata exists but has no errors", () => {
      const result = JSON.stringify({
        calendar: [{ summary: "Discuss 401k plan" }],
        linear: [{ title: "Review unauthorized access logs" }],
        metadata: { fetched_at: "2026-01-01T00:00:00Z" },
      });

      const errors = extractToolCallAuthErrors({
        id: "tc_1",
        name: "list-all-tasks-today",
        input: {},
        result,
      });

      expect(errors).toEqual([]);
    });

    it("should return empty for empty metadata.errors array", () => {
      const result = JSON.stringify({ metadata: { errors: [] } });

      const errors = extractToolCallAuthErrors({
        id: "tc_1",
        name: "list-all-tasks-today",
        input: {},
        result,
      });

      expect(errors).toEqual([]);
    });
  });

  describe("isError flag (individual source tools)", () => {
    it("should detect errors when isError is true", () => {
      const errors = extractToolCallAuthErrors({
        id: "tc_2",
        name: "list-gmail-todos",
        input: {},
        result: "❌ Error: Token exchange failed: 400",
        isError: true,
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^list-gmail-todos:/);
    });

    it("should NOT detect errors when isError is false", () => {
      const errors = extractToolCallAuthErrors({
        id: "tc_2",
        name: "list-gmail-todos",
        input: {},
        result: "❌ Error: Token exchange failed: 400",
        isError: false,
      });

      expect(errors).toEqual([]);
    });

    it("should NOT detect errors when isError is undefined", () => {
      // A successful tool call with no isError flag
      const errors = extractToolCallAuthErrors({
        id: "tc_2",
        name: "list-gmail-todos",
        input: {},
        result: "Found 5 emails",
      });

      expect(errors).toEqual([]);
    });

    it("should truncate long error results to 200 chars", () => {
      const longError = `Error: ${"x".repeat(300)}`;
      const errors = extractToolCallAuthErrors({
        id: "tc_2",
        name: "list-linear-issues",
        input: {},
        result: longError,
        isError: true,
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].length).toBeLessThanOrEqual("list-linear-issues: ".length + 200);
    });
  });

  describe("edge cases", () => {
    it("should return empty for tool calls with no result", () => {
      const errors = extractToolCallAuthErrors({
        id: "tc_3",
        name: "list-all-tasks-today",
        input: {},
      });

      expect(errors).toEqual([]);
    });

    it("should return empty for tool calls with empty result", () => {
      const errors = extractToolCallAuthErrors({
        id: "tc_3",
        name: "list-all-tasks-today",
        input: {},
        result: "",
      });

      expect(errors).toEqual([]);
    });

    it("should use isError flag for non-JSON results that are errors", () => {
      const errors = extractToolCallAuthErrors({
        id: "tc_3",
        name: "list-calendar-events",
        input: {},
        result: "Connection refused",
        isError: true,
      });

      expect(errors).toEqual(["list-calendar-events: Connection refused"]);
    });
  });
});
