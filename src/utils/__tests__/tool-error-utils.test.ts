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

// ── Classification ───────────────────────────────────────────────────────────

describe("buildStructuredError — classification", () => {
  it("classifies TokenExchangeError as auth, carrying status and description", () => {
    const error = new TokenExchangeError("Token exchange failed: 400", 400, "invalid_target");
    const result = buildStructuredError(error, SOURCE);
    expect(result.category).toBe("auth");
    expect(result.status).toBe(400);
    expect(result.description).toBe("invalid_target");
    expect(result.message).toBe("Token exchange failed: 400");
  });

  it("classifies TokenExchangeError without status/description as auth with both undefined", () => {
    const result = buildStructuredError(new TokenExchangeError("network down"), SOURCE);
    expect(result.category).toBe("auth");
    expect(result.status).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it("classifies AuthenticationError as auth with its status", () => {
    const result = buildStructuredError(new AuthenticationError("Gmail", 401), SOURCE);
    expect(result.category).toBe("auth");
    expect(result.status).toBe(401);
    expect(result.description).toBeUndefined();
    expect(result.message).toBe("Gmail: unauthorized (401)");
  });

  it("classifies TypeError as network", () => {
    const result = buildStructuredError(new TypeError("fetch failed"), SOURCE);
    expect(result.category).toBe("network");
    expect(result.status).toBeUndefined();
    expect(result.message).toBe("fetch failed");
  });

  it("classifies a plain object with status 429 as rate_limit", () => {
    const result = buildStructuredError({ status: 429 }, SOURCE);
    expect(result.category).toBe("rate_limit");
    expect(result.status).toBe(429);
  });

  it("classifies a plain object with status 503 as upstream_api", () => {
    const result = buildStructuredError({ status: 503 }, SOURCE);
    expect(result.category).toBe("upstream_api");
    expect(result.status).toBe(503);
  });

  it("classifies a plain object with a 2xx status as unknown", () => {
    // Only >= 400 counts as an upstream failure; anything else is unclassified.
    const result = buildStructuredError({ status: 200 }, SOURCE);
    expect(result.category).toBe("unknown");
    expect(result.status).toBeUndefined();
  });

  it("classifies a plain Error without status as unknown, keeping its message", () => {
    const result = buildStructuredError(new Error("boom"), SOURCE);
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("boom");
  });

  it("classifies a string as unknown with message 'Unknown error'", () => {
    const result = buildStructuredError("something went wrong", SOURCE);
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("Unknown error");
  });

  it("classifies undefined as unknown with message 'Unknown error'", () => {
    const result = buildStructuredError(undefined, SOURCE);
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("Unknown error");
  });
});

// ── buildStructuredError — field pass-through ────────────────────────────────

describe("buildStructuredError — fields", () => {
  it("sets source and resource from arguments", () => {
    const result = buildStructuredError(new Error("x"), SOURCE, RESOURCE);
    expect(result.source).toBe(SOURCE);
    expect(result.resource).toBe(RESOURCE);
  });

  it("passes a non-empty scopes list through", () => {
    const result = buildStructuredError(new Error("x"), SOURCE, RESOURCE, SCOPES);
    expect(result.scopes).toEqual(SCOPES);
  });

  it("sets scopes to undefined when the list is empty", () => {
    const result = buildStructuredError(new Error("x"), SOURCE, RESOURCE, []);
    expect(result.scopes).toBeUndefined();
  });

  it("sets scopes to undefined when omitted", () => {
    const result = buildStructuredError(new Error("x"), SOURCE);
    expect(result.scopes).toBeUndefined();
  });

  it("passes hint through", () => {
    const result = buildStructuredError(new Error("x"), SOURCE, undefined, undefined, "check zone");
    expect(result.hint).toBe("check zone");
  });

  it("leaves hint undefined when omitted", () => {
    const result = buildStructuredError(new Error("x"), SOURCE);
    expect(result.hint).toBeUndefined();
  });

  it("stamps an ISO-8601 timestamp for the current time", () => {
    jest.useFakeTimers();
    try {
      const fixed = new Date("2026-10-27T12:34:56.789Z");
      jest.setSystemTime(fixed);
      const result = buildStructuredError(new Error("x"), SOURCE);
      expect(result.timestamp).toBe("2026-10-27T12:34:56.789Z");
      // Round-trips through Date, so it's a parseable ISO-8601 string.
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── handleToolError — response shape ─────────────────────────────────────────

describe("handleToolError — response shape", () => {
  it("returns isError: true with a single text content block", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, SCOPES);
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

  it("mentions 'Reauthorize' in the LLM-facing text for an auth error", () => {
    const result = handleToolError(new AuthenticationError("Gmail", 403), SOURCE, RESOURCE, SCOPES);
    expect(result.content[0].text).toContain("Reauthorize");
  });

  it("does not mention 'Reauthorize' in the LLM-facing text for a non-auth error", () => {
    const result = handleToolError({ status: 503 }, SOURCE, RESOURCE, SCOPES);
    expect(result.content[0].text).not.toContain("Reauthorize");
  });

  it("never leaks the raw error message or resource into the LLM-facing text", () => {
    // The sanitized channel must stay bland — internal detail lives in _meta only.
    const error = new TokenExchangeError(`failed for user abc-123 at ${RESOURCE}`, 400);
    const result = handleToolError(error, SOURCE, RESOURCE, SCOPES);
    expect(result.content[0].text).not.toContain("abc-123");
    expect(result.content[0].text).not.toContain(RESOURCE);
  });
});

// ── handleToolError — resource / scope / hint normalization ──────────────────

describe("handleToolError — resources", () => {
  it("uses a single resource string as resource", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, SCOPES);
    expect(result._meta.error.resource).toBe(RESOURCE);
  });

  it("uses a one-element resource array as the bare string", () => {
    const result = handleToolError(new Error("x"), SOURCE, [RESOURCE], SCOPES);
    expect(result._meta.error.resource).toBe(RESOURCE);
  });

  it("joins multiple resources with newlines", () => {
    const result = handleToolError(
      new Error("x"),
      SOURCE,
      ["https://a.example", "https://b.example", "https://c.example"],
      SCOPES
    );
    expect(result._meta.error.resource).toBe(
      "https://a.example\nhttps://b.example\nhttps://c.example"
    );
  });

  it("leaves resource undefined for an empty resource array", () => {
    const result = handleToolError(new Error("x"), SOURCE, [], SCOPES);
    expect(result._meta.error.resource).toBeUndefined();
  });
});

describe("handleToolError — scopes", () => {
  it("passes a flat string[] through unchanged", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, ["a", "b"]);
    expect(result._meta.error.scopes).toEqual(["a", "b"]);
  });

  it("flattens string[][] into a single list", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, [["a"], ["b", "c"]]);
    expect(result._meta.error.scopes).toEqual(["a", "b", "c"]);
  });

  it("deduplicates scopes that repeat across nested lists", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, [
      ["a", "b"],
      ["b", "c"],
      ["a"],
    ]);
    expect(result._meta.error.scopes).toEqual(["a", "b", "c"]);
  });

  it("deduplicates repeated scopes in a flat list", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, ["a", "a", "b"]);
    expect(result._meta.error.scopes).toEqual(["a", "b"]);
  });

  it("sets scopes to undefined for an empty list", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, []);
    expect(result._meta.error.scopes).toBeUndefined();
  });
});

describe("handleToolError — hints", () => {
  it("joins extraHints with '; '", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, SCOPES, [
      "check zone config",
      "verify resource identifier",
    ]);
    expect(result._meta.error.hint).toBe("check zone config; verify resource identifier");
  });

  it("uses a single hint as-is", () => {
    const result = handleToolError(new Error("x"), SOURCE, RESOURCE, SCOPES, ["only one"]);
    expect(result._meta.error.hint).toBe("only one");
  });

  it("leaves hint undefined when extraHints is empty or omitted", () => {
    expect(
      handleToolError(new Error("x"), SOURCE, RESOURCE, SCOPES, [])._meta.error.hint
    ).toBeUndefined();
    expect(
      handleToolError(new Error("x"), SOURCE, RESOURCE, SCOPES)._meta.error.hint
    ).toBeUndefined();
  });
});

// ── handleToolError — logging ────────────────────────────────────────────────

describe("handleToolError — logging", () => {
  it("scopes the logger to the tool_error operation", () => {
    handleToolError(new Error("x"), SOURCE, RESOURCE, SCOPES);
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
