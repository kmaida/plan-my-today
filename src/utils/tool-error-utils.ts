/**
 * Shared error handling for MCP tool catch blocks.
 *
 * Most tools have the same pattern: detect invalid_grant / token-exchange
 * failures and return a structured MCP error response with resource/scope
 * troubleshooting info. This extracts that ~30-line block into one call.
 */

type ToolErrorResponse = {
  content: [{ type: "text"; text: string }];
};

/**
 * Build a structured MCP error response from a caught error.
 *
 * For token-exchange failures (invalid_grant, STS rejection), returns
 * detailed troubleshooting with the resource URLs and scopes involved.
 * For everything else, returns a generic error message.
 */
export function handleToolError(
  error: unknown,
  resources: string | string[],
  scopes: string[] | string[][],
  extraHints?: string[]
): ToolErrorResponse {
  const message = error instanceof Error ? error.message : "Unknown error";
  const normalizedMessage = message.toLowerCase();
  const isInvalidGrant =
    normalizedMessage.includes("invalid_grant") ||
    normalizedMessage.includes("not allowed to exchange token");

  if (isInvalidGrant) {
    const resourceList = Array.isArray(resources) ? resources : [resources];
    const scopeList = Array.isArray(scopes[0]) ? (scopes as string[][]) : [scopes as string[]];

    const lines: string[] = [
      `❌ Error: ${message}`,
      "",
      "Possible fixes:",
      "- Verify KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET are set for this server.",
      "- Confirm the Keycard client is allowed to exchange tokens for:",
    ];

    for (let i = 0; i < resourceList.length; i++) {
      lines.push(`  resource: ${resourceList[i]}`);
      if (scopeList[i]) {
        lines.push(`  scope: ${scopeList[i].join(" ")}`);
      }
    }

    if (extraHints) {
      for (const hint of extraHints) {
        lines.push(`- ${hint}`);
      }
    }

    lines.push(
      "- Ensure the STS issuer/zone matches the one that issued your MCP token."
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return { content: [{ type: "text", text: `❌ Error: ${message}` }] };
}
