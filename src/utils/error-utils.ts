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
 * Format authentication errors with actionable guidance
 */
export function formatAuthError(serviceName: string, error: unknown): string {
  const errorMsg = error instanceof Error ? error.message : "Unknown error";

  // Check for common authentication errors
  if (errorMsg.includes("unauthorized") || errorMsg.includes("401")) {
    return `${serviceName}: Authentication failed — sign out and sign back in to refresh grants`;
  }

  if (errorMsg.includes("forbidden") || errorMsg.includes("403")) {
    return `${serviceName}: Access denied — sign out and sign back in to refresh grants`;
  }

  if (errorMsg.includes("token") || errorMsg.includes("auth")) {
    return `${serviceName}: ${errorMsg} — try signing out and signing back in`;
  }

  return `${serviceName}: ${errorMsg}`;
}

/**
 * Generate a footer with troubleshooting tips when there are errors
 */
export function getErrorFooter(hasAuthErrors: boolean): string {
  if (!hasAuthErrors) return "";

  return "\n\nSign out and sign back in to refresh your grants. If issues persist, restart the MCP server.";
}
