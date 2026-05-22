import dotenv from "dotenv";

dotenv.config({ override: true });

/**
 * Server configuration interface
 */
interface ServerConfig {
  port: string;
  host: string;
  baseUrl: string;
  keycardIssuerUrl: string;
  keycardClientId: string;
  keycardClientSecret: string;
  slackEmojiName: string;
  calendarPrepPrefix: string;
  userDisplayNames: string[];
  orgGithubRepos: string[];
  meetingNotesFolderId: string;
  anthropicApiKey: string;
  anthropicModel: string;
  roibotAgentEndpoint: string;
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sequential env var validation with fallback logic
function getConfig(): ServerConfig {
  const PORT = process.env.PORT || "9005";

  // Validate PORT is numeric
  if (!/^\d+$/.test(PORT)) {
    throw new Error(`PORT must be a numeric value, got: ${PORT}`);
  }

  const HOST = process.env.HOST || "localhost";
  // Base URL for the server (used in startup logs and metadata)
  const BASE_URL = `http://${HOST}:${PORT}`;
  const KEYCARD_URL = process.env.KEYCARD_URL;

  // Keycard client ID and secret are required for the MCP server to authenticate with Keycard
  const KEYCARD_CLIENT_ID = process.env.KEYCARD_CLIENT_ID;
  const KEYCARD_CLIENT_SECRET = process.env.KEYCARD_CLIENT_SECRET;

  // Slack custom emoji for saved messages (optional preference, not auth)
  const SLACK_EMOJI_NAME = process.env.SLACK_EMOJI_NAME;

  // Calendar prep block prefix (optional — identifies meeting-prep focus blocks)
  const CALENDAR_PREP_PREFIX = process.env.CALENDAR_PREP_PREFIX?.trim() || "[Prep]";

  // User identity for filtering meeting notes action items (optional)
  // Comma-separated name variants, e.g. "Kim,Kim Maida,kimmaida"
  const USER_DISPLAY_NAME = process.env.USER_DISPLAY_NAME || "";

  // GitHub org repos to watch for incoming PRs/issues (optional)
  // Comma-separated owner/repo pairs, e.g. "myorg/backend,myorg/frontend"
  const ORG_GITHUB_REPOS = process.env.ORG_GITHUB_REPOS || "";

  // Google Drive folder ID for meeting notes (Granola → Zapier → GDrive pipeline)
  // Find this in the Drive URL: https://drive.google.com/drive/folders/<FOLDER_ID>
  const MEETING_NOTES_FOLDER_ID = process.env.MEETING_NOTES_FOLDER_ID || "";

  // Anthropic API for chatbot (optional — only needed if the UI chatbot is used)
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  // ROIbot A2A agent endpoint for agent-to-agent task delegation (optional).
  // Keycard resource URI for ROIbot's /api/agent endpoint. Used both as the
  // token-exchange `resource` (exact-match per STS) and as the A2A client URL.
  // Example: https://event-roi.fly.dev/api/agent
  const ROIBOT_AGENT_ENDPOINT = process.env.ROIBOT_AGENT_ENDPOINT || "";
  if (ROIBOT_AGENT_ENDPOINT) {
    let parsed: URL;
    try {
      parsed = new URL(ROIBOT_AGENT_ENDPOINT);
    } catch {
      throw new Error(
        `❌ FATAL: ROIBOT_AGENT_ENDPOINT must be a valid URL — got "${ROIBOT_AGENT_ENDPOINT}".\n` +
          "💡 Example: ROIBOT_AGENT_ENDPOINT=https://event-roi.fly.dev/api/agent"
      );
    }
    // STS uses exact string matching on the resource identifier — http→https
    // drift produces invalid_target at first call. Require https outside dev.
    const isDev = (process.env.NODE_ENV || "development") === "development";
    if (!isDev && parsed.protocol !== "https:") {
      throw new Error(
        `❌ FATAL: ROIBOT_AGENT_ENDPOINT must use https outside development — got ${parsed.protocol}`
      );
    }
  }

  const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "plan-my-today";
  const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || "0.1.1";
  const ENVIRONMENT = process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || "development";
  const ENABLE_OTEL = process.env.ENABLE_OTEL !== "false";
  const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

  // For URL-based credentials (web apps), only CLIENT_ID is required
  // For confidential clients, both CLIENT_ID and CLIENT_SECRET are required
  if (!KEYCARD_CLIENT_ID) {
    console.warn("⚠️  KEYCARD_CLIENT_ID not set - token exchange will not work");
  } else if (!KEYCARD_CLIENT_SECRET && !KEYCARD_CLIENT_ID.startsWith("http")) {
    console.warn("⚠️  KEYCARD_CLIENT_SECRET not set - required for non-URL based credentials");
  }

  if (!KEYCARD_URL) {
    throw new Error(
      "❌ FATAL: KEYCARD_URL must be defined.\n" +
        "💡 Example: KEYCARD_URL=https://your-zone-id.keycard.cloud"
    );
  }

  // Warn if custom emoji is not configured for Slack saved messages
  if (!SLACK_EMOJI_NAME) {
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
    keycardIssuerUrl: KEYCARD_URL,
    keycardClientId: KEYCARD_CLIENT_ID || "",
    keycardClientSecret: KEYCARD_CLIENT_SECRET || "",
    slackEmojiName: SLACK_EMOJI_NAME || "mcp-todo-reminder",
    calendarPrepPrefix: CALENDAR_PREP_PREFIX,
    anthropicApiKey: ANTHROPIC_API_KEY,
    anthropicModel: ANTHROPIC_MODEL,
    roibotAgentEndpoint: ROIBOT_AGENT_ENDPOINT,
    userDisplayNames: USER_DISPLAY_NAME
      ? USER_DISPLAY_NAME.split(",").map((n) => n.trim().toLowerCase())
      : [],
    orgGithubRepos: ORG_GITHUB_REPOS
      ? ORG_GITHUB_REPOS.split(",")
          .map((r) => r.trim())
          .filter(Boolean)
      : [],
    meetingNotesFolderId: MEETING_NOTES_FOLDER_ID,
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
