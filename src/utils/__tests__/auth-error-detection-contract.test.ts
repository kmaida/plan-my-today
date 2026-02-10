/**
 * Auth error detection contract tests
 *
 * These tests verify that error messages produced by the server-side error
 * utilities (handleToolError, formatAuthError, KeycardClient) are detectable by
 * the UI's AUTH_ERROR_PATTERNS used in ChatPanel.extractAuthErrors().
 *
 * This is the exact class of bug we hit in production: the chatbot called
 * list-gmail-todos directly (not list-all-tasks-today), the tool returned an
 * auth error, but the UI didn't show the reauth banner because the error
 * text wasn't being scanned for auth patterns.
 *
 * If someone changes the error text format in any of these functions, this
 * test will fail — preventing a silent disconnect between server errors and
 * UI detection.
 */

import { handleToolError } from "../tool-error-utils";
import { formatAuthError, AuthenticationError } from "../error-utils";

// ── Mirror of the UI's AUTH_ERROR_PATTERNS from ChatPanel.tsx ──
// This is intentionally duplicated (not imported) to catch drift in EITHER direction.
// If the server changes its error format, the test fails here.
// If the UI changes its patterns, someone must update this test too.
const AUTH_ERROR_PATTERNS = [
  "unauthorized",
  "invalid_grant",
  "not allowed to exchange token",
  "token exchange failed",
  "authentication failed",
  "access denied",
  "reauthoriz",
  "401",
  "403",
  "forbidden",
];

/** Check whether at least one AUTH_ERROR_PATTERN matches the text (case-insensitive). */
function wouldUIDetect(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((p) => lower.includes(p));
}

// ── handleToolError (used by individual source tools: gmail, linear, etc.) ──

describe("handleToolError → UI detection contract", () => {
  const RESOURCE = "https://www.googleapis.com/auth/gmail.readonly";
  const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

  it("should produce detectable output for invalid_grant errors", () => {
    const error = new Error('{"error":"invalid_grant","error_description":"Token has been revoked"}');
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });

  it("should produce detectable output for 'not allowed to exchange token' errors", () => {
    const error = new Error("Client is not allowed to exchange token for this resource");
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });

  it("should produce detectable output for generic 401 errors", () => {
    // Non-grant errors pass through as "❌ Error: <message>" — the message
    // itself must contain a detectable pattern for the UI to catch it.
    const error = new Error("Request failed with status 401");
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });

  it("should produce detectable output for generic 403 errors", () => {
    const error = new Error("Request failed with status 403");
    const result = handleToolError(error, RESOURCE, SCOPES);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });
});

// ── KeycardClient error format (thrown by keycard-client.ts, caught by tools) ──

describe("KeycardClient error format → UI detection contract", () => {
  // KeycardClient throws: `Token exchange failed: ${status} - ${body}`
  // This flows through handleToolError's generic path (❌ Error: <message>)

  it("should be detectable when Keycard returns 500", () => {
    const error = new Error("Token exchange failed: 500 - Internal Server Error");
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });

  it("should be detectable when Keycard returns 400 with invalid_grant", () => {
    const error = new Error('Token exchange failed: 400 - {"error":"invalid_grant"}');
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });

  it("should be detectable when Keycard returns 502 Bad Gateway", () => {
    const error = new Error("Token exchange failed: 502 - Bad Gateway");
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });

  it("should be detectable when Keycard issuer URL is missing", () => {
    const error = new Error("Token exchange failed: missing Keycard issuer URL");
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(wouldUIDetect(result.content[0].text)).toBe(true);
  });
});

// ── formatAuthError (used by list-all-tasks-today for per-source errors) ──

describe("formatAuthError → UI detection contract", () => {
  it("should produce detectable output for 401 AuthenticationError", () => {
    const error = new AuthenticationError("Gmail", 401);
    const text = formatAuthError("Gmail", error);
    expect(wouldUIDetect(text)).toBe(true);
  });

  it("should produce detectable output for 403 AuthenticationError", () => {
    const error = new AuthenticationError("Linear", 403);
    const text = formatAuthError("Linear", error);
    expect(wouldUIDetect(text)).toBe(true);
  });

  it("should produce detectable output for token-related errors", () => {
    const error = new Error("token has expired");
    const text = formatAuthError("Google Calendar", error);
    expect(wouldUIDetect(text)).toBe(true);
  });

  it("should produce detectable output for auth-related errors", () => {
    const error = new Error("authentication required");
    const text = formatAuthError("GitHub", error);
    expect(wouldUIDetect(text)).toBe(true);
  });
});

// ── Negative cases: non-auth errors should NOT be detected ──

describe("non-auth errors should not trigger false positives", () => {
  it("should NOT detect a rate-limit error as auth", () => {
    const error = new Error("Rate limit exceeded, retry after 30s");
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(wouldUIDetect(result.content[0].text)).toBe(false);
  });

  it("should NOT detect a timeout error as auth", () => {
    const error = new Error("Request timed out after 30000ms");
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(wouldUIDetect(result.content[0].text)).toBe(false);
  });

  it("should NOT detect a network error as auth", () => {
    const error = new Error("ECONNREFUSED 127.0.0.1:8080");
    const result = handleToolError(error, "https://api.example.com", ["read"]);
    expect(wouldUIDetect(result.content[0].text)).toBe(false);
  });
});
