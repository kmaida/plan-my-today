/**
 * Tests for tool-error-utils.ts — the shared catch-block helper every MCP
 * tool uses to turn a thrown error into a structured MCP error response.
 *
 * A bug here means either the UI gets the wrong error category / detail
 * (bad badge, missing reauth prompt) or the LLM-facing text leaks internal
 * details. Both channels are exercised:
 *   - `_meta.error` (the StructuredToolError the UI renders)
 *   - `content[0].text` (the sanitized text the LLM reads)
 *
 * Strategy: mock `getLogger` so the warn/error calls are observable but
 * nothing is written, then drive `buildStructuredError` and `handleToolError`
 * with each error shape the classifier distinguishes (typed classes, status-
 * bearing objects, non-Error values) and assert on the resulting fields.
 */

import { TokenExchangeError } from "../../services/keycard-client";
import { AuthenticationError } from "../error-utils";
import { buildStructuredError, handleToolError } from "../tool-error-utils";

// ── Mock the logger ──────────────────────────────────────────────────────────
//
// `handleToolError` calls `getLogger().withOperation("tool_error")` and then
// `.warn()` (auth) or `.error()` (everything else). Shared jest.fn() instances
// let each test assert which channel was used and with what attributes.

const mockWarn = jest.fn();
const mockError = jest.fn();
const mockWithOperation = jest.fn(() => ({ warn: mockWarn, error: mockError }));

