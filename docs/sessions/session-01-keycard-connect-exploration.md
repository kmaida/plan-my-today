# Session 1: Running keycard-connect End-to-End

**Date:** 2026-02-07
**Goal:** Run coworker's app that uses keycard-connect, observe the working auth flow, document the integration pattern before reading code in depth.
**Status:** ✅ Complete

---

## What We Did

1. **Explored both repos** (`poc-keycard-connect` and `poc-gtm-dashboard`) to understand the architecture
2. **Reviewed coworker's Keycard console** configuration (screenshots captured)
3. **Set up a new Keycard zone** with Google OAuth as the sign-in provider
4. **Got the GTM dashboard running** with Keycard web auth (browser flow)
5. **Got the MCP server running** with Keycard MCP auth (Claude Desktop flow)
6. **Reviewed token refresh demo transcript** — confirmed Keycard is a full token broker
7. **Found the token exchange API** in `poc-keycard-auth-toolbox` (the `kat` CLI)

Both auth paths validated end-to-end on Kim's machine.

---

## Repos

| Repo | Path | Purpose |
|------|------|---------|
| `poc-keycard-connect` | `/Users/kimmaida/Documents/Development/poc-keycard-connect` | The `@keycardlabs/connect` library |
| `poc-gtm-dashboard` | `/Users/kimmaida/Documents/Development/poc-gtm-dashboard` | Example app consuming the library |
| `poc-keycard-auth-toolbox` | `/Users/kimmaida/Documents/Development/poc-keycard-auth-toolbox` | CLI for testing token exchange (`kat` tool) |

**Symlink required:** The dashboard references `file:../keycard-connect` in package.json. Created symlink:
```
/Users/kimmaida/Documents/Development/keycard-connect -> poc-keycard-connect
```

**Build required:** The connect library is TypeScript. Must build before the dashboard can use it:
```bash
cd poc-keycard-connect && npm install && npm run build
```

---

## Keycard Console Setup (Kim's Zone)

### Zone
- **URL:** `https://gh4lzcp6vv4wemeftb185fkptc.keycard.cloud`
- **Sign-in Provider:** Google OAuth (not the Keycard default)

### Google OAuth Provider
- Uses the same Google OAuth client as the todo-mcp-server
- Issuer URL: `https://accounts.google.com`
- Client ID and secret stored in Keycard console
- Redirect URI added to Google OAuth app for Keycard's callback

### Application
- **Identifier:** `http://localhost:3000`
- **Redirect URLs:**
  - `http://localhost:3000/auth/callback` (web UI auth server)
  - `http://localhost:3002/auth/callback` (MCP server stdio callback)
- **Credentials:** Client Secret generated
- **Dependencies:** None (this app only needs Keycard identity, no downstream provider tokens)
- **Provides:** A resource (required for the flow to work — forgot this initially and got scope errors)

### Gotcha: Scopes
The connect library requests `openid profile email` scopes. These are standard OpenID Connect scopes supported by Google OAuth. If the zone uses the default Keycard provider (not Google), these scopes aren't recognized and you get `invalid_scope` errors. **Solution:** Use Google OAuth as the zone's sign-in provider.

---

## How keycard-connect Works (Observed)

### Architecture

```
@keycardlabs/connect
├── /server   → Express middleware (web app auth)
├── /react    → React hooks (useAuth)
└── /mcp      → MCP tools (KeycardMCPAuth class)
```

### KeycardMCPAuth — The Key Class

This is the main integration point for MCP servers. Usage pattern (~10 lines):

```javascript
import { KeycardMCPAuth } from '@keycardlabs/connect/mcp';

const auth = new KeycardMCPAuth({
  zone: process.env.KEYCARD_ZONE,
  serverName: 'My Server',
  clientId: process.env.KEYCARD_CLIENT_ID,
  clientSecret: process.env.KEYCARD_CLIENT_SECRET,
  callbackUrl: 'http://localhost:3002/auth/callback',
});

// Registers: keycard_login, check_auth_status, keycard_session, keycard_logout
auth.registerTools(mcpServer);

// Start HTTP server for OAuth callbacks (needed for stdio transport)
const callbackApp = auth.createCallbackApp(express);
callbackApp.listen(3002);
```

### Auth Flow (stdio mode — what we'd use)

