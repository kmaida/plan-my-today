import type { AuthInfo } from "../types/auth";
import { JWTPayloadSchema } from "../types/auth";

export function extractUserIdFromAuthInfo(authInfo?: AuthInfo): string {
  if (!authInfo?.token) {
    throw new Error("No auth token available");
  }

  // Decode JWT (split by . and base64 decode middle part)
  const parts = authInfo.token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
  const parsed = JWTPayloadSchema.parse(payload);

  if (!parsed.sub) {
    throw new Error("JWT missing 'sub' claim");
  }

  return parsed.sub;
}
