/**
 * OAuth 2.0 endpoint discovery via .well-known metadata.
 *
 * Two-step discovery:
 * 1. Fetch /.well-known/oauth-protected-resource → get issuer URL
 * 2. Fetch issuer's /.well-known/oauth-authorization-server → get endpoints
 */

interface OAuthEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
}

let cachedEndpoints: OAuthEndpoints | null = null;

export async function discoverEndpoints(baseUrl: string): Promise<OAuthEndpoints> {
  if (cachedEndpoints) return cachedEndpoints;

  try {
    // Step 1: Get the issuer from the MCP server's protected resource metadata
    const resourceRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    if (!resourceRes.ok)
      throw new Error(`Protected resource discovery failed: ${resourceRes.status}`);

    const resourceMeta = await resourceRes.json();
    const issuer: string = resourceMeta.authorization_servers?.[0];
    if (!issuer) throw new Error("No authorization_servers in protected resource metadata");

    // Step 2: Get auth endpoints from the issuer's OAuth metadata
    const authServerRes = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
    if (!authServerRes.ok) throw new Error(`Auth server discovery failed: ${authServerRes.status}`);

    const authMeta = await authServerRes.json();

    const endpoints: OAuthEndpoints = {
      authorization_endpoint: authMeta.authorization_endpoint,
      token_endpoint: authMeta.token_endpoint,
    };

    if (!endpoints.authorization_endpoint || !endpoints.token_endpoint) {
      throw new Error("Missing authorization_endpoint or token_endpoint in OAuth metadata");
    }

    cachedEndpoints = endpoints;
    return endpoints;
  } catch (err) {
    console.error("OAuth discovery failed, using fallback:", err);

    // Fallback: construct from known Keycard zone URL pattern
    const fallbackIssuer =
      import.meta.env.VITE_KEYCARD_ISSUER || "https://chzabf1qgzjia0wfd17eietx70.keycard.cloud";

    cachedEndpoints = {
      authorization_endpoint: `${fallbackIssuer}/oauth/2/authorize`,
      token_endpoint: `${fallbackIssuer}/oauth/2/token`,
    };
    return cachedEndpoints;
  }
}
