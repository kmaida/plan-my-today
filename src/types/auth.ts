import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod/v3";

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

// Re-export AuthInfo for use in other modules
export type { AuthInfo };

export const JWTPayloadSchema = z
  .object({
    sub: z.string().optional(),
    iss: z.string().optional(),
    aud: z.string().optional(),
    client_id: z.string().optional(),
    exp: z.number().positive().optional(),
    iat: z.number().positive().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export const SessionIdHeaderSchema = z.string().min(1);

export type JWTPayload = z.infer<typeof JWTPayloadSchema>;

/**
 * Tool handler for tools without arguments
 */
export interface AuthenticatedToolHandlerNoArgs {
  authInfo?: AuthInfo;
}

/**
 * Tool handler for tools with arguments
 * @template Args - The Zod schema shape for the tool arguments
 */
export type AuthenticatedToolHandlerWithArgs<Args extends import("zod/v3").ZodRawShape> = (
  args: import("zod/v3").z.objectOutputType<Args, import("zod/v3").ZodTypeAny>,
  extra: { authInfo?: AuthInfo }
) =>
  | import("@modelcontextprotocol/sdk/types.js").CallToolResult
  | Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>;

export function getSessionIdFromHeaders(headers: Record<string, unknown>): string | undefined {
  const sessionId = headers["mcp-session-id"];
  try {
    return SessionIdHeaderSchema.parse(sessionId);
  } catch {
    return undefined;
  }
}