1. Claude calls `keycard_login` tool
2. Tool creates session with UUID state, returns MCP Apps UI (rendered in Claude Desktop)
3. User clicks "Continue to Login" → browser opens to `http://localhost:3002/auth/login?state={uuid}`
4. `/auth/login` redirects to Keycard IdP (`{zone}/oauth/2/authorize`) with PKCE challenge
5. Keycard IdP redirects to Google OAuth (zone's sign-in provider)
6. User authenticates with Google
7. Google redirects back to Keycard, Keycard redirects to `http://localhost:3002/auth/callback` with auth code
8. Callback handler exchanges code for tokens (with PKCE verifier), decodes ID token for user info
9. Session marked as authenticated in memory
10. `check_auth_status` tool polls session, finds it authenticated, returns success
11. MCP Apps UI updates to show "Signed in as {email}"
12. Browser success page auto-closes after 3 seconds

### Auth State Management

- Sessions stored in-memory (`Map<string, AuthSession>`)
- `auth.isAuthenticated()` checks current session (stdio mode)
- `auth.getCurrentUser()` returns user info
- `auth.getAccessToken()` returns the Keycard access token
- Tools can check auth via `requireAuth(extra)` helper pattern

---

## Confirmed: keycard-connect Is Identity Only

Reviewed all source files in `poc-keycard-connect/src/`:
- `shared/types.ts` — User, Session, TokenResponse, ConnectConfig. No resource/grant/provider types.
- `server/index.ts` — Express middleware for login/callback/logout/me. Cookie session management only.
- `server/session.ts` — Session creation from ID tokens, validation, revocation. No provider tokens.
- `server/oauth.ts` — PKCE, authorize URL, auth code exchange. The `grant_type` is `authorization_code` (standard OAuth), not token exchange.
- `mcp/index.ts` — KeycardMCPAuth class. Login/logout/session tools. No resource token tools.

**`AccessContext` and `AuthProvider.grant()` are legacy stubs.** They exist in the codebase (lines 2207-2320) under a "Legacy API (kept for backwards compatibility)" section, but:
- `grant()` accepts a `_resources` parameter (underscore = unused) and creates an empty `AccessContext` — never fetches any tokens
- `AccessContext` has `setToken(resource, token)` and `access(resource)` methods, but nothing populates them
- The entire `AuthProvider` class is marked `@deprecated Use KeycardMCPAuth for MCP Apps flow`
- This was scaffolding for where token exchange *would* go, but it's not implemented

**keycard-connect does NOT have token exchange functionality.** The provider token exchange (RFC 8693 style, as shown in the demo) is a direct call to the Keycard STS endpoint. Your app calls it yourself.

---

## Keycard Token Refresh Feature (From Demo Transcript)

Reviewed a demo transcript from a coworker showing Keycard's upcoming provider token refresh feature. This changes the architecture picture significantly.

### How It Works

1. User authenticates via Keycard (the flow we validated today)
2. Keycard creates **grants** for each downstream resource the app depends on (Google, Linear, GitHub, etc.)
3. Each grant holds an access token (and optionally a refresh token) from the provider
4. When the app needs a provider token, it calls Keycard STS's **token exchange endpoint** (RFC 8693 style)
5. Keycard returns a valid provider access token
6. If the backing access token is expired but the grant is refreshable, Keycard automatically refreshes it using the provider's refresh token — transparently to the app

### Key Details

- **Grants are per-resource, per-user** — separate grants for Google Calendar, Linear, GitHub, etc.
- **Refreshable grants** require the right scope on the resource (e.g., `offline_access` for OpenID providers)
- **Proactive refresh at half-life** — if a token expires in 1 hour, Keycard refreshes after 30 minutes
- **Graceful degradation** — if refresh fails but token is still valid, returns existing token. If both fail, grant marked expired, user must re-login.
- **Audit trail** — grant refreshes (success and failure) appear in zone audit logs
- **GitHub explicitly supported** as a provider (confirmed in demo)
- **Multiple providers tested** in demo: Okta, PingFederate, Entra (Azure AD), GitHub

### What This Means for Todo MCP Server

**Keycard is a full token broker, not just an identity layer.** This replaces the entire existing token management system:

| Current (via Cursor) | Future (via Keycard) |
|----------------------|---------------------|
| Each service has its own OAuth flow | Single Keycard login creates grants for all services |
| Refresh tokens stored locally | Keycard holds all refresh tokens |
| Manual re-auth when tokens expire | Keycard refreshes automatically at half-life |
| Token lifecycle managed by the app | Token lifecycle managed by Keycard |
| Tied to Cursor/Claude Desktop MCP config | Independent — works from any app |

### Configuration Required in Keycard Console

To use this for the todo-mcp-server, we'd need:

1. **Providers** configured at zone level: Google OAuth, Linear, GitHub (each with their OAuth client ID/secret)
2. **Resources** defined for each API surface: e.g., "Google Calendar" with calendar scopes, "Gmail" with mail scopes, "Linear API", "GitHub API"
3. **Resources must include refresh scopes** (e.g., `offline_access` or provider equivalent) to make grants refreshable
4. **Application Dependencies** — the todo-mcp-server app declares dependencies on each resource
5. **Provider IDPs configured correctly** — redirect URIs, allowed scopes, etc. on the Google/Linear/GitHub side

---

## ✅ FOUND: Token Exchange API (from poc-keycard-auth-toolbox)

The `poc-keycard-auth-toolbox` repo (`keycardlabs/poc-keycard-auth-toolbox`) contains the `kat` CLI — the exact tool from the demo. The token exchange call is RFC 8693:

```
POST {zone}/oauth/2/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {base64(clientId:clientSecret)}

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token={keycard_access_token}
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&resource={resource_identifier}
```

**Parameters:**
- `grant_type`: `urn:ietf:params:oauth:grant-type:token-exchange` (RFC 8693)
- `subject_token`: The Keycard access token (from login)
- `subject_token_type`: `urn:ietf:params:oauth:token-type:access_token`
- `resource`: The resource identifier (e.g., `https://api.github.com`, `https://www.googleapis.com/calendar/v3`)
- **Auth**: HTTP Basic Auth with client ID and client secret

**Response**: Provider access token (e.g., a Google OAuth token, a GitHub token)

**The full flow for todo-mcp-server:**
1. Login via keycard-connect → get Keycard access token
2. Token exchange → POST to zone token endpoint with access token + resource identifier → get provider token
3. Call the provider API with the returned token
4. Keycard handles token refresh behind the scenes (grants auto-refresh at half-life)

---

## Key Differences: GTM Dashboard vs Todo MCP Server

| Aspect | GTM Dashboard | Todo MCP Server |
|--------|--------------|-----------------|
| **Auth needed** | Keycard identity only | Keycard identity + Google + Linear + GitHub + Slack tokens |
| **Dependencies** | None | Google, Linear, GitHub (Slack uses user token) |
| **What keycard-connect provides** | User login, session management | Same — identity only |
| **Token exchange** | Not needed | Direct call to `{zone}/oauth/2/token` with RFC 8693 grant type |

---

## Claude Desktop MCP Config

Added to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
"gtm-dashboard": {
  "command": "node",
  "args": [
    "/Users/kimmaida/Documents/Development/poc-gtm-dashboard/mcp-server.js"
  ],
  "env": {
    "KEYCARD_ZONE": "https://gh4lzcp6vv4wemeftb185fkptc.keycard.cloud",
    "KEYCARD_CLIENT_ID": "your_client_id",
    "KEYCARD_CLIENT_SECRET": "your_client_secret"
  }
}
```

Note: `mcp-server.js` does NOT import `dotenv`, so env vars must be passed via the MCP config, not the `.env` file.

---

## Running the GTM Dashboard (Reference)

### Prerequisites
1. Symlink: `ln -s poc-keycard-connect keycard-connect` in Development directory
2. Build connect: `cd poc-keycard-connect && npm install && npm run build`
3. `.env` file in `poc-gtm-dashboard/` with `KEYCARD_ZONE`, `KEYCARD_CLIENT_ID`, `KEYCARD_CLIENT_SECRET`

### Start Web App
```bash
cd poc-gtm-dashboard
npm install
npm run start:auth
# Opens on http://localhost:3000
```

### Start MCP Server
Add config to Claude Desktop (see above), restart Claude Desktop.
Keep the auth server running — MCP server talks to it on port 3000.

---

## Next Sessions

### Session 2: Configure Keycard Zone + Test Token Exchange
- Configure providers in Kim's Keycard zone: Google OAuth (with Calendar/Gmail/Drive scopes), Linear, GitHub
- Create resources with refresh scopes (e.g., `offline_access`) to enable refreshable grants
- Add dependencies to the todo-mcp-server application
- Use `kat` CLI to test: login → token exchange → API call for each provider
- Reference: `poc-keycard-auth-toolbox` repo, `cmd/kat/main.go`
- **Key question to answer:** Can we get valid Google Calendar, Gmail, Linear, and GitHub tokens through Keycard?

### Session 3: Branch Todo MCP Server + keycard-connect Integration
- Branch todo-mcp-server, add keycard-connect dependency
- Replace per-service OAuth flows with Keycard token exchange
- Get basic flow working: Keycard login → token exchange for each service → API calls succeed
- Verify token refresh works (expire a token, confirm Keycard refreshes automatically)

### Session 4+: Chatbot Layer
- Only after Session 3 succeeds
- Add Claude API integration (Anthropic SDK with tool_use)
- Chat UI (message input, streaming responses)
- Agentic loop (user message → Claude → tool calls → execute → repeat)