jest.mock("../../observability/logger", () => ({
  getLogger: () => ({ withOperation: mockWithOperation }),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

const SOURCE = "gmail";
const RESOURCE = "https://gmail.googleapis.com";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const ERR = new Error("x");

// ── Classification ───────────────────────────────────────────────────────────

describe("buildStructuredError — classification", () => {
  const tokenErr = new TokenExchangeError("Token exchange failed: 400", 400, "invalid_target");

  it.each([
    [
      "TokenExchangeError → auth, carrying status and description",
      tokenErr,
      { category: "auth", status: 400, description: "invalid_target", message: tokenErr.message },
    ],
    [
      "TokenExchangeError without status/description → auth, both undefined",
      new TokenExchangeError("network down"),
      { category: "auth", status: undefined, description: undefined, message: "network down" },
    ],
    [
      "AuthenticationError → auth with its status",
      new AuthenticationError("Gmail", 401),
      {
        category: "auth",
        status: 401,
        description: undefined,
        message: "Gmail: unauthorized (401)",
      },
    ],
    [
      "TypeError → network",
      new TypeError("fetch failed"),
      { category: "network", status: undefined, message: "fetch failed" },
    ],
    ["{ status: 429 } → rate_limit", { status: 429 }, { category: "rate_limit", status: 429 }],
    ["{ status: 503 } → upstream_api", { status: 503 }, { category: "upstream_api", status: 503 }],
    // Only >= 400 counts as an upstream failure; anything else is unclassified.
    [
      "{ status: 200 } → unknown, status dropped",
      { status: 200 },
      { category: "unknown", status: undefined },
    ],
    [
      "plain Error → unknown, keeping its message",
      new Error("boom"),
      { category: "unknown", message: "boom" },
    ],
    [
      "string → unknown with 'Unknown error'",
      "oops",
      { category: "unknown", message: "Unknown error" },
    ],
    [
      "undefined → unknown with 'Unknown error'",
      undefined,
      { category: "unknown", message: "Unknown error" },
    ],
  ])("classifies %s", (_label, error, expected) => {
    expect(buildStructuredError(error, SOURCE)).toMatchObject(expected);
  });
});

// ── buildStructuredError — field pass-through ────────────────────────────────

describe("buildStructuredError — fields", () => {
  it("sets source, resource, and a non-empty scopes list from arguments", () => {
    const result = buildStructuredError(ERR, SOURCE, RESOURCE, SCOPES);
    expect(result).toMatchObject({ source: SOURCE, resource: RESOURCE, scopes: SCOPES });
  });

  it("sets scopes to undefined when the list is empty or omitted", () => {
    expect(buildStructuredError(ERR, SOURCE, RESOURCE, []).scopes).toBeUndefined();
    expect(buildStructuredError(ERR, SOURCE).scopes).toBeUndefined();
  });

  it("passes hint through, leaving it undefined when omitted", () => {
    expect(buildStructuredError(ERR, SOURCE, undefined, undefined, "check zone").hint).toBe(
      "check zone"
    );
    expect(buildStructuredError(ERR, SOURCE).hint).toBeUndefined();
  });

  it("stamps an ISO-8601 timestamp for the current time", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-10-27T12:34:56.789Z"));
      const { timestamp } = buildStructuredError(ERR, SOURCE);
      expect(timestamp).toBe("2026-10-27T12:34:56.789Z");
      // Round-trips through Date, so it's a parseable ISO-8601 string.
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── handleToolError — response shape ─────────────────────────────────────────

describe("handleToolError — response shape", () => {
  it("returns isError: true with a single text content block", () => {
    const result = handleToolError(ERR, SOURCE, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("carries the StructuredToolError in _meta.error", () => {
    const error = new TokenExchangeError("Token exchange failed: 400", 400, "invalid_target");
    const result = handleToolError(error, SOURCE, RESOURCE, SCOPES);
    expect(result._meta.error).toMatchObject({
      category: "auth",
      source: SOURCE,
      resource: RESOURCE,
      scopes: SCOPES,
      status: 400,
      description: "invalid_target",
      message: "Token exchange failed: 400",
    });
    expect(typeof result._meta.error.timestamp).toBe("string");
  });

  it("mentions 'Reauthorize' in the LLM-facing text for an auth error only", () => {
    const auth = handleToolError(new AuthenticationError("Gmail", 403), SOURCE, RESOURCE, SCOPES);
    const nonAuth = handleToolError({ status: 503 }, SOURCE, RESOURCE, SCOPES);
    expect(auth.content[0].text).toContain("Reauthorize");
    expect(nonAuth.content[0].text).not.toContain("Reauthorize");
  });

  it("never leaks the raw error message or resource into the LLM-facing text", () => {
    // The sanitized channel must stay bland — internal detail lives in _meta only.
    const error = new TokenExchangeError(`failed for user abc-123 at ${RESOURCE}`, 400);
    const { text } = handleToolError(error, SOURCE, RESOURCE, SCOPES).content[0];
    expect(text).not.toContain("abc-123");
    expect(text).not.toContain(RESOURCE);
  });
});

// ── handleToolError — resource / scope / hint normalization ──────────────────

describe("handleToolError — resources", () => {
  it.each([
    ["a single resource string as-is", RESOURCE, RESOURCE],
    ["a one-element array as the bare string", [RESOURCE], RESOURCE],
    [
      "multiple resources joined with newlines",
      ["https://a.example", "https://b.example"],
      "https://a.example\nhttps://b.example",
    ],
    ["an empty array as undefined", [], undefined],
  ])("surfaces %s", (_label, resources, expected) => {
    expect(handleToolError(ERR, SOURCE, resources, SCOPES)._meta.error.resource).toBe(expected);
  });
});

describe("handleToolError — scopes", () => {
  it.each([
    ["passes a flat string[] through unchanged", ["a", "b"], ["a", "b"]],
    ["flattens string[][] into a single list", [["a"], ["b", "c"]], ["a", "b", "c"]],
    [
      "deduplicates scopes repeated across nested lists",
      [["a", "b"], ["b", "c"], ["a"]],
      ["a", "b", "c"],
    ],
    ["deduplicates repeated scopes in a flat list", ["a", "a", "b"], ["a", "b"]],
    ["sets scopes to undefined for an empty list", [], undefined],
  ])("%s", (_label, scopes, expected) => {
    expect(handleToolError(ERR, SOURCE, RESOURCE, scopes)._meta.error.scopes).toEqual(expected);
  });
});

describe("handleToolError — hints", () => {
  it.each([
    [
      "joins extraHints with '; '",
      ["check zone config", "verify resource identifier"],
      "check zone config; verify resource identifier",
    ],
    ["uses a single hint as-is", ["only one"], "only one"],
    ["leaves hint undefined for an empty list", [], undefined],
    ["leaves hint undefined when omitted", undefined, undefined],
  ])("%s", (_label, extraHints, expected) => {
    expect(handleToolError(ERR, SOURCE, RESOURCE, SCOPES, extraHints)._meta.error.hint).toBe(
      expected
    );
  });
});

// ── handleToolError — logging ────────────────────────────────────────────────

describe("handleToolError — logging", () => {
  it("scopes the logger to the tool_error operation", () => {
    handleToolError(ERR, SOURCE, RESOURCE, SCOPES);
    expect(mockWithOperation).toHaveBeenCalledWith("tool_error");
  });

  it("logs an auth error via warn with source, status, description, resources, and hints", () => {
    const error = new TokenExchangeError("Token exchange failed: 400", 400, "invalid_target");
    handleToolError(error, SOURCE, ["https://a.example", "https://b.example"], SCOPES, [
      "h1",
      "h2",
    ]);

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockError).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith("Token exchange failed", {
      source: SOURCE,
      category: "auth",
      description: "invalid_target",
      status: 400,
      resources: "https://a.example, https://b.example",
      hints: "h1; h2",
    });
  });

  it("logs an AuthenticationError via warn as well", () => {
    handleToolError(new AuthenticationError("Gmail", 401), SOURCE, RESOURCE, SCOPES);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockError).not.toHaveBeenCalled();
  });

  it("logs a non-auth error via error with source, category, status, and message", () => {
    handleToolError({ status: 503 }, SOURCE, RESOURCE, SCOPES);

    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith("Tool call failed", {
      source: SOURCE,
      category: "upstream_api",
      status: 503,
      message: "Unknown error",
    });
  });

  it("logs a network error via error with the raw message", () => {
    handleToolError(new TypeError("fetch failed"), SOURCE, RESOURCE, SCOPES);
    expect(mockError).toHaveBeenCalledWith(
      "Tool call failed",
      expect.objectContaining({ category: "network", message: "fetch failed" })
    );
  });
});
