import type { TokenResponse } from "@keycardai/oauth";
import {
  fetchAuthorizationServerMetadata,
  OAuthError,
  TokenExchangeClient,
} from "@keycardai/oauth";
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
 * Cached promise for the authorization server's token_endpoint.
 *
 * Memoised at module scope so concurrent callers share a single discovery
 * fetch — mirrors the per-instance promise-lock pattern inside
 * TokenExchangeClient. Cleared on rejection so a transient discovery failure
 * (e.g. DNS blip at boot) doesn't poison every subsequent request.
 */
let tokenEndpointPromise: Promise<string> | null = null;

/**
 * Resolve the Keycard authorization server's token_endpoint via RFC 8414
 * discovery (.well-known/oauth-authorization-server). Cached for the lifetime
 * of the process on success; errors are not cached.
 *
 * Used by the UI auth proxy in server.ts for the OAuth 2.0 authorization_code
 * grant — the SDK does not expose an authorization_code client, so this is
 * the minimum primitive we need to avoid hardcoding the endpoint path.
 */
export async function getTokenEndpoint(): Promise<string> {
  if (!tokenEndpointPromise) {
    tokenEndpointPromise = (async () => {
      try {
        const metadata = await fetchAuthorizationServerMetadata(config.keycardIssuerUrl);
        if (!metadata.token_endpoint) {
          throw new Error(
            `Keycard issuer "${config.keycardIssuerUrl}" does not advertise a token_endpoint in its OAuth metadata`
          );
        }
        return metadata.token_endpoint;
      } catch (err) {
        tokenEndpointPromise = null; // don't cache failures
        throw err;
      }
    })();
  }
  return tokenEndpointPromise;
}

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
