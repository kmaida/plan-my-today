/**
 * Tests for hashActionText — the pure function that derives a short, stable
 * identifier from action text for the dismissed-actions store.
 *
 * Strategy: no mocking. The function is deterministic (MD5 of the trimmed
 * text, first 8 hex chars), so each test asserts a directly observable
 * property of the output: shape, determinism, trim-sensitivity, and the
 * one known fixed point (the empty string → MD5 of nothing).
 */

import { hashActionText } from "../action-identifiers";

describe("hashActionText", () => {
  it("returns 8 lowercase hex characters", () => {
    expect(hashActionText("Review the Q3 roadmap")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns the same result for the same input", () => {
    expect(hashActionText("Follow up with Sam")).toBe(hashActionText("Follow up with Sam"));
  });

  it("ignores leading and trailing whitespace", () => {
    expect(hashActionText(" a b ")).toBe(hashActionText("a b"));
  });

  it("is sensitive to interior whitespace", () => {
    expect(hashActionText("a b")).not.toBe(hashActionText("ab"));
  });

  it("returns different results for different texts", () => {
    expect(hashActionText("Send the invoice")).not.toBe(hashActionText("Send the contract"));
  });

  it("hashes the empty string to the MD5 of nothing", () => {
    expect(hashActionText("")).toBe("d41d8cd9");
  });
});
