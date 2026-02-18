import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "../config";
import { getLogger } from "../observability/logger";
import { parseJWTPayload } from "../types/index";
import { decodeJWT } from "../utils/auth-utils";

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
 * Parse an error_description from a Keycard JSON error response body.
 * Keycard returns: {"error":"invalid_grant","error_description":"Token has been revoked","requestId":"..."}
 */
function parseKeycardErrorDescription(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.error_description === "string") {
      return parsed.error_description;
    }
  } catch {
    // Not JSON
  }
  return undefined;
}

export interface TokenExchangeResponse {
  access_token: string;
  issued_token_type: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export class KeycardClient {
  private keycardBaseUrl: string;
  private clientId: string;
  private clientSecret: string;

  constructor() {
    this.keycardBaseUrl = config.keycardIssuerUrl;
    this.clientId = config.keycardClientId;
    this.clientSecret = config.keycardClientSecret;
  }

  private getIssuerFromAuthInfo(authInfo: AuthInfo): string | undefined {
    const fromExtra = parseJWTPayload(authInfo.extra)?.iss;
    if (fromExtra) {
      return fromExtra;
    }

    if (!authInfo.token) {
      return undefined;
    }

    return decodeJWT(authInfo.token)?.iss;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scope verification adds branching after the core exchange logic
  async exchange(
    authInfo: AuthInfo,
    resource: string,
    scopes?: readonly string[]
  ): Promise<TokenExchangeResponse> {
    const keycardBaseUrl = this.keycardBaseUrl || this.getIssuerFromAuthInfo(authInfo);
    if (!keycardBaseUrl) {
      throw new TokenExchangeError("Token exchange failed: missing Keycard issuer URL");
    }

    const params = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: authInfo.token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: resource,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    if (scopes?.length) {
      params.set("scope", scopes.join(" "));
    }

    const requestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    } satisfies RequestInit;

    const tokenUrl = `${keycardBaseUrl}/oauth/2/token`;

    let response = await fetch(tokenUrl, requestInit);
    if (response.status === 404) {
      const fallbackUrl = `${keycardBaseUrl}/oauth/token`;
      response = await fetch(fallbackUrl, requestInit);
    }

    if (!response.ok) {
      const body = await response.text();
      const description = parseKeycardErrorDescription(body);
      throw new TokenExchangeError(
        `Token exchange failed: ${response.status} - ${body}`,
        response.status,
        description
      );
    }

    const result = (await response.json()) as TokenExchangeResponse;

    // Log scope verification: compare what we requested vs. what Keycard granted
    if (scopes?.length) {
      const logger = getLogger().withOperation("token_exchange");
      const requested = new Set(scopes);
      const granted = result.scope ? new Set(result.scope.split(" ")) : undefined;

      if (!granted) {
        logger.debug("Keycard response omitted scope field", {
          resource,
          requestedScopes: scopes.join(" "),
        });
      } else {
        const missing = [...requested].filter((s) => !granted.has(s));
        const extra = [...granted].filter((s) => !requested.has(s));
        if (missing.length > 0 || extra.length > 0) {
          logger.warn("Keycard granted different scopes than requested", {
            resource,
            requestedScopes: scopes.join(" "),
            grantedScopes: result.scope,
            missingScopes: missing.length > 0 ? missing.join(" ") : undefined,
            extraScopes: extra.length > 0 ? extra.join(" ") : undefined,
          });
        } else {
          logger.debug("Scope verification passed", {
            resource,
            scopes: result.scope,
          });
        }
      }
    }

    return result;
  }
}

// Singleton instance
export const keycardClient = new KeycardClient();
