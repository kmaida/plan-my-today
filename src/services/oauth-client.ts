import { randomBytes } from "node:crypto";
import { config } from "../config";
import open from "open";

/**
 * OAuth client helper for triggering Keycard authorization flows
 * Based on: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClient.ts
 *
 * This helps users re-authorize services by opening the Keycard connection UI
 */

interface OAuthState {
  service: string;
  state: string;
  expiresAt: number;
}

// In-memory state storage
const oauthStates = new Map<string, OAuthState>();

/**
 * Extracts zone ID from Keycard issuer URL
 */
function getZoneId(): string {
  const match = config.keycardStsIssuerUrl.match(/https:\/\/([^.]+)\.keycard\.cloud/);
  return match ? match[1] : '';
}

/**
 * Generate authorization URL for Keycard connection UI
 * This doesn't trigger direct OAuth - it opens Keycard's UI where users can connect services
 */
export function getKeycardConnectionUrl(service?: string): string {
  const zoneId = getZoneId();
  if (!zoneId) {
    return 'https://keycard.cloud';
  }

  const baseUrl = `https://${zoneId}.keycard.cloud/settings/connections`;
  return service ? `${baseUrl}?service=${service}` : baseUrl;
}

/**
 * Open browser to Keycard connection UI
 * Returns a promise that resolves when the browser opens
 */
export async function openKeycardAuth(service?: string): Promise<void> {
  const url = getKeycardConnectionUrl(service);
  await open(url);
}

/**
 * Start OAuth state tracking (for when we implement OAuth callbacks)
 */
export function createOAuthState(service: string): string {
  const state = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  oauthStates.set(state, {
    service,
    state,
    expiresAt,
  });

  // Cleanup after expiry
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);

  return state;
}

/**
 * Validate OAuth callback state
 */
export function validateOAuthState(state: string): OAuthState | null {
  const oauthState = oauthStates.get(state);
  if (!oauthState) return null;

  if (Date.now() > oauthState.expiresAt) {
    oauthStates.delete(state);
    return null;
  }

  return oauthState;
}

/**
 * Complete OAuth flow and clean up state
 */
export function completeOAuthFlow(state: string): void {
  oauthStates.delete(state);
}
