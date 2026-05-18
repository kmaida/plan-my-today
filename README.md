# Plan My Today

A **daily planning dashboard and AI chat agent** powered by an MCP server. Aggregates tasks from Google Calendar, Linear, Gmail, GitHub, Slack, Google Drive, and meeting notes into a single prioritized view with an embedded AI agent ("Todaygent") that helps you plan your day.

Built with [Keycard](https://keycard.ai) for OAuth 2.0 token exchange (RFC 8693).

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Browser (localhost:9005)                                │
│  ┌────────────────────────┐  ┌────────────────────────┐  │
│  │   Task Dashboard       │  │   Todaygent Chat       │  │
│  │   (priority/source     │  │   (AI planning agent   │  │
│  │    grouped tasks)      │  │    via Claude API)     │  │
│  └──────────┬─────────────┘  └──────────┬─────────────┘  │
│             │   OAuth + REST / MCP       │               │
└─────────────┼────────────────────────────┼───────────────┘
              │                            │
┌─────────────▼────────────────────────────▼───────────────┐
│  Express Server (port 9005)                              │
│  ├── MCP endpoint (/mcp)                                 │
│  ├── REST API (/api/tools/:toolName)                     │
│  ├── Chat proxy (/api/chat → Claude API)                 │
│  └── Static UI (ui/dist/)                                │
│             │                                            │
│             ▼                                            │
│  ┌─ Keycard ─────────────────────────────┐               │
│  │  OAuth 2.0 + Token Exchange (RFC 8693)│               │
│  │  ├── Google (Calendar, Gmail, Drive)  │               │
│  │  ├── Linear                           │               │
│  │  ├── GitHub                           │               │
│  │  └── Slack                            │               │
│  └───────────────────────────────────────┘               │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- **Node.js 20+** and **npm**
- **[Keycard](https://keycard.ai) account** with a configured zone (for OAuth token exchange)
- **Anthropic API key** (for the Todaygent chat agent)

### 1. Clone & Install

```bash
git clone https://github.com/kmaida/plan-my-today.git
cd plan-my-today
npm install
```

> The UI dependencies are installed automatically as part of `npm run build:all`.

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

At minimum you need:

```bash
# ── Required: Keycard OAuth ───────────────────
KEYCARD_URL=https://your-zone-id.keycard.cloud
KEYCARD_CLIENT_ID=your-client-id
KEYCARD_CLIENT_SECRET=your-client-secret

# ── Required for chat agent ───────────────────
ANTHROPIC_API_KEY=your-anthropic-api-key
```

See [Environment Variables](#environment-variables) for the full list.

### 3. Run

**Production (recommended for daily use):**
```bash
npm run build:all
npm run start:prod
# → http://localhost:9005
```

**Development (with hot reload):**
```bash
# Terminal 1: MCP server (auto-restarts on file changes)
npm run dev

# Terminal 2: UI dev server (Vite HMR)
cd ui && npm run dev
# → http://localhost:9006 (proxies API to 9005)
```

**One-step launch (macOS):**
```bash
npm run plan-my-today
# Builds, starts the server, and opens the browser
```

**Install as a PWA:** Open the app in Chrome and click the install icon in the address bar. Once installed, `npm run plan-my-today` will open the standalone PWA window automatically.

### 4. Sign In

1. Open `http://localhost:9005` (prod) or `http://localhost:9006` (dev)
2. Click **Sign in with Google** — authenticates through Keycard
3. Grant access to each service (Calendar, Gmail, Linear, etc.)
4. Your tasks load automatically

## Features

### Task Dashboard
- Tasks from 8 sources: Calendar, Linear, Gmail, GitHub, Slack, Google Drive, meeting notes, and ad-hoc tasks
- Priority scoring with cross-source dependency detection and bi-directional linking
- Priority and source-based grouping with search and filter
- Dismiss and restore tasks; manual priority overrides (boost/demote)
- Light, dark, and system theme modes
- Smooth expand/collapse animations with reduced-motion support

### Todaygent Chat Agent
- Built-in AI chat panel powered by Claude
- Ask it to plan your day, prioritize tasks, analyze dependencies
- Agentic loop: calls MCP tools autonomously to fetch and reason about your real data
- Streaming responses with expandable tool call visibility
- Chat persistence across page reloads
- Prompt caching for efficient token usage

### OAuth & Auth
- OAuth 2.0 via Keycard with PKCE
- RFC 8693 token exchange for Google, Linear, GitHub, and Slack APIs
- Auth error banner with reauthorization flow
- Session persistence

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `list-all-tasks-today` | Aggregates tasks from all sources into prioritized JSON |
| `list-calendar-events` | Google Calendar events for today |
| `list-linear-issues` | Linear issues assigned to you |
| `list-gmail-todos` | Gmail emails needing action |
| `list-github-todos` | GitHub PRs and issues assigned to you |
| `list-slack-todos` | Slack mentions, DMs, and saved messages |
| `list-assigned-actions` | Google Drive action items assigned to you |
| `list-drive-activity` | Recent Google Drive activity |
| `list-meeting-notes-actions` | Action items from meeting notes (via Google Drive) |
| `dismiss-task` | Dismiss a task from the dashboard (persisted locally) |
| `restore-dismissed-task` | Restore a previously dismissed task |
| `read-dashboard-tasks` | Read current dashboard task data (local read, no API calls) |
| `set-task-priority` | Override a task's priority; persists until cleared or auto-pruned |

## REST API

The server exposes REST endpoints alongside MCP:

```bash
# List available tools
curl -H "Authorization: Bearer TOKEN" http://localhost:9005/api/tools

# Call a tool
curl -X POST \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"maxResults": 10}' \
  http://localhost:9005/api/tools/list-calendar-events
```

## Using with MCP Clients (Cursor, Claude Desktop)

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "plan-my-today": {
      "url": "http://localhost:9005/mcp"
    }
  }
}
```

See [docs/agent-planning/claude-desktop-setup.md](./docs/agent-planning/claude-desktop-setup.md) for Claude Desktop setup.

## Project Structure

```
src/
├── index.ts                  # Entry point
├── server.ts                 # Express server, MCP, chat proxy, static UI
├── config.ts                 # Environment config
├── constants.ts              # App constants
├── middleware/                # Auth & logging middleware
├── services/                 # Keycard client, completion store, priority overrides, LLM cache
├── tools/                    # MCP tool implementations
│   ├── calendar.ts           # Google Calendar
│   ├── linear.ts             # Linear issues
│   ├── gmail.ts              # Gmail todos
│   ├── github.ts             # GitHub PRs & issues
│   ├── slack-list.ts         # Slack messages
│   ├── assigned-actions.ts   # Google Drive actions
│   ├── drive-activity.ts     # Google Drive activity
│   ├── meeting-notes.ts      # Meeting notes (via Google Drive)
│   ├── dismiss-task.ts       # Dismiss tasks
│   ├── restore-dismissed-task.ts
│   ├── read-dashboard-tasks.ts
│   ├── set-task-priority.ts  # Priority overrides
│   ├── list-all-tasks-today/ # Aggregation + priority scoring
│   └── today-todos/          # Source-specific extraction utilities
├── utils/                    # Shared utilities (date parsing, filtering, task store)
├── types/                    # TypeScript types
└── observability/            # OpenTelemetry, structured logging (Winston)

ui/
├── src/
│   ├── App.tsx               # Main dashboard layout
│   ├── auth/                 # OAuth (PKCE, Keycard discovery, AuthGate)
│   ├── mcp/                  # MCP client context
│   ├── chat/                 # Todaygent chat (agentic loop, system prompt, persistence)
│   ├── api/                  # REST client & data transformers
│   ├── components/
│   │   ├── Chat/             # ChatPanel, ChatMessage, ToolCallCard, TodaygentMascot, ThinkingIndicator
│   │   ├── AppLogo.tsx       # App branding
│   │   ├── TaskCard.tsx      # Individual task display
│   │   ├── TaskGroup.tsx     # Collapsible task groups
│   │   ├── FilterBar.tsx     # Search & filter panel
│   │   ├── ViewSwitcher.tsx  # Priority / Source view toggle
│   │   ├── Toast.tsx         # Dismissal/restore feedback notifications
│   │   ├── Chevron.tsx       # Animated expand/collapse icon (right/down/left)
│   │   └── SourceIcon.tsx    # Per-source emoji icons
│   ├── hooks/                # Custom React hooks (useTheme)
│   ├── styles/               # Design tokens (light/dark mode) & global styles
│   ├── types/                # Task type definitions
│   └── utils/                # Date, priority, grouping helpers
└── dist/                     # Production build (served by Express)
```

## Service Setup

This app uses [Keycard](https://keycard.ai) to broker OAuth tokens for all data sources (Google, Linear, GitHub, Slack). You'll need a Keycard account with a configured zone and OAuth apps registered for each service.

→ **[Keycard Setup Guide](./docs/keycard-setup.md)** — full configuration walkthrough for providers, resources, and credentials.

### Meeting Notes (Granola)

Meeting notes are synced from Granola to Google Drive via Zapier, then read by the MCP server. No separate API key is needed — Google Drive access is handled through Keycard.

> **[Granola Setup Guide](./docs/granola-setup.md)** — full walkthrough for the Granola → Zapier → Google Drive pipeline.

Set `MEETING_NOTES_FOLDER_ID` to your Google Drive folder ID and `USER_DISPLAY_NAME` to filter action items to yours.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KEYCARD_URL` | Keycard zone URL | — (required) |
| `KEYCARD_CLIENT_ID` | Keycard client ID | — (required) |
| `KEYCARD_CLIENT_SECRET` | Keycard client secret | — (required) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Todaygent | — (required for chat) |
| `ANTHROPIC_MODEL` | Claude model for chat agent | `claude-sonnet-4-6` |
| `PORT` | Server port | `9005` |
| `HOST` | Server host | `localhost` |
| `SLACK_EMOJI_NAME` | Custom emoji for Slack saved messages | `mcp-todo-reminder` |
| `CALENDAR_PREP_PREFIX` | Event title prefix for meeting prep blocks | `[prep]` |
| `MEETING_NOTES_FOLDER_ID` | Google Drive folder ID for Granola meeting notes ([setup guide](./docs/granola-setup.md)) | — |
| `USER_DISPLAY_NAME` | Comma-separated name variants for filtering meeting note action items | — |
| `ORG_GITHUB_REPOS` | Comma-separated `owner/repo` pairs for org repos to watch | — |
| `LOG_LEVEL` | Logging level | `INFO` |
| `ENABLE_OTEL` | Enable OpenTelemetry | `true` |

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start server in dev mode (nodemon + ts-node) |
| `npm run build` | Compile server TypeScript (via tsup) |
| `npm run build:all` | Build server + install UI deps + build UI |
| `npm run start:prod` | Start production server |
| `npm run plan-my-today` | Build, start server, and open browser (macOS) |
| `npm test` | Run Jest tests |
| `npm run check` | Biome lint + format check |

## Documentation

- [Keycard Setup Guide](./docs/keycard-setup.md) — OAuth providers, resources, and credentials configuration
- [Granola Setup Guide](./docs/granola-setup.md) — meeting notes pipeline (Granola → Zapier → Google Drive)
- [Agent Planning Guide](./docs/agent-planning/README.md) — how the AI planning system works
- [System Prompt](./docs/agent-planning/system-prompt.md) — the Todaygent system prompt
- [Metadata Guide](./docs/agent-planning/metadata-guide.md) — priority scoring, dependencies, cross-references
- [Example Prompts](./docs/agent-planning/example-prompts.md) — pre-written prompts for common workflows
- [Claude Desktop Setup](./docs/agent-planning/claude-desktop-setup.md) — using with Claude Desktop
- [Data Reference](./docs/agent-planning/data-reference.md) — data structures and constants

## Troubleshooting

**"[Keycard zone] redirected you too many times"**

Clear your Keycard cookies: navigate to `chrome://settings/content/all?searchSubpage=keycard.cloud` and delete the `keycard.cloud` cookie, then retry.

## License

Elastic License 2.0 (ELv2) — see [LICENSE](./LICENSE) for details.
