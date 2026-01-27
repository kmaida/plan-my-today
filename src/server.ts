import { randomUUID } from "node:crypto";
import { requireBearerAuth } from "@keycardlabs/mcp-oauth/server/auth/middleware/bearerAuth";
import { mcpAuthMetadataRouter, InferredAuthMetadataOptions } from "@keycardlabs/mcp-oauth/server/auth/router";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport as StreamableHTTPServerTransportImpl } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { config } from "./config";
import { createAuthMiddleware } from "./middleware/auth";
import { httpLoggingMiddleware } from "./middleware/logging";
import { getLogger } from "./observability/logger";
import { registerAllTools, getAvailableToolNames } from "./tools/index";
import type { McpServer } from "./types/index";
import { generateOAuthUrl, validateState, exchangeCodeForToken } from "./services/slack-oauth";
import * as slackTokenStore from "./services/slack-token-store";
import { extractUserIdFromAuthInfo } from "./utils/auth-utils";
import { registerAuthDashboard } from "./routes/auth-dashboard";
import { registerKeycardReauth } from "./routes/keycard-reauth";

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
    name: "todo-mcp-server",
    version: "0.2.1",
  });

  // Register all available tools for this session
  registerAllTools(mcpServer);

  return mcpServer;
}

/**
 * Creates and configures the Express application
 *
 * @returns Configured Express application
 */
export function createApp(): express.Application {
  const app = express();

  // Trust proxy for correct protocol detection behind reverse proxies
  app.set('trust proxy', true);

  // Parse JSON requests
  app.use(express.json());

  // Check if we're in multi-tenant mode
  const isMultiTenant = config.issuerBaseDomain && config.mcpBaseDomain;
  
  if (isMultiTenant) {
    // Multi-tenant mode: dynamic issuer based on Host header
    const multiTenantOptions: InferredAuthMetadataOptions = {
      oauthMetadata: {
        issuer: (req: express.Request) => {
          // Extract zoneId from Host header (e.g., z123.dev.local -> z123)
          const zoneId = req.headers.host?.split('.')[0] || 'default';
          // Use HTTP for local development, HTTPS for production
          const protocol = config.issuerBaseDomain.includes('localdev') ? 'http' : 'https';
          return `${protocol}://${zoneId}.${config.issuerBaseDomain}`;
        }
      },
      scopesSupported: ['mcp:tools'],
      resourceName: "Todo MCP Server",
    };
    app.use(mcpAuthMetadataRouter(multiTenantOptions));
  } else {
    // Single-tenant mode: static issuer (backward compatibility)
    const singleTenantOptions: InferredAuthMetadataOptions = {
      oauthMetadata: {
        issuer: config.keycardStsIssuerUrl
      },
      scopesSupported: ['mcp:tools'],
      resourceName: "Todo MCP Server",
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

  // Simple REST API endpoint for calling tools directly (convenience layer)
  // This allows easier access to tools without full MCP protocol
  app.post('/api/tools/:toolName', authMiddleware, async (req: express.Request, res: express.Response) => {
    const { toolName } = req.params;
    const { logger } = req.context;
    const authInfo = req.auth;
    const args = req.body || {};

    logger.debug("REST API tool call", { toolName, args });

    try {
      // Import tool registry
      const { TOOL_REGISTRY } = await import("./tools/index.js");
      const toolEntry = TOOL_REGISTRY.find((t: { name: string }) => t.name === toolName);

      if (!toolEntry) {
        return res.status(404).json({
          error: "Tool not found",
          availableTools: TOOL_REGISTRY.map((t: { name: string }) => t.name),
        });
      }

      // Create MCP server and transport to handle the tool call via MCP protocol
      const tempServer = createMcpServerForSession();
      const transport = new StreamableHTTPServerTransportImpl({
        sessionIdGenerator: undefined,
      });

      await tempServer.connect(transport);

      // Create MCP protocol request
      const callRequest = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "tools/call" as const,
        params: {
          name: toolName,
          arguments: args,
        },
      };

      // Create a response collector
      let responseData: any = null;
      let responseStatus = 200;

      const mockRes = {
        json: (data: any) => {
          responseData = data;
          if (data.error) {
            responseStatus = 500;
          }
        },
        status: (code: number) => {
          responseStatus = code;
          return {
            json: (data: any) => {
              responseData = data;
            },
          };
        },
        headersSent: false,
      } as express.Response;

      // Copy context to mock request
      const mockReq = {
        ...req,
        body: callRequest,
        context: req.context,
      } as express.Request;

      await transport.handleRequest(mockReq, mockRes, callRequest);

      await tempServer.close();

      // Return the response
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

      res.status(500).json({
        error: "Tool execution failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // List available tools endpoint
  app.get('/api/tools', authMiddleware, async (_req: express.Request, res: express.Response) => {
    try {
      const { TOOL_REGISTRY } = await import("./tools/index.js");

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

  // Slack OAuth: Start flow
  app.get("/slack/auth/start", authMiddleware, (req: express.Request, res: express.Response) => {
    const userId = extractUserIdFromAuthInfo(req.auth);
    const oauthUrl = generateOAuthUrl(userId);
    res.redirect(oauthUrl);
  });

  // Slack OAuth: Callback
  app.get("/slack/auth/callback", async (req: express.Request, res: express.Response) => {
    const { code, error, state } = req.query;

    if (error) {
      return res.status(400).send(`<html><body><h1>OAuth Error</h1><p>${error}</p></body></html>`);
    }

    if (!code || !state) {
      return res.status(400).send("<html><body><h1>Missing Parameters</h1></body></html>");
    }

    const userId = validateState(state as string);
    if (!userId) {
      return res.status(400).send("<html><body><h1>Invalid or Expired State</h1></body></html>");
    }

    try {
      const tokenData = await exchangeCodeForToken(code as string);

      await slackTokenStore.saveToken(userId, {
        access_token: tokenData.access_token,
        team_id: tokenData.team.id,
        team_name: tokenData.team.name,
        user_id: tokenData.authed_user.id,
        created_at: new Date().toISOString(),
      });

      res.send(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>✅ Slack Connected!</h1>
            <p>Your Slack messages (@mentions and DMs) will now be included in list-all-tasks-today for agent-based planning.</p>
            <p>You can close this window.</p>
          </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>❌ Connection Failed</h1>
            <p>${err instanceof Error ? err.message : "Unknown error"}</p>
          </body>
        </html>
      `);
    }
  });

  // Register auth dashboard and Keycard reauth
  registerAuthDashboard(app);
  registerKeycardReauth(app);

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
      const issuer = isMultiTenant ? `https://{zoneId}.${config.issuerBaseDomain}` : config.keycardStsIssuerUrl;
      
      // Clean startup messages
      logger.info("🚀 To Do MCP Server started!");
      logger.info(`🔗 MCP Endpoint: ${config.baseUrl}/mcp`);
      logger.info(`🔐 STS Issuer: ${issuer}`);
      logger.info(`🔑 Auth Dashboard: ${config.baseUrl}/auth`);
      logger.info(`🛠️  Available Tools: ${getAvailableToolNames().join(", ")}`);
      
      // Detailed debug info
      logger.debug("Server configuration details", {
        mode: isMultiTenant ? 'multi-tenant' : 'single-tenant',
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