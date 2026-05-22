import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requireBearerAuth } from "@keycardai/mcp/server/auth/middleware/bearerAuth";
import { mcpAuthMetadataRouter } from "@keycardai/mcp/server/auth/router";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport as StreamableHTTPServerTransportImpl } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import compression from "compression";
import express from "express";
import { config } from "./config";
import { PATHS } from "./constants";
import { httpLoggingMiddleware } from "./middleware/logging";
import { getLogger } from "./observability/logger";
import {
  markActionComplete as storeComplete,
  markActionIncomplete as storeIncomplete,
} from "./services/action-completion-store";
import { getTokenEndpoint } from "./services/keycard-client";
import { getAvailableToolNames, registerAllTools, TOOL_REGISTRY } from "./tools/index";
import type { McpServer } from "./types/index";
import { filterCompletedTasks, type TaskStoreData } from "./utils/filter-completed-tasks";
import { removeTaskFromStore } from "./utils/task-store-utils";

// `issuers` is required by @keycardai/mcp@0.4+ when no custom verifier is
// passed — the SDK default JWKS keyring needs to know which issuer to trust.
// `requiredScopes` stays empty because the UI authorize call requests
// `openid profile` only; enforcing `mcp:tools` here would 403 every login.
const authMiddleware = requireBearerAuth({
  issuers: config.keycardIssuerUrl,
  requiredScopes: [],
});

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

const TASK_STORE_PATH = path.join(process.cwd(), PATHS.TASK_STORE);

/**
 * Creates and configures the Express application
 *
 * @returns Configured Express application
 */
