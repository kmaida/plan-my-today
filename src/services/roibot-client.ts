import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config";
import { getLogger } from "../observability/logger";
import { exchangeToken, TokenExchangeError } from "./keycard-client";

const logger = getLogger();

/**
 * Error thrown when a ROIbot delegation call fails.
 */
export class ROIbotClientError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "ROIbotClientError";
    this.cause = cause;
  }
}

/**
 * Exchange the user's Keycard token for a ROIbot-scoped token.
 *
 * Uses RFC 8693 token exchange: the user's subject token (audienced to PMT)
 * is exchanged for a new token audienced to ROIbot's MCP endpoint resource.
 * This is the Keycard multi-agent delegation pattern — the STS validates
 * the user's identity and issues a token that ROIbot will accept.
 */
async function exchangeForROIbotToken(authInfo: AuthInfo): Promise<string> {
  const endpoint = config.roibotMcpEndpoint;
  if (!endpoint) {
    throw new ROIbotClientError(
      "ROIBOT_MCP_ENDPOINT not configured. " +
        "Set this to ROIbot's registered Keycard resource URI (e.g., https://event-roi-mcp.fly.dev/mcp)"
    );
  }

  try {
    const response = await exchangeToken(authInfo, endpoint);
    return response.accessToken;
  } catch (err) {
    if (err instanceof TokenExchangeError) {
      throw new ROIbotClientError(
        `Failed to exchange token for ROIbot: ${err.description || err.message}`,
        err
      );
    }
    throw new ROIbotClientError(
      "Unexpected error exchanging token for ROIbot",
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * Create a connected MCP client to ROIbot's MCP server.
 *
 * This uses the same StreamableHTTPClientTransport pattern as the UI's
 * MCPClientContext, but runs server-side with a Keycard-exchanged token
 * scoped to ROIbot's audience.
 *
 * Caller is responsible for closing the client when done.
 */
async function createROIbotClient(authInfo: AuthInfo): Promise<Client> {
  const endpoint = config.roibotMcpEndpoint;
  if (!endpoint) {
    throw new ROIbotClientError("ROIBOT_MCP_ENDPOINT not configured");
  }

  const roibotToken = await exchangeForROIbotToken(authInfo);

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${roibotToken}`,
      },
    },
  });

  const client = new Client({
    name: "plan-my-today",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    logger.info("[roibot-client] Connected to ROIbot MCP server");
    return client;
  } catch (err) {
    throw new ROIbotClientError(
      `Failed to connect to ROIbot at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * List available tools from ROIbot's MCP server.
 *
 * Creates a temporary connection, fetches the tool list, and disconnects.
 * Useful for discovering what ROIbot can do before deciding which tool to call.
 */
export async function listROIbotTools(authInfo: AuthInfo): Promise<Tool[]> {
  const client = await createROIbotClient(authInfo);
  try {
    const result = await client.listTools();
    logger.info(`[roibot-client] Discovered ${result.tools.length} ROIbot tools`);
    return result.tools;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Call a specific tool on ROIbot's MCP server.
 *
 * Handles the full delegation flow:
 * 1. Exchanges user's Keycard token for a ROIbot-scoped token
 * 2. Connects to ROIbot's MCP server as a client
 * 3. Calls the specified tool with the given arguments
 * 4. Returns the tool result and closes the connection
 *
 * @param toolName - Name of the ROIbot tool to call (e.g., "assess_event")
 * @param args - Tool arguments (must match the tool's input schema)
 * @param authInfo - User's auth info from the MCP session (contains the Keycard token)
 */
export async function callROIbotTool(
  toolName: string,
  args: Record<string, unknown>,
  authInfo: AuthInfo
): Promise<CallToolResult> {
  const client = await createROIbotClient(authInfo);
  try {
    logger.info(`[roibot-client] Calling ROIbot tool: ${toolName}`);
    const result = await client.callTool({ name: toolName, arguments: args });
    logger.info(`[roibot-client] Tool ${toolName} completed`);
    return result as CallToolResult;
  } catch (err) {
    throw new ROIbotClientError(
      `ROIbot tool call failed (${toolName}): ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Check whether ROIbot delegation is configured.
 * Returns true if ROIBOT_MCP_ENDPOINT is set.
 */
export function isROIbotConfigured(): boolean {
  return Boolean(config.roibotMcpEndpoint);
}
