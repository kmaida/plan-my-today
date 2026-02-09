/**
 * Tests for dependency pattern parsing.
 *
 * parseDependencies extracts blocking relationships from free text
 * (issue descriptions, titles, comments). Regex edge cases here cause
 * false positives (phantom blockers) or missed dependencies.
 */

import { parseDependencies } from "../dependency-utils";

// ── Blocking pattern detection ──

describe("blocking pattern detection", () => {
  it("should detect 'blocked by' with Linear issue ID", () => {
    const result = parseDependencies("Blocked by ABC-123");
    expect(result.blockedBy).toContain("ABC-123");
  });

  it("should detect 'blocked by' with GitHub issue number", () => {
    const result = parseDependencies("Blocked by #456");
    expect(result.blockedBy).toContain("#456");
  });

  it("should detect 'depends on' pattern", () => {
    const result = parseDependencies("Depends on PROJ-789");
    expect(result.blockedBy).toContain("PROJ-789");
  });

  it("should detect 'waiting for' pattern", () => {
    const result = parseDependencies("Waiting for DEV-42");
    expect(result.blockedBy).toContain("DEV-42");
  });

  it("should detect 'waiting on' pattern", () => {
    const result = parseDependencies("Waiting on DEV-42");
    expect(result.blockedBy).toContain("DEV-42");
  });

  it("should detect 'requires' pattern", () => {
    const result = parseDependencies("Requires API-100");
    expect(result.blockedBy).toContain("API-100");
  });

  it("should detect 'after' pattern", () => {
    const result = parseDependencies("Start after INFRA-55");
    expect(result.blockedBy).toContain("INFRA-55");
  });

  it("should detect 'blocked until' pattern", () => {
    const result = parseDependencies("Blocked until SEC-12");
    expect(result.blockedBy).toContain("SEC-12");
  });

  it("should detect multiple blockers in one text", () => {
    const result = parseDependencies(
      "Blocked by ABC-1 and depends on DEF-2, waiting on #3"
    );
    expect(result.blockedBy).toHaveLength(3);
    expect(result.blockedBy).toContain("ABC-1");
    expect(result.blockedBy).toContain("DEF-2");
    expect(result.blockedBy).toContain("#3");
  });

  it("should be case-insensitive for keywords", () => {
    const result = parseDependencies("BLOCKED BY ABC-123");
    expect(result.blockedBy).toContain("ABC-123");
  });
});

// ── Issue ID format validation ──

describe("issue ID format", () => {
  it("should match 2-letter prefix (minimum)", () => {
    const result = parseDependencies("Blocked by AB-1");
    expect(result.blockedBy).toContain("AB-1");
  });

  it("should match 10-letter prefix (maximum)", () => {
    const result = parseDependencies("Blocked by ABCDEFGHIJ-999");
    expect(result.blockedBy).toContain("ABCDEFGHIJ-999");
  });

  it("should NOT match 1-letter prefix (too short)", () => {
    const result = parseDependencies("Blocked by A-1");
    expect(result.blockedBy).toHaveLength(0);
  });

  it("should NOT match 11-letter prefix (too long)", () => {
    const result = parseDependencies("Blocked by ABCDEFGHIJK-1");
    expect(result.blockedBy).toHaveLength(0);
  });
});

// ── Email / person waiting patterns ──

describe("waiting on person (email)", () => {
  it("should detect email in 'waiting on' pattern", () => {
    const result = parseDependencies("Waiting on kim@example.com for approval");
    expect(result.waitingOn).toContain("kim@example.com");
  });

  it("should detect email in 'blocked by' pattern", () => {
    const result = parseDependencies("Blocked by legal@company.org");
    expect(result.waitingOn).toContain("legal@company.org");
  });

  it("should handle email with subdomain", () => {
    const result = parseDependencies("Waiting on user@sub.example.com");
    expect(result.waitingOn).toContain("user@sub.example.com");
  });

  it("should set blockedByExternal when waiting on a person", () => {
    const result = parseDependencies("Waiting on designer@company.com");
    expect(result.blockedByExternal).toBe(true);
  });
});

// ── External blocking detection ──

describe("blockedByExternal flag", () => {
  it("should be true when 'blocked' keyword present with no issue ID", () => {
    const result = parseDependencies("This task is blocked");
    expect(result.blockedByExternal).toBe(true);
    expect(result.blockedBy).toHaveLength(0);
  });

  it("should be false when 'blocked by' has an issue ID", () => {
    const result = parseDependencies("Blocked by ABC-123");
    // blockedBy has a match, and normalized doesn't trigger the fallback
    // because blockedBy.size > 0
    expect(result.blockedByExternal).toBe(false);
  });

  it("should be false when no blocking language at all", () => {
    const result = parseDependencies("Implement the new feature");
    expect(result.blockedByExternal).toBe(false);
  });

  it("should be true when waiting on email (even with issue IDs)", () => {
    // waitingOn.size > 0 always sets blockedByExternal = true
    const result = parseDependencies(
      "Blocked by ABC-123, waiting on legal@co.com"
    );
    expect(result.blockedByExternal).toBe(true);
  });
});

// ── No matches ──

describe("no dependencies", () => {
  it("should return empty arrays for text with no dependency patterns", () => {
    const result = parseDependencies("Just a regular task description");
    expect(result.blockedBy).toHaveLength(0);
    expect(result.blocks).toHaveLength(0);
    expect(result.waitingOn).toHaveLength(0);
    expect(result.blockedByExternal).toBe(false);
  });

  it("should return empty arrays for empty string", () => {
    const result = parseDependencies("");
    expect(result.blockedBy).toHaveLength(0);
    expect(result.blockedByExternal).toBe(false);
  });
});
