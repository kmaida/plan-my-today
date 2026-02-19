import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { JWTOAuthTokenVerifier } from "@keycardai/mcp/server/auth/verifiers/jwt";
import { JWKSOAuthKeyring } from "@keycardai/oauth/keyring";
import type { RequestHandler } from "../types/index";

// Extend Express Request to include auth property
declare module "express-serve-static-core" {
  interface Request {
    /**
     * Authentication information added by Keycard auth middleware
     * Contains validated user and token information
     */
    auth?: AuthInfo;
  }
}

/**
 * Configuration options for authentication middleware
 */
export interface AuthMiddlewareOptions {
  /** Required OAuth scopes for accessing the MCP server */
  requiredScopes?: string[];
}

/**
 * Decodes a JWT payload without verification (for reading claims only).
 * Actual signature verification is handled by JWTOAuthTokenVerifier.
 */
function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format: expected 3 dot-separated parts");
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    );
  } catch (err) {
    throw new Error(
      `Failed to decode JWT claims: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Token verifier that wraps the Keycard SDK's JWTOAuthTokenVerifier to handle
 * the case where Keycard issues `aud` as an array of audience URIs.
 *
 * Per RFC 7519 §4.1.3, `aud` can be a string or an array. The SDK's default
 * verifier only handles the string case (`new URL(claims.aud)`), which produces
 * a garbage URL when `aud` is an array. This wrapper normalizes array `aud` by
 * picking the first audience that is a valid URL, which the bearer auth
 * middleware then matches against the request URL.
 *
 * TODO: Remove once the Keycard SDK handles array `aud` natively.
 */
class ArrayAudTokenVerifier {
  private inner: JWTOAuthTokenVerifier;

  constructor() {
    this.inner = new JWTOAuthTokenVerifier(new JWKSOAuthKeyring());
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const authInfo = await this.inner.verifyAccessToken(token);

    // If aud is a single string, the SDK already parsed it correctly
    const claims = decodeJwtClaims(token);
    if (!Array.isArray(claims.aud)) {
      return authInfo;
    }

    // aud is an array — pick the first entry that is a valid URL
    for (const entry of claims.aud) {
      try {
        authInfo.resource = new URL(entry);
        return authInfo;
      } catch {
        // Not a URL (e.g. a plain string audience) — skip
      }
    }

    // No valid URL found — clear resource so the middleware skips the check
    authInfo.resource = undefined;
    return authInfo;
  }
}

/**
 * Creates authentication middleware for protecting MCP endpoints.
 *
 * Delegates to the Keycard SDK's requireBearerAuth with a custom token verifier
 * that handles array `aud` claims (Keycard includes the userinfo endpoint
 * alongside the resource URI in the audience).
 *
 * @param requireBearerAuthImpl - The bearerAuth implementation from @keycardai/mcp
 * @param options - Configuration options for the middleware
 * @returns Express middleware function
 */
export function createAuthMiddleware(
  requireBearerAuthImpl: (config: {
    verifier?: OAuthTokenVerifier;
    requiredScopes?: string[];
  }) => RequestHandler,
  options: AuthMiddlewareOptions = {}
): RequestHandler {
  const { requiredScopes = [] } = options;

  return requireBearerAuthImpl({
    verifier: new ArrayAudTokenVerifier(),
    requiredScopes,
  });
}
