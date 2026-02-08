import dotenv from "dotenv";
dotenv.config({ override: true });

/**
 * Server configuration interface
 */
export interface ServerConfig {
  port: string;
  host: string;
  baseUrl: string;
  keycardStsIssuerUrl: string;
  issuerBaseDomain: string;
  mcpBaseDomain: string;
  keycardClientId: string;
  keycardClientSecret: string;
  slackUserToken: string;
  slackEmojiName: string;
  userDisplayNames: string[];
  anthropicApiKey: string;
  anthropicModel: string;
  observability: {
    serviceName: string;
    serviceVersion: string;
    environment: string;
    enableOtel: boolean;
    otlpEndpoint: string;
  };
}

/**
 * Validates and returns the server configuration
 *
 * This function:
 * - Loads environment variables using dotenv
 * - Validates required configuration values
 * - Provides sensible defaults for optional values
 * - Throws descriptive errors for missing required values
 *
 * @returns Validated server configuration
 * @throws Error if required environment variables are missing
 */
export function getConfig(): ServerConfig {
  const PORT = process.env.PORT || "9005";

  // Validate PORT is numeric
  if (!/^\d+$/.test(PORT)) {
    throw new Error(`PORT must be a numeric value, got: ${PORT}`);
  }

  const HOST = process.env.HOST || "localhost";
  // Use LOCAL_TUNNEL if available (for ngrok), otherwise fall back to local dev URL
  const BASE_URL = process.env.LOCAL_TUNNEL || `http://${HOST}:${PORT}`;
  const KEYCARD_STS_ISSUER_URL = process.env.KEYCARD_STS_ISSUER_URL;
  const ISSUER_BASE_DOMAIN = process.env.ISSUER_BASE_DOMAIN;
  const MCP_BASE_DOMAIN = process.env.MCP_BASE_DOMAIN;

  // Keycard client ID and secret are required for the MCP server to authenticate with Keycard
  const KEYCARD_CLIENT_ID = process.env.KEYCARD_CLIENT_ID;
  const KEYCARD_CLIENT_SECRET = process.env.KEYCARD_CLIENT_SECRET;

  // Slack configuration (optional - single-user deployment only)
  const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
  const SLACK_EMOJI_NAME = process.env.SLACK_EMOJI_NAME;

  // User identity for filtering meeting notes action items (optional)
  // Comma-separated name variants, e.g. "Kim,Kim Maida,kimmaida"
  const USER_DISPLAY_NAME = process.env.USER_DISPLAY_NAME || '';

  // Anthropic API for chatbot (optional — only needed if the UI chatbot is used)
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

  const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "todo-mcp-server";
  const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || "0.1.1";
  const ENVIRONMENT = process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || "development";
  const ENABLE_OTEL = process.env.ENABLE_OTEL !== "false";
  const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  
  // For URL-based credentials (web apps), only CLIENT_ID is required
  // For confidential clients, both CLIENT_ID and CLIENT_SECRET are required
  if (!KEYCARD_CLIENT_ID) {
    console.warn("⚠️  KEYCARD_CLIENT_ID not set - token exchange will not work");
  } else if (!KEYCARD_CLIENT_SECRET && !KEYCARD_CLIENT_ID.startsWith('http')) {
    console.warn("⚠️  KEYCARD_CLIENT_SECRET not set - required for non-URL based credentials");
  }

  // For backward compatibility, KEYCARD_STS_ISSUER_URL is still required in single-tenant mode
  // In multi-tenant mode, ISSUER_BASE_DOMAIN and MCP_BASE_DOMAIN are required
  const isMultiTenant = ISSUER_BASE_DOMAIN && MCP_BASE_DOMAIN;
  
  if (!isMultiTenant && !KEYCARD_STS_ISSUER_URL) {
    throw new Error(
      "❌ FATAL: Either KEYCARD_STS_ISSUER_URL (single-tenant) or ISSUER_BASE_DOMAIN + MCP_BASE_DOMAIN (multi-tenant) must be defined.\n" +
        "💡 Single-tenant example:\n" +
        "   KEYCARD_STS_ISSUER_URL=https://your-zone-id.keycard.cloud\n" +
        "💡 Multi-tenant example:\n" +
        "   ISSUER_BASE_DOMAIN=keycard.cloud\n" +
        "   MCP_BASE_DOMAIN=mcp.example.com"
    );
  }
  
  if (isMultiTenant && (!ISSUER_BASE_DOMAIN || !MCP_BASE_DOMAIN)) {
    throw new Error(
      "❌ FATAL: For multi-tenant mode, both ISSUER_BASE_DOMAIN and MCP_BASE_DOMAIN are required.\n" +
        "💡 Example:\n" +
        "   ISSUER_BASE_DOMAIN=keycard.cloud\n" +
        "   MCP_BASE_DOMAIN=mcp.example.com"
    );
  }

  // Warn if Slack is enabled but custom emoji is not configured
  if (SLACK_USER_TOKEN && !SLACK_EMOJI_NAME) {
    console.warn(
      "⚠️  SLACK_EMOJI_NAME not set - using default 'mcp-todo-reminder'.\n" +
        "💡 To use a custom emoji, set SLACK_EMOJI_NAME in your .env file.\n" +
        "   Create the emoji in your Slack workspace first: Customize Slack → Add Custom Emoji"
    );
  }

  return {
    port: PORT,
    host: HOST,
    baseUrl: BASE_URL,
    keycardStsIssuerUrl: KEYCARD_STS_ISSUER_URL || '', // Fallback for multi-tenant mode
    issuerBaseDomain: ISSUER_BASE_DOMAIN || '',
    mcpBaseDomain: MCP_BASE_DOMAIN || '',
    keycardClientId: KEYCARD_CLIENT_ID || '',
    keycardClientSecret: KEYCARD_CLIENT_SECRET || '',
    slackUserToken: SLACK_USER_TOKEN || '',
    slackEmojiName: SLACK_EMOJI_NAME || 'mcp-todo-reminder',
    anthropicApiKey: ANTHROPIC_API_KEY,
    anthropicModel: ANTHROPIC_MODEL,
    userDisplayNames: USER_DISPLAY_NAME
      ? USER_DISPLAY_NAME.split(',').map(n => n.trim().toLowerCase())
      : [],
    observability: {
      serviceName: SERVICE_NAME,
      serviceVersion: SERVICE_VERSION,
      environment: ENVIRONMENT,
      enableOtel: ENABLE_OTEL,
      otlpEndpoint: OTLP_ENDPOINT,
    },
  };
}

export const config = getConfig();