import { TokenExchangeError } from "../services/keycard-client";

/**
 * Error thrown when an upstream API returns 401 or 403.
 * Propagates through Promise.allSettled so formatAuthError can surface it.
 */
export class AuthenticationError extends Error {
  readonly status: number;

  constructor(service: string, status: number) {
    super(`${service}: ${status === 401 ? "unauthorized" : "forbidden"} (${status})`);
    this.name = "AuthenticationError";
    this.status = status;
  }
}

/**
 * Format errors into clean, user-facing messages for the reauth banner.
 *
 * Uses `instanceof` checks on typed error classes — no string matching.
 * Raw error messages from Keycard and upstream providers can contain
 * internal details (user IDs, resource URLs, scopes) that must never
 * be shown to end users.
 */
export function formatAuthError(serviceName: string, error: unknown): string {
  // TokenExchangeError — from keycard-client when token exchange fails.
  // Never use error.description directly — Keycard puts user IDs, resource
  // URLs, and scopes in error_description. Only surface descriptions that
  // are short and don't contain internal identifiers.
  if (error instanceof TokenExchangeError) {
    const desc = error.description;
    const isSafe = desc && desc.length < 60 && !desc.includes("for user ");
    return `${serviceName}: ${isSafe ? desc : "Token exchange failed"}; please reauthorize`;
  }

  // AuthenticationError — from upstream API calls (401/403).
  // Already has structured status code, no need to inspect message text.
  if (error instanceof AuthenticationError) {
    if (error.status === 401) {
      return `${serviceName}: Authentication failed — reauthorize to refresh grants`;
    }
    return `${serviceName}: Access denied — reauthorize to refresh grants`;
  }

  // Unknown error type — use a safe generic message.
  // Never expose raw error.message which may contain user IDs or internal URLs.
  return `${serviceName}: Service unavailable — try again later`;
}
