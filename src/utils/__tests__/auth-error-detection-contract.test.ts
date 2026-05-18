/**
 * Auth error detection contract tests
 *
 * These tests verify the contract between server-side error utilities and the
 * UI's error detection. The contract is based on **typed error classes and
 * structured signals** — no string pattern matching anywhere in the chain:
 *
 * 1. `exchangeToken()` throws `TokenExchangeError` (not plain Error) so
 *    downstream code can use `instanceof` instead of parsing error text.
 *
 * 2. Upstream API utils throw `AuthenticationError` with a status code.
 *
 * 3. `handleToolError` returns `isError: true` in the MCP CallToolResult.
 *    The UI reads the `isError` flag directly.
 *
 * 4. `formatAuthError` uses `instanceof` to map errors to clean, user-facing
 *    messages — never exposing raw error text, user IDs, or internal URLs.
 */

import { TokenExchangeError } from "../../services/keycard-client";
import { AuthenticationError, formatAuthError } from "../error-utils";
import { handleToolError } from "../tool-error-utils";

// ── handleToolError always returns isError: true ─────────────────────────────

describe("handleToolError → isError contract", () => {
  const SOURCE = "gmail";
  const RESOURCE = "https://www.googleapis.com/auth/gmail.readonly";
  const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

  it("should return isError: true for TokenExchangeError", () => {
    const error = new TokenExchangeError("Token exchange failed: 500", 500);
    const result = handleToolError(error, SOURCE, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for TokenExchangeError with description", () => {
    const error = new TokenExchangeError(
      "Token exchange failed: 400",
      400,
      "Token has been revoked"
    );
    const result = handleToolError(error, SOURCE, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for AuthenticationError", () => {
    const error = new AuthenticationError("Gmail", 401);
    const result = handleToolError(error, SOURCE, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for generic errors", () => {
    const error = new Error("ECONNREFUSED 127.0.0.1:8080");
    const result = handleToolError(error, SOURCE, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for non-Error values", () => {
    const result = handleToolError("something went wrong", SOURCE, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });
});

// ── handleToolError response structure ───────────────────────────────────────

describe("handleToolError response structure", () => {
  it("should return content array with a single text entry", () => {
    const error = new Error("something broke");
    const result = handleToolError(error, "linear", "https://api.example.com", ["read"]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("should return clean LLM-facing message for TokenExchangeError (no developer details)", () => {
    const error = new TokenExchangeError("Token exchange failed: 400", 400);
    const result = handleToolError(
      error,
      "gmail",
      "https://www.googleapis.com/auth/gmail.readonly",
      ["https://www.googleapis.com/auth/gmail.readonly"]
    );

    // LLM-facing message guides reauthorization
    expect(result.content[0].text).toContain("Authorization failed");
    expect(result.content[0].text).toContain("Reauthorize");
    // Developer details are logged server-side, NOT in the LLM-facing text.
    // (They DO live on `_meta.error` for the UI — covered in a separate test.)
    expect(result.content[0].text).not.toContain("resource:");
    expect(result.content[0].text).not.toContain("scope:");
    expect(result.content[0].text).not.toContain("googleapis.com");
  });

  it("should NOT include raw error_description in response (logged server-side instead)", () => {
    const error = new TokenExchangeError(
      "Token exchange failed: 400",
      400,
      "Token has been revoked"
    );
    const result = handleToolError(error, "linear", "https://api.example.com", ["read"]);

    // Raw error_description must not appear in the LLM-facing text.
    expect(result.content[0].text).not.toContain("Token has been revoked");
    expect(result.content[0].text).toContain("Authorization failed");
  });

  it("should return clean message for generic errors (no raw error.message)", () => {
    const error = new Error("ECONNREFUSED 127.0.0.1:8080");
    const result = handleToolError(error, "linear", "https://api.example.com", ["read"]);

    expect(result.content[0].text).toContain("unexpected error");
    // Raw error message must not appear in the LLM-facing text.
    expect(result.content[0].text).not.toContain("ECONNREFUSED");
    expect(result.content[0].text).not.toContain("127.0.0.1");
  });
});

// ── _meta.error structured detail contract ───────────────────────────────────
//
// The UI consumes `_meta.error` directly — it must carry the full detail the
// LLM-facing `text` deliberately omits. This is the load-bearing test for the
// dual-channel split.

describe("handleToolError → _meta.error structured detail", () => {
  it("classifies TokenExchangeError as 'auth' and carries status + description", () => {
    const error = new TokenExchangeError(
      "Token exchange failed: 400",
      400,
      "Token has been revoked"
    );
    const result = handleToolError(error, "linear", "https://api.linear.app", ["read"]);

    expect(result._meta?.error.category).toBe("auth");
    expect(result._meta?.error.source).toBe("linear");
    expect(result._meta?.error.status).toBe(400);
    expect(result._meta?.error.description).toBe("Token has been revoked");
    expect(result._meta?.error.resource).toBe("https://api.linear.app");
    expect(result._meta?.error.scopes).toEqual(["read"]);
  });

  it("classifies AuthenticationError as 'auth' with status", () => {
    const error = new AuthenticationError("Gmail", 401);
    const result = handleToolError(error, "gmail", "https://gmail.googleapis.com", [
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);

    expect(result._meta?.error.category).toBe("auth");
    expect(result._meta?.error.status).toBe(401);
  });

  it("classifies TypeError as 'network'", () => {
    const result = handleToolError(
      new TypeError("fetch failed"),
      "github",
      "https://api.github.com",
      []
    );

    expect(result._meta?.error.category).toBe("network");
    expect(result._meta?.error.message).toBe("fetch failed");
  });

  it("classifies status-bearing errors: 429 → rate_limit, 502 → upstream_api", () => {
    const rateLimited = handleToolError(
      Object.assign(new Error("quota"), { status: 429 }),
      "github",
      "https://api.github.com",
      []
    );
    const upstream = handleToolError(
      Object.assign(new Error("bad gateway"), { status: 502 }),
      "github",
      "https://api.github.com",
      []
    );

    expect(rateLimited._meta?.error.category).toBe("rate_limit");
    expect(rateLimited._meta?.error.status).toBe(429);
    expect(upstream._meta?.error.category).toBe("upstream_api");
    expect(upstream._meta?.error.status).toBe(502);
  });

  it("falls back to 'unknown' category for plain errors with no status", () => {
    const result = handleToolError(new Error("???"), "slack", "https://slack.com/api", []);

    expect(result._meta?.error.category).toBe("unknown");
    expect(result._meta?.error.status).toBeUndefined();
  });

  it("preserves the raw error.message verbatim on _meta.error (UI-only channel)", () => {
    const error = new Error("ECONNREFUSED 127.0.0.1:8080");
    const result = handleToolError(error, "linear", "https://api.linear.app", ["read"]);

    expect(result._meta?.error.message).toBe("ECONNREFUSED 127.0.0.1:8080");
    // …while the LLM-facing text stays sanitized.
    expect(result.content[0].text).not.toContain("ECONNREFUSED");
  });

  it("includes extraHints joined into the hint field", () => {
    const result = handleToolError(
      new TokenExchangeError("fail", 500),
      "gmail",
      "https://gmail.googleapis.com",
      [],
      ["Ensure Gmail credential provider is configured in Keycard."]
    );

    expect(result._meta?.error.hint).toBe(
      "Ensure Gmail credential provider is configured in Keycard."
    );
  });

  it("emits a parseable ISO-8601 timestamp", () => {
    const result = handleToolError(new Error("boom"), "linear", "https://api.linear.app", ["read"]);

    expect(result._meta?.error.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(result._meta!.error.timestamp))).toBe(false);
  });

  it("surfaces ALL candidate resources for aggregate tools (joined with newlines)", () => {
    // Aggregate tools like `assigned-actions` and `drive-activity` exchange
    // tokens for multiple resources in one operation; when the call fails, we
    // don't know which resource was at fault. Joining is the most honest
    // representation — better than arbitrarily picking the first.
    const result = handleToolError(
      new TokenExchangeError("fail", 400),
      "drive",
      ["https://drive.googleapis.com", "https://gmail.googleapis.com", "https://docs.googleapis.com"],
      [["scope.a"], ["scope.b"]]
    );

    expect(result._meta?.error.resource).toContain("drive.googleapis.com");
    expect(result._meta?.error.resource).toContain("gmail.googleapis.com");
    expect(result._meta?.error.resource).toContain("docs.googleapis.com");
  });

  it("dedupes scopes from string[][] inputs", () => {
    // assigned-actions passes overlapping scope sets; the structured error
    // should carry one deduped list, not the raw flattened array with dupes.
    const result = handleToolError(
      new TokenExchangeError("fail", 400),
      "drive",
      ["https://drive.googleapis.com"],
      [["read"], ["read", "write"], ["write"]]
    );

    expect(result._meta?.error.scopes).toEqual(["read", "write"]);
  });
});

// ── formatAuthError uses instanceof, not string matching ─────────────────────

describe("formatAuthError → instanceof-based routing", () => {
  it("should produce clean message for TokenExchangeError without description", () => {
    const error = new TokenExchangeError("Token exchange failed: 500", 500);
    const text = formatAuthError("Gmail", error);

    expect(text).toContain("Gmail");
    expect(text).toContain("Token exchange failed");
    expect(text).toContain("please reauthorize");
    // Should NOT contain raw status/body details
    expect(text).not.toContain("500");
  });

  it("should surface short, safe error_description from TokenExchangeError", () => {
    const error = new TokenExchangeError(
      'Token exchange failed: 400 - {"error":"invalid_grant"}',
      400,
      "Token has been revoked"
    );
    const text = formatAuthError("Gmail", error);

    expect(text).toContain("Token has been revoked");
    expect(text).toContain("Gmail");
    // Should NOT contain raw JSON or status code
    expect(text).not.toContain("invalid_grant");
    expect(text).not.toContain("400");
  });

  it("should NOT surface error_description that contains user IDs", () => {
    // Keycard puts the full user ID, resource URL, and scopes in error_description
    // for "no delegated grant" errors. This must never reach the UI.
    const error = new TokenExchangeError(
      "Token exchange failed: 400",
      400,
      "No delegated grant found for user 76ania8xjr9m2vxn8jelmsamhj to access https://www.googleapis.com/calendar/v3 with scopes [https://www.googleapis.com/auth/calendar.readonly]. User needs to delegate access first."
    );
    const text = formatAuthError("Google Calendar", error);

    expect(text).not.toContain("76ania8xjr9m2vxn8jelmsamhj");
    expect(text).not.toContain("googleapis.com");
    expect(text).toContain("Google Calendar");
    expect(text).toContain("Token exchange failed");
    expect(text).toContain("please reauthorize");
  });

  it("should produce '401' message for AuthenticationError with status 401", () => {
    const error = new AuthenticationError("Gmail", 401);
    const text = formatAuthError("Gmail", error);

    expect(text).toContain("Gmail");
    expect(text).toContain("Authentication failed");
    expect(text).toContain("reauthorize");
  });

  it("should produce '403' message for AuthenticationError with status 403", () => {
    const error = new AuthenticationError("Linear", 403);
    const text = formatAuthError("Linear", error);

    expect(text).toContain("Linear");
    expect(text).toContain("Access denied");
    expect(text).toContain("reauthorize");
  });

  it("should produce safe generic message for plain Error", () => {
    const error = new Error("something unexpected");
    const text = formatAuthError("Slack", error);

    expect(text).toContain("Slack");
    // Should NOT contain the raw error message
    expect(text).not.toContain("something unexpected");
  });
});

// ── User-facing message safety ───────────────────────────────────────────────
//
// Raw error messages from Keycard and upstream providers can contain internal
// details like user IDs, resource URLs, and scopes. These must NEVER appear
// in user-facing error messages.

describe("formatAuthError → no internal details leaked", () => {
  const USER_ID = "76ania8xjr9m2vxn8jelmsamhj";

  it("should NOT leak user ID from token exchange errors", () => {
    // Keycard returns user IDs in plain text error bodies. The raw message
    // is stored in error.message but formatAuthError uses error.description
    // (parsed from JSON) or a generic fallback — never the raw message.
    const error = new TokenExchangeError(
      `Token exchange failed: 500 - No delegated grant found for user ${USER_ID}`,
      500
    );
    const text = formatAuthError("Google Calendar", error);

    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain("googleapis.com");
    expect(text).toContain("Google Calendar");
    expect(text).toContain("please reauthorize");
  });

  it("should NOT leak resource URLs from token exchange errors", () => {
    const error = new TokenExchangeError("Token exchange failed: 500 - Internal Server Error", 500);
    const text = formatAuthError("Gmail", error);

    expect(text).not.toContain("Internal Server Error");
    expect(text).toContain("Gmail");
  });

  it("should use short description from TokenExchangeError, not raw message", () => {
    const error = new TokenExchangeError(
      'Token exchange failed: 400 - {"error":"invalid_grant","error_description":"Token has been revoked","requestId":"abc123"}',
      400,
      "Token has been revoked"
    );
    const text = formatAuthError("Gmail", error);

    expect(text).toContain("Token has been revoked");
    expect(text).not.toContain("requestId");
    expect(text).not.toContain("abc123");
  });

  it("should filter long error_description containing internal details", () => {
    // Real Keycard response: error_description has user ID + resource URL + scopes
    const error = new TokenExchangeError(
      "Token exchange failed: 400",
      400,
      "No delegated grant found for user abc123def to access https://api.linear.app with scopes [read]. User needs to delegate access first."
    );
    const text = formatAuthError("Linear", error);

    expect(text).not.toContain("abc123def");
    expect(text).not.toContain("linear.app");
    expect(text).toContain("Linear");
    expect(text).toContain("Token exchange failed");
  });

  it("should NOT leak raw error text in generic fallback", () => {
    const error = new Error("ECONNREFUSED 127.0.0.1:8080");
    const text = formatAuthError("Slack", error);

    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("127.0.0.1");
    expect(text).toContain("Slack");
  });

  it("should produce non-empty output for all error types", () => {
    const variants = [
      formatAuthError("Gmail", new TokenExchangeError("fail", 500)),
      formatAuthError("Gmail", new TokenExchangeError("fail", 400, "Token revoked")),
      formatAuthError("Linear", new AuthenticationError("Linear", 401)),
      formatAuthError("Drive", new AuthenticationError("Drive", 403)),
      formatAuthError("Slack", new Error("unknown")),
    ];

    for (const text of variants) {
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
