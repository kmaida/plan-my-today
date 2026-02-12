import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requireBearerAuth } from "@keycardlabs/mcp-oauth/server/auth/middleware/bearerAuth";
import {
  type InferredAuthMetadataOptions,
  mcpAuthMetadataRouter,
} from "@keycardlabs/mcp-oauth/server/auth/router";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport as StreamableHTTPServerTransportImpl } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { config } from "./config";
import { PATHS } from "./constants";
import { createAuthMiddleware } from "./middleware/auth";
import { httpLoggingMiddleware } from "./middleware/logging";
import { getLogger } from "./observability/logger";
import {
  markActionComplete as storeComplete,
  markActionIncomplete as storeIncomplete,
} from "./services/action-completion-store";
import { getAvailableToolNames, registerAllTools, TOOL_REGISTRY } from "./tools/index";
import type { McpServer } from "./types/index";
import { removeTaskFromCache } from "./utils/cache-utils";
import { filterCompletedTasks, type CachedTaskData } from "./utils/filter-completed-tasks";

// Create authentication middleware using the local SDK
const authMiddleware = createAuthMiddleware(requireBearerAuth);

// Global storage for per-session servers
const sessionServers: {
  [sessionId: string]: {
    transport: InstanceType<typeof StreamableHTTPServerTransportImpl>;
  };
} = {};

/**
 * Creates and configures a new MCP server instance for each session
 *
 * @returns New configured MCP server with all tools registered
 */
function createMcpServerForSession(): McpServer {
  const mcpServer: McpServer = new McpServerImpl({
    name: "plan-my-today",
    version: "0.2.1",
  });

  // Register all available tools for this session
  registerAllTools(mcpServer);

  return mcpServer;
}

const TASKS_CACHE_PATH = path.join(process.cwd(), PATHS.TASKS_CACHE);

// ── Chat context management helpers ────────────────────────────────────────
// Sliding window fallback for models that don't support API-level compaction.
// Keeps the first 2 messages (initial context) + most recent messages,
// inserting a placeholder where turns were dropped. Adjusts the boundary
// so tool_use / tool_result pairs are never split.

type RawMessage = { role: string; content: unknown };
const MAX_HISTORY_MESSAGES = 20;

function hasBlockType(msg: RawMessage, blockType: string): boolean {
  return (
    Array.isArray(msg.content) &&
    (msg.content as Array<{ type: string }>).some((b) => b.type === blockType)
  );
}

function windowMessages(messages: RawMessage[]): RawMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;

  const headSize = 2;
  let tailStart = messages.length - (MAX_HISTORY_MESSAGES - 3);

  // Fix orphaned tool_result at the start of the tail
  if (tailStart < messages.length && hasBlockType(messages[tailStart], "tool_result")) {
    tailStart++;
  }
  // Fix orphaned tool_use right before the tail boundary
  if (
    tailStart > headSize &&
    tailStart < messages.length &&
    hasBlockType(messages[tailStart - 1], "tool_use") &&
    !hasBlockType(messages[tailStart], "tool_result")
  ) {
    tailStart--;
  }

  return [
    ...messages.slice(0, headSize),
    { role: "user", content: "[Earlier conversation context omitted for brevity]" },
    ...messages.slice(tailStart),
  ];
}

/**
 * Creates and configures the Express application
 *
 * @returns Configured Express application
 */
