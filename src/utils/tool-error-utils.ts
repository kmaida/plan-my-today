/**
 * Shared error handling for MCP tool catch blocks.
 *
 * Most tools have the same pattern: detect token-exchange failures and
 * return a structured MCP error response. Uses instanceof checks on
 * typed error classes — no string matching.
 *
 * For TokenExchangeError, returns a user/LLM-facing message and logs
 * developer details (resource URLs, scopes, hints) server-side. The UI
 * uses the MCP `isError` flag (a boolean) to show the reauth banner —
 * no text parsing required.
 */

import { getLogger } from "../observability/logger";
import { TokenExchangeError } from "../services/keycard-client";

type ToolErrorResponse = {
  content: [{ type: "text"; text: string }];
  isError: true;
};

/**
 * Build a structured MCP error response from a caught error.
 *
 * For TokenExchangeError, returns a clean user-facing message that
 * guides the LLM to suggest reauthorization. Developer details (resource
 * URLs, scopes, hints) are logged server-side where they belong.
 *
 * For everything else, returns a generic error message.
 */
export function handleToolError(
  error: unknown,
  resources: string | string[],
  _scopes: string[] | string[][],
  extraHints?: string[]
): ToolErrorResponse {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (error instanceof TokenExchangeError) {
    const resourceList = Array.isArray(resources) ? resources : [resources];

    // Log developer details server-side for debugging
    getLogger()
      .withOperation("tool_error")
      .warn("Token exchange failed", {
        description: error.description,
        status: error.status,
        resources: resourceList.join(", "),
        hints: extraHints?.join("; "),
      });

    return {
      content: [
        {
          type: "text",
          text: '❌ Authorization failed for this source. The user\'s grant may have expired or been revoked. Suggest the user click "Reauthorize" in the dashboard to refresh their grants.',
        },
      ],
      isError: true,
    };
  }

  // Log raw error server-side; return a clean message to the LLM.
  // Raw error.message can contain stack traces, connection strings, or
  // internal URLs — none of which should reach the UI or confuse the LLM.
  getLogger().withOperation("tool_error").error("Tool call failed", { message });

  return {
    content: [
      {
        type: "text",
        text: "❌ This source encountered an unexpected error. The user may want to try again or check the server logs for details.",
      },
    ],
    isError: true,
  };
}
