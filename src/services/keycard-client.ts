import { OAuthError, TokenExchangeClient } from "@keycardai/oauth";
import type { TokenResponse } from "@keycardai/oauth";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "../config";

export type { TokenResponse } from "@keycardai/oauth";

/**
 * Error thrown when a Keycard token exchange fails.
 * Carries structured data so formatAuthError can produce clean user-facing
 * messages without string matching or leaking internal details.
 */
export class TokenExchangeError extends Error {
  /** HTTP status from Keycard (e.g. 400, 500, 502), or undefined for non-HTTP failures. */
  readonly status?: number;
  /** Extracted error_description from a JSON error body, if available. */
  readonly description?: string;

  constructor(message: string, status?: number, description?: string) {
    super(message);
    this.name = "TokenExchangeError";
    this.status = status;
    this.description = description;
  }
}

/**
 * SDK-backed token exchange client (singleton).
 *
 * Uses OAuth discovery (.well-known/oauth-authorization-server) to find the
 * token endpoint, and Basic Auth for client credentials. Discovery result is
 * cached for the lifetime of this instance.
 */
const tokenExchangeClient = new TokenExchangeClient(config.keycardIssuerUrl, {
  clientId: config.keycardClientId,
  clientSecret: config.keycardClientSecret,
});

/**
 * Exchange a user's Keycard token for a resource-specific access token.
 *
 * Uses RFC 8693 token exchange via the Keycard SDK's TokenExchangeClient.
 * Throws TokenExchangeError on failure to preserve the existing error
 * handling contract (instanceof-based detection in tool-error-utils and
 * error-utils).
 *
 * @param authInfo - User's auth info from the MCP session (contains the Keycard token)
 * @param resource - Target resource URI (e.g., "https://www.googleapis.com/calendar/v3")
 * @param scopes - Optional OAuth scopes (e.g., ["https://www.googleapis.com/auth/calendar.readonly"])
 */
export async function exchangeToken(
  authInfo: AuthInfo,
  resource: string,
  scopes?: string[]
): Promise<TokenResponse> {
  try {
    return await tokenExchangeClient.exchangeToken({
      subjectToken: authInfo.token,
      resource,
      scope: scopes?.join(" "),
    });
  } catch (error) {
    // SDK v0.2.0 throws OAuthError for structured STS error responses
    // (has errorCode like "invalid_grant" and message from error_description).
    // Falls back to plain Error for non-JSON responses.
    if (error instanceof OAuthError) {
      throw new TokenExchangeError(
        `Token exchange failed: ${error.errorCode}`,
        undefined,
        error.message
      );
    }
    // Non-JSON failures (e.g. 502 from a proxy): SDK embeds HTTP status in
    // error.message ("Token exchange failed (HTTP 502)") but doesn't expose it
    // as a structured field. Downstream logs will show status: undefined — grep
    // by message text instead.
    const message = error instanceof Error ? error.message : String(error);
    throw new TokenExchangeError(message);
  }
}
