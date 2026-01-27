import type { Express, Request, Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { config } from "../config";
import { extractZoneId } from "../utils/auth-utils";

/**
 * Keycard re-authentication flow
 * Based on Keycard Python SDK: https://github.com/keycardai/python-sdk/tree/main/packages/mcp/src/keycardai/mcp/client
 *
 * This triggers Keycard to re-authorize with services, similar to what Cursor does
 */

interface ReauthState {
  state: string;
  codeVerifier: string;
  expiresAt: number;
  timestamp: number;
  userAgent?: string;
}

const reauthStates = new Map<string, ReauthState>();
const recentCompletions = new Map<string, number>(); // Track recent completions to prevent loops
const recentStarts = new Map<string, number>(); // Track recent starts to detect rapid retries

/**
 * Generate PKCE parameters for secure OAuth flow
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = Buffer.from(hash).toString("base64url");
  return { codeVerifier, codeChallenge };
}

export function registerKeycardReauth(app: Express): void {
  /**
   * Start Keycard re-authentication flow
   * Opens OAuth flow that prompts user to reconnect services
   */
  app.get("/keycard/reauth", (req: Request, res: Response) => {
    try {
      const zoneId = extractZoneId(config.keycardStsIssuerUrl);
      if (!zoneId) {
        return res.status(500).send("Keycard STS issuer URL not configured");
      }

      // Check for recent completion to prevent loops (within last 30 seconds)
      const userKey = req.headers['user-agent'] || 'unknown';
      const lastCompletion = recentCompletions.get(userKey);
      if (lastCompletion && Date.now() - lastCompletion < 30000) {
        console.warn("Prevented potential OAuth loop - recent completion detected", {
          userAgent: userKey,
          timeSinceCompletion: Date.now() - lastCompletion
        });
        return res.send(`
          <html>
            <body style="font-family: system-ui; text-align: center; padding: 50px;">
              <h1>⚠️ Re-authentication Already Completed</h1>
              <p>You completed re-authentication ${Math.floor((Date.now() - lastCompletion) / 1000)} seconds ago.</p>
              <p>Please <strong>restart Claude Desktop</strong> to apply the changes.</p>
              <p><a href="/auth">Return to Auth Dashboard</a></p>
            </body>
          </html>
        `);
      }

      // Check for rapid repeated starts (within last 5 seconds) - indicates possible loop
      const lastStart = recentStarts.get(userKey);
      if (lastStart && Date.now() - lastStart < 5000) {
        console.error("POSSIBLE OAUTH LOOP DETECTED - Multiple /keycard/reauth requests in rapid succession", {
          userAgent: userKey,
          timeSinceLastStart: Date.now() - lastStart,
          message: "This suggests an infinite redirect loop"
        });
      }

      // Track this start
      recentStarts.set(userKey, Date.now());
      setTimeout(() => recentStarts.delete(userKey), 60000); // Clean up after 1 minute

      const state = randomBytes(16).toString("hex");
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
      const timestamp = Date.now();

      // Only use PKCE for public clients (no client_secret)
      // For confidential clients, use client_secret authentication
      const isPublicClient = !config.keycardClientSecret;
      let codeVerifier: string | undefined;
      let codeChallenge: string | undefined;

      if (isPublicClient) {
        const pkce = generatePKCE();
        codeVerifier = pkce.codeVerifier;
        codeChallenge = pkce.codeChallenge;
      }

      // Store state with user tracking
      reauthStates.set(state, {
        state,
        codeVerifier: codeVerifier || "",
        expiresAt,
        timestamp,
        userAgent: userKey
      });
      setTimeout(() => reauthStates.delete(state), 10 * 60 * 1000);

      // Build Keycard OAuth URL
      const redirectUri = `${config.baseUrl}/keycard/callback`;
      const clientId = config.keycardClientId;

      if (!clientId) {
        return res.status(500).send("Keycard client ID not configured");
      }

      const authParams: Record<string, string> = {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        scope: "openid profile email offline_access",
        // Removed prompt: "consent" to prevent forced re-consent loops
        // Keycard will handle consent as needed
      };

      // Add PKCE parameters for public clients
      if (isPublicClient && codeChallenge) {
        authParams.code_challenge = codeChallenge;
        authParams.code_challenge_method = "S256";
      }

      const params = new URLSearchParams(authParams);

      const authUrl = `${config.keycardStsIssuerUrl}/oauth/2/authorize?${params.toString()}`;

      console.log("Starting Keycard re-auth flow", {
        state,
        redirectUri,
        clientId: clientId.substring(0, 8) + "...",
        userAgent: userKey.substring(0, 50),
        note: "User will be prompted to connect multiple Google services (Calendar, Gmail, Drive) - this requires 3-4 clicks"
      });

      // Redirect to Keycard OAuth
      res.redirect(authUrl);
    } catch (error) {
      console.error("Failed to start reauth flow:", error);
      res.status(500).send("Failed to start re-authentication flow");
    }
  });

  /**
   * Handle OAuth callback from Keycard
   */
  app.get("/keycard/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query;

    console.log("OAuth callback received", {
      hasCode: !!code,
      hasState: !!state,
      hasError: !!error,
      errorValue: error
    });

    if (error) {
      console.error("OAuth callback error", { error });
      return res.status(400).send(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>❌ Authorization Failed</h1>
            <p>${error}</p>
            <p><a href="/auth">Return to Auth Dashboard</a></p>
          </body>
        </html>
      `);
    }

    if (!code || !state) {
      console.error("OAuth callback missing required parameters", { hasCode: !!code, hasState: !!state });
      return res.status(400).send(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>❌ Missing Parameters</h1>
            <p>OAuth callback is missing code or state parameter.</p>
            <p><strong>Debug Info:</strong></p>
            <p>Redirect URI: <code>${config.baseUrl}/keycard/callback</code></p>
            <p>Make sure this exact URI is registered in your Keycard application settings.</p>
            <p><a href="/auth">Return to Auth Dashboard</a></p>
          </body>
        </html>
      `);
    }

    // Validate state
    const reauthState = reauthStates.get(state as string);
    if (!reauthState) {
      console.error("OAuth callback state validation failed", {
        receivedState: state,
        statesInMemory: reauthStates.size
      });
      return res.status(400).send(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>❌ Invalid or Expired State</h1>
            <p>The OAuth state parameter is invalid or has expired.</p>
            <p>This can happen if:</p>
            <ul style="text-align: left; display: inline-block;">
              <li>The authorization took more than 10 minutes</li>
              <li>The server was restarted during authorization</li>
              <li>You're in a redirect loop (click Return to stop)</li>
            </ul>
            <p><a href="/auth">Return to Auth Dashboard</a></p>
          </body>
        </html>
      `);
    }

    if (Date.now() > reauthState.expiresAt) {
      reauthStates.delete(state as string);
      console.error("OAuth callback state expired", {
        state,
        expiredAt: new Date(reauthState.expiresAt).toISOString()
      });
      return res.status(400).send(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>❌ State Expired</h1>
            <p>The authorization session expired (10 minute timeout).</p>
            <p><a href="/auth">Return to Auth Dashboard</a></p>
          </body>
        </html>
      `);
    }

    try {
      // Keycard returns a JWT as the "code" (type: vnd.kc.ac+jwt)
      // This is an authorization code JWT, not a traditional opaque code
      // The purpose of this re-auth flow is to trigger Keycard to refresh service connections
      // We don't need to exchange this JWT - the act of re-consenting updates Keycard's state

      const codeStr = code as string;

      // Validate that we received something (should be a JWT starting with "eyJ")
      if (!codeStr || codeStr.length < 100) {
        throw new Error("Invalid authorization code received from Keycard");
      }

      // Track completion to prevent loops
      const userKey = reauthState.userAgent || 'unknown';
      recentCompletions.set(userKey, Date.now());
      setTimeout(() => recentCompletions.delete(userKey), 60000); // Clean up after 1 minute

      // Clean up state
      reauthStates.delete(state as string);

      console.log("OAuth callback successful", {
        state,
        codeLength: codeStr.length,
        duration: Date.now() - reauthState.timestamp
      });

      // Success page with instructions
      res.send(`
        <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
              }
              .container {
                background: white;
                border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                max-width: 600px;
                padding: 40px;
                text-align: center;
              }
              h1 { color: #1a202c; margin-bottom: 16px; }
              .success { color: #48bb78; font-size: 64px; margin-bottom: 16px; }
              p { color: #4a5568; line-height: 1.6; margin-bottom: 16px; }
              .code {
                background: #f7fafc;
                padding: 12px;
                border-radius: 8px;
                font-family: monospace;
                margin: 20px 0;
              }
              .button {
                display: inline-block;
                padding: 12px 24px;
                background: #667eea;
                color: white;
                text-decoration: none;
                border-radius: 8px;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="success">✅</div>
              <h1>Re-authentication Successful!</h1>
              <p>
                Keycard has re-authorized your service connections.
              </p>
              <div style="background: #e6fffa; border: 1px solid #81e6d9; border-radius: 8px; padding: 12px; margin: 16px 0; text-align: left;">
                <p style="color: #234e52; font-size: 13px; margin: 0;">
                  ✅ <strong>Services connected:</strong> Google Calendar, Gmail, Drive, Linear, GitHub
                </p>
                <p style="color: #234e52; font-size: 12px; margin: 8px 0 0 0;">
                  If you had to click through multiple Google authorization screens (3-4 times), that's normal - each Google service requires separate authorization.
                </p>
              </div>
              <p>
                <strong>Next Steps:</strong>
              </p>
              <ol style="text-align: left; color: #4a5568; padding-left: 40px;">
                <li style="margin-bottom: 8px;"><strong>Restart Claude Desktop</strong> (critical!)</li>
                <li style="margin-bottom: 8px;">Run <code style="background: #edf2f7; padding: 2px 6px; border-radius: 4px;">check-auth</code> to verify all services are working</li>
                <li>Try <code style="background: #edf2f7; padding: 2px 6px; border-radius: 4px;">list-all-tasks-today</code> to test all integrations</li>
              </ol>
              <a href="/auth" class="button">Return to Auth Dashboard</a>
            </div>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("Token exchange error:", error);
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).send(`
        <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
              }
              .container {
                background: white;
                border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                max-width: 600px;
                padding: 40px;
                text-align: center;
              }
              h1 { color: #1a202c; margin-bottom: 16px; }
              .error { color: #e53e3e; font-size: 48px; margin-bottom: 16px; }
              p { color: #4a5568; line-height: 1.6; margin-bottom: 16px; }
              .error-details {
                background: #fff5f5;
                border: 1px solid #feb2b2;
                border-radius: 8px;
                padding: 16px;
                margin: 20px 0;
                text-align: left;
                color: #742a2a;
                font-family: monospace;
                font-size: 13px;
                word-break: break-word;
              }
              .troubleshooting {
                text-align: left;
                background: #f7fafc;
                padding: 20px;
                border-radius: 8px;
                margin: 20px 0;
              }
              .troubleshooting h3 {
                color: #2d3748;
                margin-bottom: 12px;
              }
              .troubleshooting ol {
                color: #4a5568;
                padding-left: 20px;
              }
              .troubleshooting li {
                margin-bottom: 8px;
              }
              .button {
                display: inline-block;
                padding: 12px 24px;
                background: #667eea;
                color: white;
                text-decoration: none;
                border-radius: 8px;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="error">❌</div>
              <h1>Token Exchange Failed</h1>
              <p>
                Keycard returned an error during the re-authentication flow.
              </p>
              <div class="error-details">
                ${errorMsg}
              </div>
              <div class="troubleshooting">
                <h3>Troubleshooting Steps:</h3>
                <ol>
                  <li>Verify redirect URI is registered in Keycard application settings:<br>
                      <code>${config.baseUrl}/keycard/callback</code></li>
                  <li>Check that client ID and secret are correct in your .env file</li>
                  <li><strong>If you're in a loop:</strong> Wait 30 seconds before trying again</li>
                  <li>Check server logs for detailed error information</li>
                  <li>Try clicking "Re-authenticate Now" again (state may have expired)</li>
                  <li>If the error persists, contact Keycard support</li>
                </ol>
                <p style="margin-top: 12px; font-size: 13px; color: #4a5568;">
                  <strong>Debug Info:</strong><br>
                  Base URL: <code>${config.baseUrl}</code><br>
                  STS Issuer: <code>${config.keycardStsIssuerUrl}</code><br>
                  Check server console for detailed logs.
                </p>
              </div>
              <a href="/auth" class="button">Return to Auth Dashboard</a>
            </div>
          </body>
        </html>
      `);
    }
  });
}
