const DEFAULT_MCP_RESOURCE = "http://localhost:9005/mcp";

/** Auth configuration — defaults work for local dev, override via VITE_ env vars. */
export const AUTH_CONFIG = {
  clientId: import.meta.env.VITE_KEYCARD_CLIENT_ID || "I5p7tlOM76xcfS_HnM_T0",
  redirectUri: `${window.location.origin}/auth/callback`,
  resource: import.meta.env.VITE_MCP_RESOURCE || DEFAULT_MCP_RESOURCE,
  scope: "openid profile",
  /** Base URL for OAuth discovery (empty = same origin, proxied by Vite in dev). */
  discoveryBaseUrl: import.meta.env.VITE_API_BASE || "",
};
