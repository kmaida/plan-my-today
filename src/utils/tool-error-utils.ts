/**
 * Shared error handling for MCP tool catch blocks.
 *
 * Most tools have the same pattern: detect token-exchange failures and
 * return a structured MCP error response with troubleshooting info.
 * Uses instanceof checks on typed error classes — no string matching.
 */

import { TokenExchangeError } from "../services/keycard-client";

type ToolErrorResponse = {
  content: [{ type: "text"; text: string }];
  isError: true;
};

/**
 * Build a structured MCP error response from a caught error.
 *
 * For TokenExchangeError (from KeycardClient), returns detailed
 * troubleshooting with the resource URLs and scopes involved.
 * For everything else, returns a generic error message.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: classifies errors by type for user-friendly messages
export function handleToolError(
  error: unknown,
  resources: string | string[],
  scopes: string[] | string[][],
  extraHints?: string[]
): ToolErrorResponse {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (error instanceof TokenExchangeError) {
    const resourceList = Array.isArray(resources) ? resources : [resources];
    const scopeList = Array.isArray(scopes[0]) ? (scopes as string[][]) : [scopes as string[]];

    const lines: string[] = [
      `❌ Token exchange failed${error.description ? `: ${error.description}` : ""}`,
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

    lines.push("- Ensure the Keycard issuer/zone matches the one that issued your MCP token.");

    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }

  return { content: [{ type: "text", text: `❌ Error: ${message}` }], isError: true };
}
