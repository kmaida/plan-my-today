# Plan My Today MCP Server, MCP client, and chatbot (Todaygent)

TypeScript MCP server that aggregates to-dos from multiple sources (Google Calendar, Linear, Gmail, Google Drive, GitHub, Slack) using Keycard for OAuth 2.0 token exchange (RFC 8693).

## Architecture

- **Auth flow**: User authenticates via Keycard → Keycard issues delegated tokens → server exchanges tokens per-service
- **Token exchange**: `src/services/keycard-client.ts` (singleton) handles RFC 8693 token exchange with Keycard
- **Agent delegation (A2A)**: `src/services/roibot-a2a-client.ts` — A2A client that hands off a task to ROIbot's `/api/agent` endpoint. Exchanges the user's token for a ROIbot-audience token per call, then drives `@a2a-js/sdk`'s `ClientFactory` with a Bearer-injecting fetch
- **Transport**: Streamable HTTP MCP transport via Express (`src/server.ts`)
- **Tools**: Each tool in `src/tools/` follows the register-function pattern, registered centrally in `src/tools/index.ts`
- **Config**: All env vars loaded via `src/config.ts`, never hardcode secrets
- **Observability**: OpenTelemetry instrumentation in `src/observability/`
- **UI**: Vite + React dashboard in `ui/`

## Keycard wiring (gotchas)

These are non-obvious things that have already burned us; preserve them.

- **`requireBearerAuth` MUST pass `issuers`** ([src/server.ts](src/server.ts)). `@keycardai/mcp@0.4+` throws at module load when neither `verifier` nor `issuers` is supplied. We pass `issuers: config.keycardIssuerUrl`.
- **`requiredScopes` stays `[]`, NOT `["mcp:tools"]`.** The UI authorize call ([ui/src/auth/config.ts](ui/src/auth/config.ts)) requests `scope: "openid profile"` only — switching the middleware to enforce `mcp:tools` would 403 every login. To adopt `["mcp:tools"]`: first widen the UI authorize scope and confirm the zone issues `mcp:tools` to PMT's Application.
- **`scopesSupported` in `mcpAuthMetadataRouter` ≠ enforcement.** It's advertised at `.well-known/oauth-protected-resource` so clients know what to request. Separate from `requiredScopes`.
- **Bearer middleware does a resource-binding check (origin-level in `@keycardai/mcp@0.5+`).** If a JWT's `resource` claim is set, it must match the request's URL **origin** (`${req.protocol}://${req.host}`, e.g. `http://localhost:9005`) — not the full URL. The UI sends `resource: AUTH_CONFIG.resource` (from `VITE_MCP_RESOURCE` or default). If origins drift between authorize and the served endpoint, every authed request 401s. Path drift (`/mcp` vs `/api/tools/...`) no longer matters since 0.5 (it did in 0.4).
- **Stay on `TokenExchangeClient`, NOT `AuthProvider`.** `AuthProvider.exchangeTokens(subjectToken, resources)` from `@keycardai/mcp/server/auth/provider` has no `scope` parameter — designed for the brokered-credentials template's "one upstream, fixed zone-configured scope" pattern. PMT is a fan-out aggregator: each tool requests least-privilege scopes (e.g. `["...calendar.readonly"]`) via `exchangeToken(authInfo, resource, scopes)`. Switching to `AuthProvider` would silently widen every token to whatever the zone defaults to per resource. Revisit only if the SDK adds per-call scope, or PMT moves to zone-configured scope-per-resource.
- **`ROIBOT_AGENT_ENDPOINT` is used as BOTH the token exchange `resource` AND the A2A client URL** ([src/services/roibot-a2a-client.ts](src/services/roibot-a2a-client.ts)). The value must exact-match what's registered as the resource `identifier` in the Keycard zone (including the `/api/agent` path) — STS uses exact string matching. Mismatch → `invalid_target`.
- **For an MCP/A2A Resource, the zone's `credential_provider_id` MUST be a `keycard-sts` provider, not `keycard-vault`.** Vault providers broker static secrets and cannot mint OAuth tokens — using one produces `invalid_target` on token exchange.

## Key directories

```
src/
  config.ts          # All env var loading and validation
  server.ts          # Express + MCP transport setup
  index.ts           # Entry point
  services/          # Keycard client (singleton), ROIbot MCP client, action completion store, priority override store
  tools/             # One file per tool, plus list-all-tasks-today/
  tools/index.ts     # Central tool registry (TOOL_REGISTRY array)
  middleware/         # Auth middleware
  observability/     # Logger (Winston), OpenTelemetry setup
  types/             # Auth types, shared interfaces
  utils/             # Shared helpers (date parsing, filtering, task store)
ui/                  # Vite + React dashboard and Todaygent chat agent
```

## Commands

- `npm run dev` — Start dev server with nodemon + ts-node (port 9005)
- `npm run build` — TypeScript compile to `dist/`
- `npm run build:all` — Build server + UI
- `npm run start:prod` — Run compiled `dist/index.js`
- `npm test` — Jest tests
- `npm run test:integration` — Integration tests (uses --forceExit)
- `npm run lint` — Biome lint
- `npm run lint:fix` — Biome lint with auto-fix
- `npm run format` — Biome format
- `npm run check` — Biome check (lint + format)

## Adding a new tool

1. Create `src/tools/your-tool.ts` with a `registerYourTool(mcpServer: McpServer)` export
2. Use Zod for input validation schemas
3. Check `authInfo` before accessing protected resources
4. Return `{ content: [{ type: "text", text: "..." }] }`
5. Add to `TOOL_REGISTRY` array in `src/tools/index.ts`
6. Include helpful error messages with troubleshooting steps

## UI

- Vite + React (no framework), plain CSS with BEM-style class names
- Design tokens in `ui/src/styles/design-tokens.css` — light and dark mode via `[data-theme]` attribute
- Theme toggle (light/system/dark) via `ui/src/hooks/useTheme.ts`
- Chat agent ("Todaygent") in `ui/src/chat/` — agentic loop with tool calls, streaming, chat persistence
- Shared `Chevron` component for all expand/collapse indicators (animated SVG, supports right/down/left)
- `Toast` component for dismissal/restore feedback
- See `ui/README.md` for full UI architecture

## Code conventions

- Biome for linting/formatting (2-space indent, double quotes, semicolons, ES5 trailing commas)
- JSDoc comments on functions
- Use `satisfies` for type narrowing where applicable
- Use `getLogger()` for observability, include request IDs in errors
- DRY but don't over-abstract — keep it readable
- Path aliases: `@/*` maps to `src/*` (see tsconfig.json paths)
- CommonJS module system (`"type": "commonjs"`)

## Environment

- Node.js + TypeScript (ES2020 target)
- Required env vars: `KEYCARD_CLIENT_ID`, `KEYCARD_CLIENT_SECRET`, `KEYCARD_URL`
- Optional: `SLACK_EMOJI_NAME`, `USER_DISPLAY_NAME`, `ANTHROPIC_API_KEY`, `ROIBOT_MCP_ENDPOINT`
- See `.env.example` for full list

## Working with Kim

- Call me "Kim" not "the user"
- I'm a senior JS/TS full-stack developer with IAM expertise, learning AI app development
- Explain *why* you're doing what you're doing so I can learn from changes
- I value learning by teaching — show the reasoning, not just the solution
- Resolve type errors cleanly; don't leave `any` casts unless unavoidable
