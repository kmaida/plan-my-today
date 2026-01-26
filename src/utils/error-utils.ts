/**
 * Format authentication errors with actionable guidance
 */
export function formatAuthError(serviceName: string, error: unknown): string {
  const errorMsg = error instanceof Error ? error.message : "Unknown error";

  // Check for common authentication errors
  if (errorMsg.includes("unauthorized") || errorMsg.includes("401")) {
    return `${serviceName}: Authentication failed - Run 'check-auth' tool and re-authorize in Keycard`;
  }

  if (errorMsg.includes("forbidden") || errorMsg.includes("403")) {
    return `${serviceName}: Access denied - Check permissions in Keycard`;
  }

  if (errorMsg.includes("token") || errorMsg.includes("auth")) {
    return `${serviceName}: ${errorMsg} - Run 'check-auth' tool to verify connection`;
  }

  return `${serviceName}: ${errorMsg}`;
}

/**
 * Generate a footer with troubleshooting tips when there are errors
 */
export function getErrorFooter(hasAuthErrors: boolean): string {
  if (!hasAuthErrors) return "";

  return "\n\n💡 **Troubleshooting Authentication Issues:**\n" +
    "1. Run the 'check-auth' tool to see which services are disconnected\n" +
    "2. Go to https://keycard.cloud and re-authorize any disconnected services\n" +
    "3. Restart Claude Desktop to refresh the connection\n" +
    "4. If issues persist, restart the MCP server";
}