export function createApp(): express.Application {
  const app = express();

  // Trust proxy for correct protocol detection behind reverse proxies
  app.set("trust proxy", true);

  // Parse JSON requests. Chat payloads carry full message history including
  // prior tool results; A2A delegations to ROIbot can return multi-MB
  // assessment text that lands inline in subsequent /api/chat POSTs. 25mb
  // gives ~5× headroom over Anthropic's ~1MB context-window worth of text,
  // enough to absorb large tool results without ever bouncing on the limit.
  app.use(express.json({ limit: "25mb" }));

  // Compress static assets and JSON API responses. Exclude SSE streams
  // (chat proxy, MCP transport) so compression doesn't buffer real-time chunks.
  app.use(
    compression({
      filter: (req, res) => {
        if (res.getHeader("Content-Type")?.toString().includes("text/event-stream")) {
          return false;
        }
        return compression.filter(req, res);
      },
    })
  );

  // OAuth metadata routes (Keycard issuer discovery).
  // `scopesSupported: []` — PMT does not gate tools by bearer scope. Access
  // control happens at the Keycard resource level (Cedar policy per resource).
  // The UI authorize call only requests "openid profile", and the bearer
  // middleware passes `requiredScopes: []`. Advertising `mcp:tools` here would
  // mislead spec-compliant peers into requesting a scope PMT never validates.
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: { issuer: config.keycardIssuerUrl },
      scopesSupported: [],
      resourceName: "Plan My Today MCP",
    })
  );

  // Health check — no auth required, placed before logging to stay lightweight
  app.get("/health", (_req: express.Request, res: express.Response) => {
    res.json({
      status: "ok",
      version: "0.2.1",
      authConfigured: !!config.keycardClientId,
      chatConfigured: !!config.anthropicApiKey,
    });
  });

  // Add logging middleware for /mcp endpoint
  app.use(httpLoggingMiddleware);

  // Handle MCP protocol requests
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Express route handler — MCP protocol processing
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
    } else if (sessionId) {
      // Stale session ID — server has no transport for it. Almost always a
      // client reconnecting after a nodemon restart. Per MCP Streamable HTTP
      // spec, 404 signals the client to re-initialize via POST (without a
      // session ID + an initialize body), which lands in the branch above.
      logger.debug("Unknown session on /mcp POST — likely post-restart reconnect");
      return res.status(404).json({ error: "Unknown session ID" });
    } else {
      // No session ID and not an initialize request — malformed per spec.
      // Every non-initialize POST must carry mcp-session-id.
      logger.warn("POST /mcp without session ID and not an initialize request");
      return res.status(400).json({ error: "Missing session ID (non-initialize request)" });
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
   * Helper function for handling session-based MCP requests.
   *
   * Distinguishes two failure modes:
   * - Missing header → 400 + warn (client bug; a GET/DELETE /mcp without
   *   mcp-session-id is malformed per the MCP Streamable HTTP transport spec).
   * - Unknown session → 404 + debug (benign; almost always a stale client
   *   reconnecting after a server restart. Per spec, clients treat 404 as a
   *   signal to re-initialize via POST).
   */
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const { sessionId, logger } = req.context;

    logger?.debug("Handling session request");

    if (!sessionId) {
      logger?.warn("Missing session ID on /mcp GET/DELETE");
      return res.status(400).send("Missing session ID");
    }

    if (!sessionServers[sessionId]) {
      logger?.debug("Unknown session — likely post-restart reconnect");
      return res.status(404).send("Unknown session ID");
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

  // Dismiss a task (no auth — writes to local completion store).
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Express route handler — dismissal with validation
  app.post("/api/dismiss-task", async (req: express.Request, res: express.Response) => {
    try {
      const { source, identifier, metadata, taskId } = req.body || {};

      if (!source || !identifier) {
        return res.status(400).json({ error: "Missing required fields: source, identifier" });
      }

      const validSources = ["meeting-note", "slack", "adhoc", "github"];
      if (!validSources.includes(source)) {
        return res
          .status(400)
          .json({ error: `Invalid source. Must be one of: ${validSources.join(", ")}` });
      }

      // Reject emoji-saved Slack messages: those are dismissed in Slack
      // itself by removing the emoji reaction, not via local completion state.
      if (source === "slack") {
        const { slackType } = req.body || {};
        if (slackType === "saved") {
          return res.status(400).json({
            error:
              "Emoji-saved Slack messages cannot be dismissed here. Remove the emoji reaction in Slack instead.",
          });
        }
      }

      await storeComplete(source, identifier, metadata);

      // Remove from task store so it disappears on next UI reload
      if (taskId) {
        await removeTaskFromStore(taskId);
      }

      return res.json({ success: true, message: `Dismissed: ${source}:${identifier}` });
    } catch (error) {
      res.status(500).json({
        error: "Failed to dismiss task",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Restore a dismissed task (no auth — modifies local completion store).
  app.post("/api/restore-dismissed-task", async (req: express.Request, res: express.Response) => {
    try {
      const { source, identifier } = req.body || {};

      if (!source || !identifier) {
        return res.status(400).json({ error: "Missing required fields: source, identifier" });
      }

      const validSources = ["meeting-note", "slack", "adhoc", "github"];
      if (!validSources.includes(source)) {
        return res
          .status(400)
          .json({ error: `Invalid source. Must be one of: ${validSources.join(", ")}` });
      }

      await storeIncomplete(source, identifier);
      return res.json({ success: true, message: `Restored: ${source}:${identifier}` });
    } catch (error) {
      res.status(500).json({
        error: "Failed to restore dismissed task",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Remove a task from the task store by taskId (called by the UI after dismiss-task)
  app.post("/api/tasks/evict", async (req: express.Request, res: express.Response) => {
    const { taskId } = req.body || {};
    if (!taskId) {
      return res.status(400).json({ error: "Missing required field: taskId" });
    }
    await removeTaskFromStore(taskId);
    return res.json({ success: true });
  });

  // Serve task store data for the UI (no auth — reads local file written by list-all-tasks-today).
  // Filters against the completion store so dismissed items never reach the UI,
  // even if the task store is stale or was overwritten by a fresh fetch.
  app.get("/api/tasks", async (_req: express.Request, res: express.Response) => {
    let data: Record<string, unknown>;
    try {
      const content = await fs.readFile(TASK_STORE_PATH, "utf-8");
      data = JSON.parse(content);
    } catch {
      return res
        .status(404)
        .json({ error: "No task data yet. Ask Claude to fetch your tasks first." });
    }

    // Filter dismissed items; non-fatal if completion store is unreadable
    try {
      await filterCompletedTasks(data as TaskStoreData);
    } catch {
      // Serve unfiltered data rather than failing entirely
    }

    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(data));
  });

  // Proxy token exchange for the UI (adds client_secret server-side so the
  // browser never sees it — Keycard app is a confidential client).
  //
  // The token_endpoint is discovered via RFC 8414 (.well-known metadata) rather
  // than hardcoded. This matches what the SDK's TokenExchangeClient does
  // internally and keeps the UI login resilient to any future endpoint path
  // change from Keycard. Discovery result is cached at module scope; see
  // getTokenEndpoint in services/keycard-client.ts.
  app.post("/api/auth/token", async (req: express.Request, res: express.Response) => {
    const logger = getLogger();
    try {
      const { code, code_verifier, redirect_uri } = req.body;
      if (!code || !code_verifier || !redirect_uri) {
        res
          .status(400)
          .json({ error: "Missing required parameters: code, code_verifier, redirect_uri" });
        return;
      }

      const tokenUrl = await getTokenEndpoint();
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
      logger.error("Token exchange proxy failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Token exchange proxy failed" });
    }
  });

  // Proxy chat messages to Anthropic Messages API (adds API key server-side).
  // The UI sends { messages, system?, tools?, effort? } and gets back Claude's
  // response as an SSE stream. Context management is handled by API-level edits:
  //   - All models: clear_tool_uses (token-aware cleanup of old tool results)
  //   - Opus 4.6: + adaptive thinking, clear_thinking, server-side compaction
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Express route handler — chat API proxy with streaming
  app.post("/api/chat", async (req: express.Request, res: express.Response) => {
    try {
      if (!config.anthropicApiKey) {
        res.status(500).json({
          error: {
            category: "config",
            source: "chat",
            message: "ANTHROPIC_API_KEY not configured on server",
            hint: "Set ANTHROPIC_API_KEY in the server's .env and restart.",
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      const { messages, system, tools, model, effort } = req.body;
      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({
          error: {
            category: "config",
            source: "chat",
            message: "Missing required field: messages (array)",
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      const resolvedModel = model || config.anthropicModel;
      const isOpus46 = resolvedModel === "claude-opus-4-6";
      // Effort parameter is supported on Opus 4.6 and Opus 4.5
      const supportsEffort = isOpus46 || resolvedModel === "claude-opus-4-5-20250918";

      // Context management replaces the old sliding window for all models.
      // Messages pass through unmodified; the API handles context edits.
      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: isOpus46 ? 16000 : 4096,
        stream: true,
        messages,
      };

      // ── Adaptive thinking (Opus 4.6 only) ──────────────────────────────
      // Lets the model decide when to reason deeply vs. respond quickly.
      // No beta header required. Temperature cannot be set with thinking.
      if (isOpus46) {
        body.thinking = { type: "adaptive" };
      }

      // ── Effort parameter (Opus models only) ────────────────────────────
      // Controls how much token budget Claude spends. The UI infers effort
      // from message content (e.g., "plan my day" → high, "mark done" → low).
      if (supportsEffort && effort) {
        body.output_config = { effort };
      }

      // ── Prompt caching ─────────────────────────────────────────────────
      // The UI sends system as an array of content blocks:
      // [static instructions, dynamic time context]. We cache only the first
      // (static) block so the time-varying dynamic block doesn't bust the
      // prompt cache on every request.
      if (system) {
        if (Array.isArray(system)) {
          body.system = system.map((block: { type: string; text: string }, i: number) =>
            i === 0 ? { ...block, cache_control: { type: "ephemeral" } } : block
          );
        } else {
          // Backwards compat: single string wraps as a single cached block
          body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
        }
      }
      // Mark last tool definition as cacheable so the entire tool list is cached
      if (tools && tools.length > 0) {
        const cachedTools = tools.map((tool: Record<string, unknown>, i: number) =>
          i === tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool
        );
        body.tools = cachedTools;
      }

      // ── Context management ─────────────────────────────────────────────
      // Build the edits array with strategies applicable to this model:
      // - clear_thinking: clears old thinking blocks (Opus 4.6 with thinking)
      // - clear_tool_uses: clears old tool results (all models, replaces sliding window)
      // - compact: server-side compaction for long conversations (Opus 4.6 only)
      {
        const edits: Record<string, unknown>[] = [];

        // Thinking block cleanup (must be listed before other strategies).
        // Keep thinking from last 2 assistant turns for reasoning continuity.
        if (isOpus46) {
          edits.push({
            type: "clear_thinking_20251015",
            keep: { type: "thinking_turns", value: 2 },
          });
        }

        // Tool result clearing for all models. Triggers at 30K input tokens
        // (well before any model's limit), keeping the 5 most recent tool
        // use/result pairs. This replaces the old sliding-window approach
        // which was token-unaware (one 30K-char tool result counted the
        // same as a short user message).
        edits.push({
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 30000 },
          keep: { type: "tool_uses", value: 5 },
        });

        // Server-side compaction for Opus 4.6 (auto-summarizes older context
        // when approaching the token limit, default trigger: 150K tokens)
        if (isOpus46) {
          edits.push({ type: "compact_20260112" });
        }

        body.context_management = { edits };
      }

      // ── Beta headers ───────────────────────────────────────────────────
      const betas = ["prompt-caching-2024-07-31", "context-management-2025-06-27"];
      if (isOpus46) betas.push("compact-2026-01-12");

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
        const rawBody = await anthropicRes.text();
        // Anthropic returns `{ type: "error", error: { type, message } }` on
        // non-2xx. Normalize into our structured shape so the UI can render it
        // expandably without parsing Anthropic-specific wire formats.
        let upstreamType: string | undefined;
        let upstreamMessage = rawBody;
        try {
          const parsed = JSON.parse(rawBody);
          upstreamType = parsed?.error?.type;
          upstreamMessage = parsed?.error?.message ?? rawBody;
        } catch {
          // Body wasn't JSON — fall through with raw text in message.
        }
        const category: "rate_limit" | "upstream_api" | "auth" =
          anthropicRes.status === 429 || upstreamType === "rate_limit_error"
            ? "rate_limit"
            : anthropicRes.status === 401 || anthropicRes.status === 403
              ? "auth"
              : "upstream_api";
        res.status(anthropicRes.status).json({
          error: {
            category,
            source: "anthropic",
            status: anthropicRes.status,
            description: upstreamType,
            message: upstreamMessage,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      // Pipe the SSE stream from Anthropic to the client, inspecting
      // the message_start event to log token usage and cache metrics.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const { Readable, Transform } = await import("node:stream");
      const nodeStream = Readable.fromWeb(
        anthropicRes.body as import("node:stream/web").ReadableStream
      );

      const logger = getLogger();
      let sseBuffer = "";
      let logged = false;
      // Map Anthropic streaming error.type → our ErrorCategory.
      const anthropicErrorCategory = (t?: string): "rate_limit" | "upstream_api" | "auth" => {
        if (t === "rate_limit_error" || t === "overloaded_error") return "rate_limit";
        if (t === "authentication_error" || t === "permission_error") return "auth";
        return "upstream_api";
      };
      const inspector = new Transform({
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream transform — inspects chunks for logging and error normalization
        transform(chunk: Buffer, _encoding, callback) {
          // Pass data through unchanged; inspect for logging + error rewriting.
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split("\n");
          // Keep the last (potentially incomplete) line in the buffer
          sseBuffer = lines.pop()!;

          let extra = "";
          for (const line of lines) {
            // ── message_start: one-shot usage log (existing behavior) ─────
            if (!logged && line.startsWith("data: ") && line.includes('"message_start"')) {
              try {
                const event = JSON.parse(line.slice(6).trim());
                if (event?.type === "message_start" && event?.message?.usage) {
                  const u = event.message.usage;
                  logger.info("Chat API input usage", {
                    model: event.message.model,
                    input_tokens: u.input_tokens,
                    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
                    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
                  });
                  logged = true;
                }
              } catch {
                // Ignore parse errors on partial lines
              }
              continue;
            }

            // ── mid-stream error: normalize and forward as `chat_error` ───
            // Anthropic emits `event: error\ndata: {"type":"error","error":{...}}`
            // on overloaded / rate-limit / auth mid-stream. The UI sees
            // `event: chat_error` with our structured payload and surfaces it.
            if (line.startsWith("data: ") && line.includes('"type":"error"')) {
              try {
                const event = JSON.parse(line.slice(6).trim());
                if (event?.type === "error" && event?.error) {
                  const errType = event.error.type as string | undefined;
                  const errMsg = (event.error.message as string | undefined) ?? "Stream error";
                  logger.warn("Chat API stream error", { errType, message: errMsg });
                  const payload = {
                    category: anthropicErrorCategory(errType),
                    source: "anthropic",
                    description: errType,
                    message: errMsg,
                    timestamp: new Date().toISOString(),
                  };
                  extra += `event: chat_error\ndata: ${JSON.stringify(payload)}\n\n`;
                }
              } catch {
                // Ignore parse errors on partial lines
              }
            }
          }

          callback(null, extra ? Buffer.concat([chunk, Buffer.from(extra)]) : chunk);
        },
      });

      nodeStream.pipe(inspector).pipe(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat proxy failed";
      getLogger().withOperation("chat_proxy").error("Chat proxy failed", { message });
      // Headers may already be flushed if the failure happened mid-stream;
      // only emit a JSON error if we haven't started writing yet.
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            category: "unknown",
            source: "chat",
            message,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        res.end();
      }
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
      logger.info("🚀 To Do MCP Server started!");
      logger.info(`🌐 App URL:      ${config.baseUrl}`);
      logger.info(`🔗 MCP Endpoint: ${config.baseUrl}/mcp`);
      logger.info(`🔐 Keycard Issuer: ${config.keycardIssuerUrl}`);
      logger.info(`🛠️  Available Tools: ${getAvailableToolNames().join(", ")}`);

      logger.debug("Server configuration details", {
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
