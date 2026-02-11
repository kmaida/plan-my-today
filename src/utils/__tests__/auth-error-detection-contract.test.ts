/**
 * Auth error detection contract tests
 *
 * These tests verify the contract between server-side error utilities and the
 * UI's error detection. The contract is based on **typed error classes and
 * structured signals** — no string pattern matching anywhere in the chain:
 *
 * 1. KeycardClient throws `TokenExchangeError` (not plain Error) so
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

import { handleToolError } from "../tool-error-utils";
import { formatAuthError, AuthenticationError } from "../error-utils";
import { TokenExchangeError } from "../../services/keycard-client";

// ── handleToolError always returns isError: true ─────────────────────────────

describe("handleToolError → isError contract", () => {
  const RESOURCE = "https://www.googleapis.com/auth/gmail.readonly";
  const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

  it("should return isError: true for TokenExchangeError", () => {
    const error = new TokenExchangeError("Token exchange failed: 500", 500);
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for TokenExchangeError with description", () => {
    const error = new TokenExchangeError(
      "Token exchange failed: 400",
      400,
      "Token has been revoked"
    );
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for AuthenticationError", () => {
    const error = new AuthenticationError("Gmail", 401);
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for generic errors", () => {
    const error = new Error("ECONNREFUSED 127.0.0.1:8080");
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });

  it("should return isError: true for non-Error values", () => {
    const result = handleToolError("something went wrong", RESOURCE, SCOPES);
    expect(result.isError).toBe(true);
  });
});

// ── handleToolError response structure ───────────────────────────────────────

describe("handleToolError response structure", () => {
  it("should return content array with a single text entry", () => {
    const error = new Error("something broke");
    const result = handleToolError(error, "https://api.example.com", ["read"]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("should include detailed troubleshooting for TokenExchangeError", () => {
    const error = new TokenExchangeError("Token exchange failed: 400", 400);
    const result = handleToolError(
      error,
      "https://www.googleapis.com/auth/gmail.readonly",
      ["https://www.googleapis.com/auth/gmail.readonly"]
    );

    expect(result.content[0].text).toContain("Possible fixes:");
    expect(result.content[0].text).toContain("resource:");
    expect(result.content[0].text).toContain("scope:");
  });

  it("should include error_description in troubleshooting when available", () => {
    const error = new TokenExchangeError(
      "Token exchange failed: 400",
      400,
      "Token has been revoked"
    );
    const result = handleToolError(error, "https://api.example.com", ["read"]);

    expect(result.content[0].text).toContain("Token has been revoked");
  });

  it("should prefix generic errors with ❌ Error:", () => {
    const error = new Error("Connection refused");
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(result.content[0].text).toMatch(/^❌ Error:/);
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
    const error = new TokenExchangeError(
      "Token exchange failed: 500 - Internal Server Error",
      500
    );
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
