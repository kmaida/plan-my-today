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
 * Extracts zone ID from Keycard issuer URL
 * @param issuerUrl - Full Keycard issuer URL (e.g., https://z123.keycard.cloud)
 * @returns Zone ID (e.g., "z123") or empty string if not found
 */
export function extractZoneId(issuerUrl: string): string {
  const match = issuerUrl.match(/https:\/\/([^.]+)\.keycard\.cloud/);
  return match ? match[1] : '';
}

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
