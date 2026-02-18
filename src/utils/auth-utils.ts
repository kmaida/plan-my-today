import type { JWTPayload } from "../types/auth";
import { parseJWTPayload } from "../types/auth";

/**
 * Decodes a JWT token and returns the parsed payload
 * Handles base64 padding automatically
 *
 * @param token - JWT token string
 * @returns Parsed JWT payload or null if invalid
 */
export function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Add base64 padding if needed
    const payloadBase64 = parts[1];
    const paddedPayload = payloadBase64 + "=".repeat((4 - (payloadBase64.length % 4)) % 4);
    const decodedPayload = JSON.parse(Buffer.from(paddedPayload, "base64").toString("utf8"));

    return parseJWTPayload(decodedPayload);
  } catch {
    return null;
  }
}
