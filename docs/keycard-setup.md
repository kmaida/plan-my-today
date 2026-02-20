# Keycard Setup Guide

Plan My Today uses [Keycard](https://keycard.ai) for OAuth 2.0 token exchange ([RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693)). Instead of managing separate OAuth flows for each data source, the app authenticates once through Keycard, then exchanges that token for service-specific tokens (Google, Linear, GitHub, Slack) on the fly. Keycard handles token lifecycle, refresh, and grant management.

This guide walks through the full setup: creating third-party OAuth apps, configuring providers and resources in your Keycard zone, and wiring up the application.

## Prerequisites

- A **Keycard account** with access to the [Keycard Console](https://console.keycard.ai)
- A **Keycard zone** with the sign-in provider set to **Google OAuth**

> **Why Google OAuth as sign-in provider?** This app authenticates users via Google. The zone's sign-in provider must match — using the default Keycard provider will cause `invalid_scope` errors during login.

## 1. Create Third-Party OAuth Apps

Before configuring Keycard, you need OAuth apps registered with each service. These give you the client IDs and secrets that Keycard uses to broker tokens.

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. Create an **OAuth 2.0 Client ID** (type: Web application)
3. Add the Keycard callback as an authorized redirect URI (your zone's OAuth callback URL)
4. Enable the following APIs in your Google Cloud project:
   - Google Calendar API
   - Gmail API
   - Google Drive API
   - Google Drive Activity API
   - Google Docs API (used by meeting notes — accessed via the Drive resource, no separate Keycard resource needed)
5. Note your **Client ID** and **Client Secret** — you'll register these as a provider in Keycard

### Linear

1. In Linear, go to **Settings → API → OAuth Applications**
2. Create a new OAuth application
3. Set the callback URL to your Keycard zone's OAuth callback
4. Required scope: `read`
5. Note the **Client ID** and **Client Secret**

### GitHub

1. Go to **GitHub Settings → Developer settings → GitHub Apps**
2. Create a new GitHub App with these permissions:
   - **Metadata**: Read-only
   - **Issues**: Read-only
   - **Pull requests**: Read-only
   - **Contents**: Read-only
3. Set the callback URL to your Keycard zone's OAuth callback
4. **Install the app** on your GitHub account (or the org you want to pull issues/PRs from)
5. Note the **Client ID** and **Client Secret**

> GitHub App permissions control what the token can access — no additional scopes are needed in Keycard's resource configuration.

### Slack

1. Go to [Slack API](https://api.slack.com/apps) → Create New App
2. Add the following **User Token Scopes** under OAuth & Permissions:
   - `search:read`
   - `reactions:read`
   - `users:read`
   - `channels:read`
   - `groups:read`
   - `im:read`
   - `mpim:read`
3. Set the redirect URL to your Keycard zone's OAuth callback
4. Note the **Client ID** and **Client Secret**
5. **Install the app** to your Slack workspace (OAuth & Permissions → Install to Workspace)

## 2. Configure Keycard Zone

### Add Providers

In the Keycard Console, register each OAuth app as a **provider** in your zone:

1. **Google OAuth** — Client ID, Client Secret, issuer URL: `https://accounts.google.com`
2. **Linear** — Client ID, Client Secret from the Linear OAuth app
3. **GitHub** — Client ID, Client Secret from the GitHub App
4. **Slack** — Client ID, Client Secret from the Slack app

### Add Resources

Resources define the API surfaces the app can exchange tokens for. Create one resource per API:

| Resource | Identifier | Scopes |
|----------|-----------|--------|
| Google Calendar | `https://www.googleapis.com/calendar/v3` | `https://www.googleapis.com/auth/calendar.readonly` |
| Gmail | `https://gmail.googleapis.com` | `https://www.googleapis.com/auth/gmail.readonly` |
| Google Drive | `https://www.googleapis.com/drive/v3` | `https://www.googleapis.com/auth/drive.readonly` |
| Google Drive Activity | `https://driveactivity.googleapis.com` | `https://www.googleapis.com/auth/drive.activity.readonly` |
| GitHub | `https://api.github.com` | *(none — permissions controlled by GitHub App)* |
| Linear | `https://api.linear.app` | `read` |
| Slack | `https://slack.com/api` | `search:read`, `reactions:read`, `users:read`, `channels:read`, `groups:read`, `im:read`, `mpim:read` |

### Create Application

1. In the Keycard Console, create a new **Application**
2. Set the **Identifier** to `http://localhost:9005/mcp`
3. Add **Redirect URLs**:
   - `http://localhost:9005/auth/callback` (production build)
   - `http://localhost:9006/auth/callback` (Vite dev server)
4. Under **Dependencies**, add all the resources you created above
5. Generate a **Client Secret**
6. Note the **Client ID** and **Client Secret** — these go in your `.env` file

## 3. Configure Environment

Add the Keycard credentials to your `.env` file (see `.env.example`):

```bash
KEYCARD_STS_ISSUER_URL=https://your-zone-id.keycard.cloud
KEYCARD_CLIENT_ID=your-client-id
KEYCARD_CLIENT_SECRET=your-client-secret
```

- `KEYCARD_STS_ISSUER_URL` — Your zone URL from the Keycard Console (Zone Settings)
- `KEYCARD_CLIENT_ID` — The Application Client ID
- `KEYCARD_CLIENT_SECRET` — The Application Client Secret

## How Token Exchange Works

Once configured, the flow is:

1. User clicks **Sign in with Google** in the browser
2. Browser runs OAuth 2.0 PKCE flow against Keycard → gets a Keycard access token
3. When the server needs a service token (e.g., Google Calendar), it calls Keycard's token exchange endpoint:
   ```
   POST {zone}/oauth/2/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
   &subject_token={keycard_access_token}
   &subject_token_type=urn:ietf:params:oauth:token-type:access_token
   &resource={resource_identifier}
   &client_id={client_id}
   &client_secret={client_secret}
   ```
4. Keycard returns a valid provider token (e.g., a Google OAuth token)
5. The server uses that token to call the service API
6. Keycard handles token refresh transparently — if the backing token is expired but the grant is refreshable, Keycard refreshes it automatically

The implementation lives in `src/services/keycard-client.ts` (singleton).

## Gotchas

### Google and `offline_access`

Google OAuth does **not** support `offline_access` as a scope. Google uses `access_type=offline` as a request parameter instead. Do not add `offline_access` to any Google resource configuration in Keycard — it will cause `invalid_scope` errors during the consent flow.

### Slack Custom Emoji

To track Slack messages saved with a custom emoji reaction, create the emoji in your Slack workspace first (Customize Slack → Add Custom Emoji), then set `SLACK_EMOJI_NAME` in `.env`. Defaults to `mcp-todo-reminder`.
