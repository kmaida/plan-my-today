# Plan My Today MCP Server, MCP client, and chatbot (Todaygent)

TypeScript MCP server that aggregates to-dos from multiple sources (Google Calendar, Linear, Gmail, Google Docs, GitHub, Slack) using Keycard for OAuth 2.0 token exchange (RFC 8693).

## Architecture

- **Auth flow**: User authenticates via Keycard → Keycard issues delegated tokens → server exchanges tokens per-service
- **Token exchange**: `src/services/keycard-client.ts` (singleton) handles RFC 8693 token exchange with Keycard
- **Transport**: Streamable HTTP MCP transport via Express (`src/server.ts`)
- **Tools**: Each tool in `src/tools/` follows the register-function pattern, registered centrally in `src/tools/index.ts`
- **Config**: All env vars loaded via `src/config.ts`, never hardcode secrets
- **Observability**: OpenTelemetry instrumentation in `src/observability/`
- **UI**: Vite + React dashboard in `ui/`

## Key directories

```
src/
  config.ts          # All env var loading and validation
  server.ts          # Express + MCP transport setup
  index.ts           # Entry point
  services/          # Keycard client (singleton), action completion store, priority override store
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
- Required env vars: `KEYCARD_CLIENT_ID`, `KEYCARD_STS_ISSUER_URL` (single-tenant) or `ISSUER_BASE_DOMAIN` + `MCP_BASE_DOMAIN` (multi-tenant)
- Optional: `SLACK_EMOJI_NAME`, `USER_DISPLAY_NAME`, `ANTHROPIC_API_KEY`
- See `.env.example` for full list

## Working with Kim

- Call me "Kim" not "the user"
- I'm a senior JS/TS full-stack developer with IAM expertise, learning AI app development
- Explain *why* you're doing what you're doing so I can learn from changes
- I value learning by teaching — show the reasoning, not just the solution
- Resolve type errors cleanly; don't leave `any` casts unless unavoidable