export function createApp(): express.Application {
  const app = express();

  // Trust proxy for correct protocol detection behind reverse proxies
  app.set("trust proxy", true);

  // Parse JSON requests (increased limit for chat payloads with tool results)
  app.use(express.json({ limit: "2mb" }));

  // Check if we're in multi-tenant mode
  const isMultiTenant = config.issuerBaseDomain && config.mcpBaseDomain;

  if (isMultiTenant) {
    // Multi-tenant mode: dynamic issuer based on Host header
    const multiTenantOptions: InferredAuthMetadataOptions = {
      oauthMetadata: {
        issuer: (req: express.Request) => {
          // Extract zoneId from Host header (e.g., z123.dev.local -> z123)
          const zoneId = req.headers.host?.split(".")[0] || "default";
          // Use HTTP for local development, HTTPS for production
          const protocol = config.issuerBaseDomain.includes("localdev") ? "http" : "https";
          return `${protocol}://${zoneId}.${config.issuerBaseDomain}`;
        },
      },
      scopesSupported: ["mcp:tools"],
      resourceName: "Plan My Today MCP",
    };
    app.use(mcpAuthMetadataRouter(multiTenantOptions));
  } else {
    // Single-tenant mode: static issuer (backward compatibility)
    const singleTenantOptions: InferredAuthMetadataOptions = {
      oauthMetadata: {
        issuer: config.keycardIssuerUrl,
      },
      scopesSupported: ["mcp:tools"],
      resourceName: "Plan My Today MCP",
    };
    app.use(mcpAuthMetadataRouter(singleTenantOptions));
  }

  // Add logging middleware for /mcp endpoint
  app.use(httpLoggingMiddleware);

  // Handle MCP protocol requests
  app.post("/mcp", authMiddleware, async (req: express.Request, res: express.Response) => {
    const { sessionId, logger } = req.context;

    let sessionData: { transport: InstanceType<typeof StreamableHTTPServerTransportImpl> };

    if (sessionId && sessionServers[sessionId]) {
      sessionData = sessionServers[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Create NEW McpServer instance for this session (following official pattern)
      const mcpServer = createMcpServerForSession();

      // Create new transport for initialization request
      const transport = new StreamableHTTPServerTransportImpl({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          req.context.logger.debug("New session initialized", { newSessionId });
          // Store the session data
          sessionServers[newSessionId] = { transport };
        },
      });

      // Clean up when session closes
      transport.onclose = () => {
        if (transport.sessionId) {
          delete sessionServers[transport.sessionId];
        }
      };

      sessionData = { transport };

      // Connect the MCP server to this transport BEFORE handling request
      // This follows the exact pattern from the official example
      try {
        await mcpServer.connect(transport);
      } catch (error) {
        logger.error("Failed to connect MCP server to transport", {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
        return res.status(500).json({ error: "Failed to initialize MCP session" });
      }
    } else {
      logger.warn("No valid session found; falling back to stateless transport");

      const mcpServer = createMcpServerForSession();
      const transport = new StreamableHTTPServerTransportImpl({
        sessionIdGenerator: undefined,
      });

      sessionData = { transport };

      try {
        await mcpServer.connect(transport);
      } catch (error) {
        logger.error("Failed to connect MCP server to stateless transport", {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
        return res.status(500).json({ error: "Failed to initialize MCP session" });
      }
    }

    const { transport } = sessionData;

    // Handle the MCP protocol request
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("Error during transport.handleRequest", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!res.headersSent) {
        return res.status(500).json({
          error: "MCP protocol error",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      } else {
        logger.warn("Cannot send error response - headers already sent");
      }
    }
  });

  /**
   * Helper function for handling session-based MCP requests
   */
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const { sessionId, logger } = req.context;

    logger?.debug("Handling session request");

    if (!sessionId || !sessionServers[sessionId]) {
      logger?.warn("Invalid or missing session ID");
      return res.status(400).send("Invalid or missing session ID");
    }

    const { transport } = sessionServers[sessionId];
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for SSE streams
  app.get("/mcp", authMiddleware, handleSessionRequest);

  // Handle DELETE requests for session termination
  app.delete("/mcp", authMiddleware, handleSessionRequest);

  // Simple REST API endpoint for calling tools via MCP protocol (convenience layer).
  // Reuses a single stateless MCP server instead of creating one per request.
  let restMcpServer: McpServer | null = null;
  let restTransport: InstanceType<typeof StreamableHTTPServerTransportImpl> | null = null;

  async function getRestMcpServer(): Promise<{
    server: McpServer;
    transport: InstanceType<typeof StreamableHTTPServerTransportImpl>;
  }> {
    if (!restMcpServer || !restTransport) {
      restMcpServer = createMcpServerForSession();
      restTransport = new StreamableHTTPServerTransportImpl({
        sessionIdGenerator: undefined,
      });
      await restMcpServer.connect(restTransport);
    }
    return { server: restMcpServer, transport: restTransport };
  }

  app.post(
    "/api/tools/:toolName",
    authMiddleware,
    async (req: express.Request, res: express.Response) => {
      const { toolName } = req.params;
      const { logger } = req.context;
      const args = req.body || {};

      logger.debug("REST API tool call", { toolName, args });

      try {
        const toolEntry = TOOL_REGISTRY.find((t: { name: string }) => t.name === toolName);

        if (!toolEntry) {
          return res.status(404).json({
            error: "Tool not found",
            availableTools: TOOL_REGISTRY.map((t: { name: string }) => t.name),
          });
        }

        const { transport } = await getRestMcpServer();

        // Route through MCP protocol (tools are registered as closures, so
        // we can't call them directly without refactoring every tool file)
        const callRequest = {
          jsonrpc: "2.0" as const,
          id: 1,
          method: "tools/call" as const,
          params: {
            name: toolName,
            arguments: args,
          },
        };

        let responseData: Record<string, unknown> | null = null;
        let responseStatus = 200;

        const mockRes = {
          json: (data: Record<string, unknown>) => {
            responseData = data;
            if (data.error) responseStatus = 500;
          },
          status: (code: number) => {
            responseStatus = code;
            return {
              json: (data: Record<string, unknown>) => {
                responseData = data;
              },
            };
          },
          headersSent: false,
        } as express.Response;

        const mockReq = {
          ...req,
          body: callRequest,
          context: req.context,
        } as express.Request;

        await transport.handleRequest(mockReq, mockRes, callRequest);

        if (responseData) {
          return res.status(responseStatus).json(responseData);
        } else {
          return res.status(500).json({ error: "No response from tool" });
        }
      } catch (error) {
        logger.error("REST API tool call failed", {
          toolName,
          error: error instanceof Error ? error.message : String(error),
        });

        // If the shared server is in a bad state, reset it
        restMcpServer = null;
        restTransport = null;

        res.status(500).json({
          error: "Tool execution failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // List available tools endpoint
  app.get("/api/tools", authMiddleware, async (_req: express.Request, res: express.Response) => {
    try {
      res.json({
        tools: TOOL_REGISTRY.map((t: { name: string }) => ({
          name: t.name,
        })),
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list tools",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Mark an action as complete (no auth — writes to local completion store).
  // Supports meeting-note, slack, docs, and adhoc sources.
  app.post("/api/mark-action-complete", async (req: express.Request, res: express.Response) => {
    try {
      const { source, identifier, complete = true, metadata, taskId } = req.body || {};

      if (!source || !identifier) {
        return res.status(400).json({ error: "Missing required fields: source, identifier" });
      }

      const validSources = ["meeting-note", "slack", "docs", "adhoc"];
      if (!validSources.includes(source)) {
        return res
          .status(400)
          .json({ error: `Invalid source. Must be one of: ${validSources.join(", ")}` });
      }

      if (!complete) {
        await storeIncomplete(source, identifier);
        return res.json({ success: true, message: `Unmarked: ${source}:${identifier}` });
      }

      await storeComplete(source, identifier, metadata);

      // Remove from cached tasks JSON so it disappears on next UI reload
      if (taskId) {
        await removeTaskFromCache(taskId);
      }

      return res.json({ success: true, message: `Marked complete: ${source}:${identifier}` });
    } catch (error) {
      res.status(500).json({
        error: "Failed to mark action complete",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Remove a task from the cache by taskId (called by the UI after mark-action-complete)
  app.post("/api/tasks/evict", async (req: express.Request, res: express.Response) => {
    const { taskId } = req.body || {};
    if (!taskId) {
      return res.status(400).json({ error: "Missing required field: taskId" });
    }
    await removeTaskFromCache(taskId);
    return res.json({ success: true });
  });

  // Serve cached task data for the UI (no auth — reads local file written by list-all-tasks-today).
  // Filters against the completion store so dismissed items never reach the UI,
  // even if the cache is stale or was overwritten by a fresh fetch.
  app.get("/api/tasks", async (_req: express.Request, res: express.Response) => {
    let data: Record<string, unknown>;
    try {
      const content = await fs.readFile(TASKS_CACHE_PATH, "utf-8");
      data = JSON.parse(content);
    } catch {
      return res
        .status(404)
        .json({ error: "No task data yet. Ask Claude to fetch your tasks first." });
    }

    // Filter dismissed items; non-fatal if completion store is unreadable
    try {
      await filterCompletedTasks(data as CachedTaskData);
    } catch {
      // Serve unfiltered data rather than failing entirely
    }

    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(data));
  });

  // Proxy token exchange for the UI (adds client_secret server-side so the
  // browser never sees it — Keycard app is a confidential client).
  app.post("/api/auth/token", async (req: express.Request, res: express.Response) => {
    try {
      const { code, code_verifier, redirect_uri } = req.body;
      if (!code || !code_verifier || !redirect_uri) {
        res
          .status(400)
          .json({ error: "Missing required parameters: code, code_verifier, redirect_uri" });
        return;
      }

      const tokenUrl = `${config.keycardIssuerUrl}/oauth/2/token`;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri,
        client_id: config.keycardClientId,
        client_secret: config.keycardClientSecret,
        code_verifier,
      });

      const tokenRes = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      const tokenData = await tokenRes.text();
      res.status(tokenRes.status).setHeader("Content-Type", "application/json").send(tokenData);
    } catch (err) {
      console.error("Token exchange proxy failed:", err);
      res.status(500).json({ error: "Token exchange proxy failed" });
    }
  });

  // Proxy chat messages to Anthropic Messages API (adds API key server-side).
  // The UI sends { messages, system?, tools? } and gets back Claude's response.
  // Context management strategy depends on the model:
  //   - Opus 4.6: uses Anthropic's server-side compaction (intelligent summarization)
  //   - Other models: falls back to a sliding window over message history
  app.post("/api/chat", async (req: express.Request, res: express.Response) => {
    try {
      if (!config.anthropicApiKey) {
        res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
        return;
      }

      const { messages, system, tools, model } = req.body;
      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ error: "Missing required field: messages (array)" });
        return;
      }

      const resolvedModel = model || config.anthropicModel;
      const supportsCompaction = resolvedModel === "claude-opus-4-6";

      // For non-compaction models, apply sliding window to cap context size
      const processedMessages = supportsCompaction ? messages : windowMessages(messages);

      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: 4096,
        stream: true,
        messages: processedMessages,
      };
      // Wrap system prompt as cacheable content block for Anthropic prompt caching
      if (system) {
        body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      }
      // Mark last tool definition as cacheable so the entire tool list is cached
      if (tools && tools.length > 0) {
        const cachedTools = tools.map((tool: Record<string, unknown>, i: number) =>
          i === tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool
        );
        body.tools = cachedTools;
      }
      // Enable server-side compaction for supported models (auto-summarizes older
      // context when approaching the token limit, default trigger: 150K tokens)
      if (supportsCompaction) {
        body.context_management = {
          edits: [{ type: "compact_20260112" }],
        };
      }

      const betas = ["prompt-caching-2024-07-31"];
      if (supportsCompaction) betas.push("compact-2026-01-12");

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": betas.join(","),
        },
        body: JSON.stringify(body),
      });

      if (!anthropicRes.ok || !anthropicRes.body) {
        const data = await anthropicRes.text();
        res.status(anthropicRes.status).setHeader("Content-Type", "application/json").send(data);
        return;
      }

      // Pipe the SSE stream from Anthropic directly to the client
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Convert web ReadableStream to Node.js Readable and pipe to response
      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(
        anthropicRes.body as import("node:stream/web").ReadableStream
      );
      nodeStream.pipe(res);
    } catch (err) {
      console.error("Chat proxy failed:", err);
      res.status(500).json({ error: "Chat proxy failed" });
    }
  });

  // Serve the built UI in production (after all API/MCP routes)
  const uiDistPath = path.join(__dirname, "..", "ui", "dist");
  app.use(express.static(uiDistPath));
  // SPA fallback: serve index.html for any unmatched GET request
  app.use((_req: express.Request, res: express.Response) => {
    res.sendFile(path.join(uiDistPath, "index.html"));
  });

  return app;
}

/**
 * Starts the MCP server
 *
 * This function:
 * - Sets up the Express application (no global MCP server)
 * - Starts listening on the configured port
 * - Displays startup information
 */
export function startServer(): void {
  const app = createApp();
  const logger = getLogger().withOperation("server_startup");

  app
    .listen(config.port, () => {
      const isMultiTenant = config.issuerBaseDomain && config.mcpBaseDomain;
      const issuer = isMultiTenant
        ? `https://{zoneId}.${config.issuerBaseDomain}`
        : config.keycardIssuerUrl;

      // Clean startup messages
      logger.info("🚀 To Do MCP Server started!");
      logger.info(`🔗 MCP Endpoint: ${config.baseUrl}/mcp`);
      logger.info(`🔐 Keycard Issuer: ${issuer}`);
      logger.info(`🛠️  Available Tools: ${getAvailableToolNames().join(", ")}`);

      // Detailed debug info
      logger.debug("Server configuration details", {
        mode: isMultiTenant ? "multi-tenant" : "single-tenant",
        issuerBaseDomain: isMultiTenant ? config.issuerBaseDomain : undefined,
        mcpBaseDomain: isMultiTenant ? config.mcpBaseDomain : undefined,
        architecture: "One MCP server instance per session (prevents race conditions)",
        observabilityEnabled: config.observability.enableOtel,
        environment: config.observability.environment,
      });
    })
    .on("error", (error: Error) => {
      logger.error("Failed to start server", {
        error: error.message,
        stack: error.stack,
      });
      process.exit(1);
    });
}
