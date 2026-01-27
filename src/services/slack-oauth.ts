import crypto from "node:crypto";
import { config } from "../config";
import { OAUTH } from "../constants";

// In-memory state storage with 10-minute expiry
const oauthStates = new Map<string, { userId: string; expiresAt: number }>();

export function generateOAuthUrl(userId: string): string {
  const state = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + OAUTH.STATE_EXPIRY_MS;

  oauthStates.set(state, { userId, expiresAt });

  // Cleanup expired states
  setTimeout(() => oauthStates.delete(state), OAUTH.STATE_EXPIRY_MS);

  const params = new URLSearchParams({
    client_id: config.slackClientId,
    scope: "search:read",
    redirect_uri: config.slackOAuthRedirectUrl,
    state,
  });

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export function validateState(state: string): string | null {
  const stateData = oauthStates.get(state);
  if (!stateData) return null;

  if (Date.now() > stateData.expiresAt) {
    oauthStates.delete(state);
    return null;
  }

  oauthStates.delete(state);
  return stateData.userId;
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  team?: { id: string; name: string };
  authed_user?: {
    id: string;
    access_token?: string; // User token for user scopes like search:read
  };
}

export async function exchangeCodeForToken(code: string): Promise<{
  access_token: string;
  team: { id: string; name: string };
  authed_user: { id: string };
}> {
  const params = new URLSearchParams({
    client_id: config.slackClientId,
    client_secret: config.slackClientSecret,
    code,
    redirect_uri: config.slackOAuthRedirectUrl,
  });

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await response.json() as SlackOAuthResponse;

  if (!data.ok || !data.team || !data.authed_user) {
    throw new Error(data.error || "Failed to exchange code for token");
  }

  // For user scopes like search:read, the token is in authed_user.access_token
  const userToken = data.authed_user.access_token;
  if (!userToken) {
    throw new Error("No user access token returned from Slack");
  }

  return {
    access_token: userToken, // Return the user token, not the bot token
    team: data.team,
    authed_user: data.authed_user,
  };
}
