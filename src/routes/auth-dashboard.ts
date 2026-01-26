import type { Express, Request, Response } from "express";
import { config } from "../config";
import * as slackTokenStore from "../services/slack-token-store";

/**
 * Authentication dashboard - provides a web UI to check auth status and manage connections
 */
// Extract zone ID from issuer URL
function getZoneId(): string {
  const issuerUrl = config.keycardStsIssuerUrl;
  const match = issuerUrl.match(/https:\/\/([^.]+)\.keycard\.cloud/);
  return match ? match[1] : '';
}

// Generate service-specific Keycard authorization URLs
function getKeycardAuthUrl(service: string): string {
  const zoneId = getZoneId();
  if (!zoneId) return 'https://keycard.cloud';

  // Keycard manages connections at the zone level
  // Users need to go to their zone's connection settings
  return `https://${zoneId}.keycard.cloud/settings/connections`;
}

export function registerAuthDashboard(app: Express): void {
  // Main dashboard
  app.get("/auth", async (_req: Request, res: Response) => {
    const zoneId = getZoneId();
    const connectionsUrl = getKeycardAuthUrl('');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>To Do MCP Server - Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 800px;
      width: 100%;
      padding: 40px;
    }
    h1 {
      color: #1a202c;
      font-size: 32px;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #718096;
      margin-bottom: 32px;
    }
    .section {
      margin-bottom: 32px;
    }
    .section h2 {
      color: #2d3748;
      font-size: 20px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-grid {
      display: grid;
      gap: 12px;
    }
    .status-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      background: #f7fafc;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
    }
    .status-item .name {
      font-weight: 500;
      color: #2d3748;
    }
    .status-item .status {
      font-size: 14px;
      padding: 4px 12px;
      border-radius: 12px;
      font-weight: 500;
    }
    .status.keycard {
      background: #bee3f8;
      color: #2c5282;
    }
    .status.env {
      background: #c6f6d5;
      color: #22543d;
    }
    .alert {
      background: #fef5e7;
      border: 1px solid #f9e79f;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .alert-title {
      font-weight: 600;
      color: #7d6608;
      margin-bottom: 8px;
    }
    .alert-body {
      color: #7d6608;
      font-size: 14px;
      line-height: 1.6;
    }
    .alert-body ol {
      margin-left: 20px;
      margin-top: 8px;
    }
    .alert-body li {
      margin-bottom: 4px;
    }
    .button {
      display: inline-block;
      padding: 12px 24px;
      background: #667eea;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 500;
      transition: background 0.2s;
      border: none;
      cursor: pointer;
      font-size: 14px;
    }
    .button:hover {
      background: #5568d3;
    }
    .button.danger {
      background: #f56565;
    }
    .button.danger:hover {
      background: #e53e3e;
    }
    .button.secondary {
      background: #718096;
    }
    .button.secondary:hover {
      background: #4a5568;
    }
    .button-group {
      display: flex;
      gap: 12px;
      margin-top: 16px;
    }
    .link {
      color: #667eea;
      text-decoration: none;
      font-weight: 500;
    }
    .link:hover {
      text-decoration: underline;
    }
    code {
      background: #edf2f7;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
      color: #2d3748;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 Authentication Dashboard</h1>
    <p class="subtitle">Manage your MCP server connections</p>

    <div class="alert">
      <div class="alert-title">🔧 How Authentication Works</div>
      <div class="alert-body">
        <strong>Keycard STS manages all service connections:</strong>
        <ol>
          <li>Claude Desktop authenticates with Keycard and gets a JWT token</li>
          <li>This MCP server exchanges that JWT for service-specific tokens via Keycard STS</li>
          <li>If a service isn't connected in Keycard, token exchange fails</li>
        </ol>
        <br>
        <strong>To fix connection issues:</strong>
        <ol>
          <li>Run <strong>check-auth</strong> tool in Claude Desktop to see which services are failing</li>
          <li>Click <strong>"Re-authenticate Now"</strong> button below to trigger Keycard re-auth</li>
          <li><strong>Restart Claude Desktop</strong> to get a fresh JWT with updated permissions</li>
          <li>Run <strong>check-auth</strong> again to verify all services are working</li>
        </ol>
      </div>
    </div>

    <div class="section">
      <h2>🔑 Service Authentication</h2>
      <p style="color: #718096; margin-bottom: 16px; font-size: 14px;">
        All services are managed through <strong>Keycard STS token exchange</strong>. Connect services in your Keycard zone.
      </p>
      <div class="status-grid">
        <div class="status-item">
          <div>
            <span class="name">Google Calendar</span>
            <div style="font-size: 12px; color: #718096; margin-top: 4px;">Calendar events and availability</div>
          </div>
          <span class="status keycard">Keycard STS</span>
        </div>
        <div class="status-item">
          <div>
            <span class="name">Linear</span>
            <div style="font-size: 12px; color: #718096; margin-top: 4px;">Issues and project tracking</div>
          </div>
          <span class="status keycard">Keycard STS</span>
        </div>
        <div class="status-item">
          <div>
            <span class="name">Gmail</span>
            <div style="font-size: 12px; color: #718096; margin-top: 4px;">Email messages and threads</div>
          </div>
          <span class="status keycard">Keycard STS</span>
        </div>
        <div class="status-item">
          <div>
            <span class="name">Google Docs</span>
            <div style="font-size: 12px; color: #718096; margin-top: 4px;">Document action items</div>
          </div>
          <span class="status keycard">Keycard STS</span>
        </div>
        <div class="status-item">
          <div>
            <span class="name">GitHub</span>
            <div style="font-size: 12px; color: #718096; margin-top: 4px;">Pull requests and issues</div>
          </div>
          <span class="status keycard">Keycard STS</span>
        </div>
        <div class="status-item">
          <div>
            <span class="name">Slack</span>
            <div style="font-size: 12px; color: #718096; margin-top: 4px;">Reminders ${config.slackUserToken ? '(direct token)' : '(separate OAuth)'}</div>
          </div>
          ${config.slackUserToken
            ? '<span class="status env">✓ Configured</span>'
            : '<span class="status" style="background: #fed7d7; color: #9b2c2c;">Not Connected</span>'}
        </div>
      </div>
    </div>

    <div class="section" style="background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%); padding: 24px; border-radius: 12px; border: 2px solid #667eea;">
      <h2 style="margin-bottom: 8px;">🔄 Re-authenticate with Keycard</h2>
      <p style="color: #718096; margin-bottom: 16px; font-size: 14px;">
        <strong>Use this when services stop working.</strong> This triggers Keycard to refresh all service connections and issue new tokens.
      </p>
      <div class="button-group">
        <a href="/keycard/reauth" class="button" style="font-size: 16px; padding: 14px 28px; background: #667eea;">
          🔐 Re-authenticate Now
        </a>
      </div>
      <p style="color: #718096; margin-top: 12px; font-size: 13px;">
        ℹ️ After re-authentication, <strong>restart Claude Desktop</strong> to apply changes.
      </p>
    </div>

    <div class="section">
      <h2>🛠️ Manual Connection Management</h2>
      <p style="color: #718096; margin-bottom: 16px; font-size: 14px;">
        Manually connect or disconnect individual services in your Keycard zone.
      </p>
      <div class="button-group">
        <a href="${connectionsUrl}" target="_blank" class="button secondary">
          Open Keycard Connections →
        </a>
      </div>
      <p style="color: #718096; margin-top: 12px; font-size: 13px;">
        Your Keycard zone: <a href="https://${zoneId}.keycard.cloud" target="_blank" class="link">${zoneId}.keycard.cloud</a>
      </p>
    </div>

    <div class="section">
      <h2>📱 Quick Reference</h2>
      <p style="color: #4a5568; margin-bottom: 12px;">
        <strong>In Claude Desktop:</strong><br>
        • Run <code>check-auth</code> to see connection status<br>
        • Run <code>list-today-todos</code> to test all services<br>
        • Ask "what's on my plate today?" for a quick overview
      </p>
      <p style="color: #4a5568; margin-top: 12px;">
        <strong>MCP Endpoint:</strong> <code>${config.baseUrl}/mcp</code><br>
        <strong>Server Status:</strong> ✅ Running
      </p>
    </div>

    ${!config.slackUserToken ? `
    <div class="section">
      <h2>💬 Slack Setup (Optional)</h2>
      <p style="color: #718096; margin-bottom: 16px; font-size: 14px;">
        Slack uses a separate authentication flow (not Keycard STS). Set <code>SLACK_USER_TOKEN</code> in your environment variables or use the OAuth flow.
      </p>
      <div class="button-group">
        <a href="/slack/auth/start" class="button secondary">
          Connect Slack via OAuth
        </a>
      </div>
      <p style="color: #718096; margin-top: 12px; font-size: 13px;">
        Or add <code>SLACK_USER_TOKEN=xoxp-...</code> to your <code>.env</code> file for single-user setup.
      </p>
    </div>
    ` : ''}

    <div class="section">
      <h2>🔄 Troubleshooting</h2>
      <p style="color: #4a5568; margin-bottom: 12px; font-size: 14px;">
        Clear server-side tokens if you're experiencing persistent authentication issues.
      </p>
      <button onclick="clearAuth()" class="button danger">
        Clear All Server Tokens
      </button>
    </div>
  </div>

  <script>
    async function clearAuth() {
      if (!confirm('This will clear all server-side authentication tokens. Continue?')) {
        return;
      }

      try {
        const response = await fetch('/auth/clear', { method: 'POST' });
        if (response.ok) {
          alert('✅ Authentication cleared! Restart Claude Desktop to re-authenticate.');
          location.reload();
        } else {
          alert('❌ Failed to clear authentication');
        }
      } catch (error) {
        alert('❌ Error: ' + error.message);
      }
    }
  </script>
</body>
</html>
    `;

    res.send(html);
  });

  // Clear all server-side tokens
  app.post("/auth/clear", async (_req: Request, res: Response) => {
    try {
      // Clear Slack tokens by removing the file
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const tokenFile = path.join(process.cwd(), "data", "slack-tokens.json");

      try {
        await fs.unlink(tokenFile);
      } catch {
        // File might not exist, that's OK
      }

      res.json({ success: true, message: "All tokens cleared" });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });
}
