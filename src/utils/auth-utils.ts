import type { AuthInfo, JWTPayload } from "../types/auth";
import { JWTPayloadSchema, parseJWTPayload } from "../types/auth";

/**
 * Decodes a JWT token and returns the parsed payload
 * Handles base64 padding automatically
 *
 * @param token - JWT token string
 * @returns Parsed JWT payload or null if invalid
 */
export function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Add base64 padding if needed
    const payloadBase64 = parts[1];
    const paddedPayload = payloadBase64 + '='.repeat((4 - payloadBase64.length % 4) % 4);
    const decodedPayload = JSON.parse(
      Buffer.from(paddedPayload, 'base64').toString('utf8')
    );

    return parseJWTPayload(decodedPayload);
  } catch {
    return null;
  }
}

/**
 * Extracts the user ID from authentication info by decoding the JWT token
 *
 * @param authInfo - Authentication information containing the JWT token
 * @returns User ID from the JWT 'sub' claim
 * @throws Error if no token is available, JWT is invalid, or 'sub' claim is missing
 */
export function extractUserIdFromAuthInfo(authInfo?: AuthInfo): string {
  if (!authInfo?.token) {
    throw new Error("No auth token available");
  }

  const parsed = decodeJWT(authInfo.token);
  if (!parsed) {
    throw new Error("Invalid JWT format");
  }

  if (!parsed.sub) {
    throw new Error("JWT missing 'sub' claim");
  }

  return parsed.sub;
}
