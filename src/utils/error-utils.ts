/**
 * Error thrown when an upstream API returns 401 or 403.
 * Propagates through Promise.allSettled so formatAuthError can surface it.
 */
export class AuthenticationError extends Error {
  constructor(service: string, status: number) {
    super(`${service}: ${status === 401 ? "unauthorized" : "forbidden"} (${status})`);
    this.name = "AuthenticationError";
  }
}

/**
 * Extract error_description from a JSON error body embedded in a message string.
 * Keycard and OAuth providers return errors like:
 *   {"error":"invalid_grant","error_description":"Token has been revoked","requestId":"..."}
 * The user only needs the description, not the raw JSON or requestId.
 */
function extractErrorDescription(message: string): string | null {
  const jsonStart = message.search(/[{[]/);
  if (jsonStart === -1) return null;

  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as Record<string, unknown>;
    if (typeof parsed.error_description === "string") {
      return parsed.error_description;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Format authentication errors with actionable guidance.
 * Extracts error_description from JSON error bodies so the user sees
 * clean messages instead of raw JSON with requestIds.
 */
export function formatAuthError(serviceName: string, error: unknown): string {
  const errorMsg = error instanceof Error ? error.message : "Unknown error";

  // Check for common authentication errors
  if (errorMsg.includes("unauthorized") || errorMsg.includes("401")) {
    return `${serviceName}: Authentication failed — reauthorize to refresh grants`;
  }

  if (errorMsg.includes("forbidden") || errorMsg.includes("403")) {
    return `${serviceName}: Access denied — reauthorize to refresh grants`;
  }

  if (errorMsg.includes("token") || errorMsg.includes("auth")) {
    const desc = extractErrorDescription(errorMsg);
    return `${serviceName}: ${desc || errorMsg} — try reauthorizing`;
  }

  const desc = extractErrorDescription(errorMsg);
  return `${serviceName}: ${desc || errorMsg}`;
}

/**
 * Generate a footer with troubleshooting tips when there are errors
 */
export function getErrorFooter(hasAuthErrors: boolean): string {
  if (!hasAuthErrors) return "";

  return "\n\nReauthorize to refresh your grants. If issues persist, restart the MCP server.";
}
