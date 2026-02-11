import { createRequire } from "node:module";
import type { RequestHandler, AuthInfo } from "../types/index";

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

// --------------------------------------------------------------------------
// Custom verifier wrapper that handles array `aud` claims.
//
// The upstream @keycardlabs/mcp-oauth JWTOAuthTokenVerifier does
//   `resource: new URL(jsonPayload.aud)`
// which silently mangles array audiences into a comma-joined URL string.
// We wrap the default verifier so that when `aud` is an array, `resource`
// is set to the first entry (the MCP resource URL).
//
// The comma-detection is a safe no-op once the library ships the fix —
// a correct `resource` won't contain commas, so the wrapper becomes a
// passthrough. Safe to remove this entire block after the fix lands in
// @keycardlabs/mcp-oauth and we bump the dependency.
// --------------------------------------------------------------------------

interface TokenVerifier {
  verifyAccessToken(token: string): Promise<{
    token: string;
    clientId: string;
    resource: URL;
    scopes: string[];
    expiresAt: number;
  }>;
}

function createArrayAudVerifier(): TokenVerifier {
  // FRAGILE WORKAROUND: Reaches into @keycardlabs/mcp-oauth internals via
  // relative path because JWKSOAuthKeyring isn't in the package's exports map.
  // This WILL break if the library restructures its internal files.
  // TODO: Remove once upstream exposes JWKSOAuthKeyring in its public API
  //       or fixes the array `aud` mangling in JWTOAuthTokenVerifier.
  const innerRequire = createRequire(
    require.resolve("@keycardlabs/mcp-oauth/server/auth/verifiers/jwt"),
  );
  const { JWKSOAuthKeyring } = innerRequire("../../../shared/keyring.js");
  const { JWTOAuthTokenVerifier } = innerRequire("./jwt.js");

  const inner: TokenVerifier = new JWTOAuthTokenVerifier(new JWKSOAuthKeyring());

  return {
    async verifyAccessToken(token: string) {
      const result = await inner.verifyAccessToken(token);

      // Detect the mangled comma-joined URL produced by `new URL([...])`.
      // If the resource href contains a comma it was almost certainly an
      // array audience — re-parse the first element instead.
      if (result.resource && result.resource.href.includes(',')) {
        const firstAud = result.resource.href.split(',')[0];
        result.resource = new URL(firstAud);
      }

      return result;
    },
  };
}

/**
 * Creates authentication middleware for protecting MCP endpoints
 *
 * @param requireBearerAuthImpl - The bearerAuth implementation (passed to avoid complex imports)
 * @param options - Configuration options for the middleware
 * @returns Express middleware function
 */
export function createAuthMiddleware(
  requireBearerAuthImpl: (config: { verifier?: TokenVerifier; requiredScopes: string[] }) => RequestHandler,
  options: AuthMiddlewareOptions = {}
): RequestHandler {
  const { requiredScopes = [] } = options;

  return requireBearerAuthImpl({
    verifier: createArrayAudVerifier(),
    requiredScopes,
  });
}