import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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
 * Creates authentication middleware for protecting MCP endpoints.
 *
 * Delegates to the Keycard SDK's requireBearerAuth, which handles
 * JWT verification including array `aud` claims (RFC 7519 §4.1.3).
 *
 * @param requireBearerAuthImpl - The bearerAuth implementation from @keycardai/mcp
 * @param options - Configuration options for the middleware
 * @returns Express middleware function
 */
export function createAuthMiddleware(
  requireBearerAuthImpl: (config: {
    requiredScopes?: string[];
  }) => RequestHandler,
  options: AuthMiddlewareOptions = {}
): RequestHandler {
  const { requiredScopes = [] } = options;

  return requireBearerAuthImpl({
    requiredScopes,
  });
}
