# Session 2: Configure Keycard Zone + Test Token Exchange

**Date:** 2026-02-07
**Goal:** Configure providers and resources in Keycard zone, test token exchange with `kat` CLI, confirm we can get valid provider tokens for all services.
**Status:** ✅ Complete

---

## What We Did

1. **Learned how `kat` CLI works** — two commands: `login` (OAuth2 PKCE browser flow) and `exchange` (RFC 8693 token exchange)
2. **Switched zone sign-in provider to Google OAuth** for better SSO experience
3. **Configured `kat` env vars** — `CLIENT_ID`, `CLIENT_SECRET`, `ISSUER`, `AUTH_RESOURCE` in `infra/output/cli.env`
4. **Built `kat`** — installed Go (`brew install go`), ran `make build`
5. **Hit `offline_access` scope error** — Google doesn't support `offline_access` as a scope (it uses `access_type=offline` parameter instead). Removed from all Google resources.
6. **Successful login** — Google OAuth → Keycard → consent for all resources → success
7. **Successful token exchange** — all 6 resources returned valid tokens

---

## Token Exchange Results

```
RESOURCE                                           STATUS       HASH       API TEST
---------------------------------------------------------------------------------------------------------
https://www.googleapis.com/drive/v3                ✓ 421ms      b2ec8289   OK - drive ✓ (/about)
https://driveactivity.googleapis.com               ✓ 416ms      41035c4e   -
https://www.googleapis.com/calendar/v3             ✓ 409ms      2323dd40   OK - calendar ✓ (/calendarList)
https://www.googleapis.com/gmail/v1                ✓ 345ms      131cae88   -
https://api.github.com                             ✓ 408ms      f6478d6b   OK - github ✓ (/user)
https://api.linear.app                             ✓ 377ms      f3817d3c   -
```

All exchanges succeeded. Drive, Calendar, and GitHub show API validation because `kat` has built-in test endpoints for those. Gmail, Drive Activity, and Linear exchanged successfully but `kat` doesn't validate them (shows `-`).

---

## Key Question Answered

**Can we get valid Google Calendar, Gmail, Linear, and GitHub tokens through Keycard?** YES.

---

## Keycard Zone Configuration

- **Zone:** `https://chzabf1qgzjia0wfd17eietx70.keycard.cloud`
- **Sign-in Provider:** Google OAuth
- **Application:** ToDo Agent
  - Identifier: `https://unpreferable-cropless-dede.ngrok-free.dev/mcp`
  - Redirect URLs: ngrok callback, Cursor MCP callback, `http://localhost:8081/callback` (for `kat`)
  - Dependencies: all 6 resources below

### Resources Configured

| Resource | Identifier | Notes |
|----------|-----------|-------|
| Google Drive | `https://www.googleapis.com/drive/v3` | No `offline_access` |
| Google Drive Activity | `https://driveactivity.googleapis.com` | No `offline_access` |
| Google Calendar | `https://www.googleapis.com/calendar/v3` | No `offline_access` |
| Gmail | `https://www.googleapis.com/gmail/v1` | No `offline_access` |
| GitHub | `https://api.github.com` | |
| Linear | `https://api.linear.app` | |

---

## Gotchas & Lessons

### `offline_access` Doesn't Work with Google (on Production Keycard)
- Google OAuth uses `access_type=offline` as a request **parameter**, not `offline_access` as a **scope**
- Adding `offline_access` to Google resources causes `invalid_scope` errors during consent
- Possible that Keycard localdev handles this translation but production doesn't yet — worth asking coworker
- **For now:** removed `offline_access` from all Google resources. Token exchange works without it, but tokens won't auto-refresh.

### `kat` CLI Setup Notes
- Requires Go: `brew install go`
- Build: `make build` in `poc-keycard-auth-toolbox`
- Env vars need `export` prefix for `source` to work (direnv `dotenv` format doesn't use `export`)
- Config lives in `infra/output/cli.env` (secrets) and `.envrc` (`AUTH_RESOURCE`)
- Token saved to `.kat-token` for reuse by `exchange` command
- direnv not installed on Kim's machine yet — sourcing manually for now

---

## Next: Session 3

### Branch Todo MCP Server + keycard-connect Integration
- Branch todo-mcp-server, add `@keycardlabs/connect` dependency
- Replace per-service OAuth flows with Keycard login + token exchange
- Key integration points:
  - `KeycardMCPAuth` for login/session management
  - Direct RFC 8693 calls to `{zone}/oauth/2/token` for provider tokens
- Get basic flow working: Keycard login → token exchange for each service → API calls succeed
- Token refresh is a known gap (no `offline_access`) — document but don't block on it
