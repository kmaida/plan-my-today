import { z } from "zod/v3";
import { getLogger } from "../observability/logger";
import { keycardClient } from "../services/keycard-client";
import type { AuthenticatedToolHandlerWithArgs, McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";

const SLACK_RESOURCE = "https://slack.com/api";

/**
 * All Slack scopes used by the production tools.
 * The test requests a subset and probes each API to see which ones still work.
 */
const ALL_SLACK_SCOPES = [
  "search:read",
  "reactions:read",
  "users:read",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
] as const;

const DEFAULT_SUBSET = ["search:read", "users:read"];

const inputSchema = {
  scopeSubset: z
    .array(z.string())
    .describe(
      `Slack scopes to request (subset of: ${ALL_SLACK_SCOPES.join(", ")}). ` +
        `Default: ${DEFAULT_SUBSET.join(", ")}`
    )
    .optional(),
};

/** Shape of a Slack API probe result */
interface ApiProbeResult {
  api: string;
  requiredScope: string;
  status: "pass" | "fail";
  httpStatus: number;
  slackOk: boolean;
  slackError?: string;
  detail: string;
}

/**
 * Probe a single Slack API endpoint and return structured results.
 * Does not throw — failures are captured in the result.
 */
async function probeSlackApi(
  accessToken: string,
  endpoint: string,
  requiredScope: string,
  params?: Record<string, string>
): Promise<ApiProbeResult> {
  const url = new URL(`https://slack.com/api/${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      [key: string]: unknown;
    };

    return {
      api: endpoint,
      requiredScope,
      status: data.ok ? "pass" : "fail",
      httpStatus: response.status,
      slackOk: data.ok,
      slackError: data.error,
      detail: data.ok ? "API call succeeded" : `Slack error: ${data.error || "unknown"}`,
    };
  } catch (error) {
    return {
      api: endpoint,
      requiredScope,
      status: "fail",
      httpStatus: 0,
      slackOk: false,
      slackError: "fetch_failed",
      detail: `Fetch error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Registers the test-scoped-credentials tool for dogfooding Keycard scope behavior.
 *
 * This tool requests a subset of Slack scopes via Keycard token exchange,
 * then probes each Slack API to determine which ones the returned token can access.
 * The result shows whether Keycard actually narrows the credential to the requested scopes.
 *
 * @param mcpServer - The MCP server instance to register the tool with
 */
export function registerTestScopedCredentialsTool(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "test-scoped-credentials",
    {
      title: "Test Scoped Credentials (Keycard Dogfood)",
      description:
        "Dogfood test: request a subset of Slack scopes via Keycard and probe each API " +
        "to verify the returned token is truly task-scoped. Reports which APIs pass/fail " +
        "based on the scopes requested vs. granted.",
      inputSchema,
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dogfood test tool — auth, multi-API probe, report generation
    (async (args, { authInfo }) => {
      const scopeSubset: string[] | undefined = args.scopeSubset;
      if (!authInfo) {
        return {
          content: [
            {
              type: "text",
              text: "❌ No authentication information available. Please ensure you're properly authenticated.",
            },
          ],
        };
      }

      const requestedScopes = scopeSubset ?? DEFAULT_SUBSET;
      const logger = getLogger().withOperation("test_scoped_credentials");

      logger.info("Starting scoped credential test", {
        requestedScopes: requestedScopes.join(" "),
        allAvailableScopes: ALL_SLACK_SCOPES.join(" "),
      });

      try {
        // Step 1: Exchange token with only the requested scope subset
        const tokenResponse = await keycardClient.exchange(
          authInfo,
          SLACK_RESOURCE,
          requestedScopes
        );

        // Redact the access token for display (show first/last 4 chars)
        const token = tokenResponse.access_token;
        const redactedToken =
          token.length > 12 ? `${token.slice(0, 4)}...${token.slice(-4)}` : "[short token]";

        logger.info("Token exchange succeeded", {
          grantedScopes: tokenResponse.scope ?? "(not included in response)",
          issuedTokenType: tokenResponse.issued_token_type,
          tokenType: tokenResponse.token_type,
          expiresIn: tokenResponse.expires_in,
        });

        // Step 2: Probe each Slack API regardless of requested scopes
        const probeResults: ApiProbeResult[] = await Promise.all([
          probeSlackApi(token, "auth.test", "(basic)"),
          probeSlackApi(token, "search.messages", "search:read", {
            query: "test",
            count: "1",
          }),
          probeSlackApi(token, "users.info", "users:read", {
            user: "USLACKBOT",
          }),
          probeSlackApi(token, "reactions.list", "reactions:read", {
            limit: "1",
          }),
          probeSlackApi(token, "conversations.list", "channels:read", {
            limit: "1",
            types: "public_channel",
          }),
        ]);

        // Step 3: Build the report
        const requestedSet = new Set(requestedScopes);
        const grantedSet = tokenResponse.scope ? new Set(tokenResponse.scope.split(" ")) : null;

        const lines: string[] = [
          "# 🔬 Keycard Scoped Credential Test Results\n",
          "## Token Exchange",
          `- **Requested scopes:** \`${requestedScopes.join(" ")}\``,
          `- **Granted scopes:** \`${tokenResponse.scope ?? "(not in response)"}\``,
          `- **Token type:** ${tokenResponse.token_type}`,
          `- **Issued token type:** ${tokenResponse.issued_token_type}`,
          `- **Expires in:** ${tokenResponse.expires_in}s`,
          `- **Token (redacted):** ${redactedToken}`,
          "",
          "## Scope Comparison",
        ];

        if (grantedSet) {
          const missing = requestedScopes.filter((s) => !grantedSet.has(s));
          const extra = [...grantedSet].filter((s) => !requestedSet.has(s));

          if (missing.length === 0 && extra.length === 0) {
            lines.push("✅ **Granted scopes exactly match requested scopes**");
          } else {
            if (missing.length > 0) {
              lines.push(
                `⚠️ **Missing scopes** (requested but not granted): \`${missing.join(" ")}\``
              );
            }
            if (extra.length > 0) {
              lines.push(`⚠️ **Extra scopes** (granted but not requested): \`${extra.join(" ")}\``);
            }
          }
        } else {
          lines.push("⚠️ Keycard did not include a `scope` field in the response");
        }

        lines.push("", "## API Probe Results", "");
        lines.push("| API | Required Scope | In Request? | Status | HTTP | Slack Error |");
        lines.push("|-----|---------------|-------------|--------|------|-------------|");

        for (const result of probeResults) {
          const inRequest =
            result.requiredScope === "(basic)" || requestedSet.has(result.requiredScope)
              ? "✅ Yes"
              : "❌ No";
          const statusEmoji = result.status === "pass" ? "✅" : "❌";
          lines.push(
            `| ${result.api} | ${result.requiredScope} | ${inRequest} | ${statusEmoji} ${result.status} | ${result.httpStatus} | ${result.slackError ?? "-"} |`
          );
        }

        // Step 4: Summary verdict
        lines.push("", "## Verdict", "");

        const outOfScopeResults = probeResults.filter(
          (r) => r.requiredScope !== "(basic)" && !requestedSet.has(r.requiredScope)
        );
        const outOfScopePassed = outOfScopeResults.filter((r) => r.status === "pass");
        const inScopeResults = probeResults.filter(
          (r) => r.requiredScope === "(basic)" || requestedSet.has(r.requiredScope)
        );
        const inScopeFailed = inScopeResults.filter((r) => r.status === "fail");

        if (outOfScopePassed.length === 0 && inScopeFailed.length === 0) {
          lines.push(
            "🎉 **PASS — Task-scoped credentials work!** In-scope APIs succeeded, out-of-scope APIs were blocked."
          );
        } else if (outOfScopePassed.length > 0) {
          lines.push(
            `⚠️ **Scope narrowing NOT enforced.** ${outOfScopePassed.length} out-of-scope API(s) succeeded: ${outOfScopePassed.map((r) => r.api).join(", ")}`
          );
        }
        if (inScopeFailed.length > 0) {
          lines.push(
            `❌ **In-scope API(s) failed unexpectedly:** ${inScopeFailed.map((r) => `${r.api} (${r.slackError})`).join(", ")}`
          );
        }

        const output = lines.join("\n");

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error) {
        return handleToolError(error, SLACK_RESOURCE, requestedScopes);
      }
    }) satisfies AuthenticatedToolHandlerWithArgs<typeof inputSchema>
  );
}
