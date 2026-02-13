# Plan My Today

A **daily planning dashboard and AI chat agent** powered by an MCP server. Aggregates tasks from Google Calendar, Linear, Gmail, GitHub, Slack, Google Docs, and meeting notes into a single prioritized view with an embedded AI agent ("Todaygent") that helps you plan your day.

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
│  │  OAuth 2.0 + Token Exchange           │               │
│  │  ├── Google (Calendar, Gmail, Docs)   │               │
│  │  ├── Linear                           │               │
│  │  └── GitHub                           │               │
│  └───────────────────────────────────────┘               │
│             + direct API token:                           │
│             └── Slack (user OAuth token)                  │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- **Node.js 18+** and **npm**
- **Keycard account** with a configured zone (for OAuth)
- **Anthropic API key** (for the Todaygent chat agent)

### 1. Clone & Install

```bash
git clone https://github.com/kmaida/plan-my-today.git
cd plan-my-today
npm install
cd ui && npm install && cd ..
```

### 2. Configure Environment

Create a `.env` file in the project root:

```bash
# ── Required: Keycard OAuth ───────────────────
KEYCARD_STS_ISSUER_URL=https://your-zone-id.keycard.cloud
KEYCARD_CLIENT_ID=your-client-id
KEYCARD_CLIENT_SECRET=your-client-secret

# ── Required: Todaygent chat agent ────────────
ANTHROPIC_API_KEY=your-anthropic-api-key

# ── Optional: Server ──────────────────────────
PORT=9005
HOST=localhost

# ── Optional: Slack (direct token, not via Keycard) ──
SLACK_USER_TOKEN=xoxp-your-user-token
SLACK_EMOJI_NAME=my-todo-reminder
```

### 3. Run

**Production (recommended for daily use):**
```bash
npm run build:all
npm run start:prod
# Opens at http://localhost:9005
```

**Development (with hot reload):**
```bash
# Terminal 1: MCP server
npm run dev

# Terminal 2: UI dev server
cd ui && npm run dev
# Opens at http://localhost:9006 (proxies API to 9005)
```

**One-click launch (macOS):**
Double-click `TO DO.command` on the Desktop. It opens iTerm, builds, starts the prod server, and opens the browser.

### 4. Sign In

1. Open `http://localhost:9005` (prod) or `http://localhost:9006` (dev)
2. Click **Sign in with Google** — you'll authenticate through Keycard
3. Grant access to each service (Calendar, Gmail, Docs, etc.)
4. Your tasks load automatically

## Features

### Task Dashboard
- Tasks from 8 sources: Calendar, Linear, Gmail, GitHub, Slack, Google Docs, meeting notes
- Priority scoring and grouping (critical, high, medium, low)
- Source-based grouping with filter/search
- Mark tasks complete from the dashboard
- Smooth expand/collapse animations

### Todaygent Chat Agent
- Built-in AI chat panel powered by Claude
- Ask it to plan your day, prioritize tasks, analyze dependencies
- Has access to all MCP tools — can fetch and reason about your real data
- Streaming responses with tool call visibility

### OAuth & Auth
- OAuth 2.0 via Keycard with PKCE
- Token exchange for Google, Linear, and GitHub APIs
- Auth error banner with reauthorization flow
- Session persistence

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `list-all-tasks-today` | Aggregates tasks from all sources into prioritized JSON |
| `list-calendar-events` | Google Calendar events |
| `list-linear-issues` | Linear issues assigned to you |
| `list-gmail-todos` | Gmail emails needing action |
| `list-github-todos` | GitHub PRs and issues assigned to you |
| `list-slack-todos` | Slack mentions, DMs, and saved messages |
| `list-assigned-actions` | Google Docs action items assigned to you |
| `list-drive-activity` | Recent Google Drive activity |
| `list-meeting-notes-actions` | Action items from meeting notes (via Google Drive) |
| `mark-action-complete` | Mark meeting note todos, docs items, or ad-hoc tasks complete (local store) |

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
├── services/                 # Keycard client, Gmail labels, completion store
├── tools/                    # MCP tool implementations
│   ├── calendar.ts           # Google Calendar
│   ├── linear.ts             # Linear issues
│   ├── gmail.ts              # Gmail todos
│   ├── github.ts             # GitHub PRs & issues
│   ├── slack-list.ts         # Slack messages
│   ├── assigned-actions.ts   # Google Docs actions
│   ├── drive-activity.ts     # Google Drive activity
│   ├── meeting-notes.ts      # Meeting notes (via Google Drive)
│   ├── mark-action-complete.ts
│   ├── mark-email-complete.ts
│   └── list-all-tasks-today/ # Aggregation tool
├── utils/                    # Shared utilities
├── types/                    # TypeScript types
└── observability/            # OpenTelemetry, structured logging

ui/
├── src/
│   ├── App.tsx               # Main dashboard layout
│   ├── auth/                 # OAuth (PKCE, Keycard discovery, AuthGate)
│   ├── mcp/                  # MCP client context (SSE transport)
│   ├── chat/                 # Todaygent chat (useChat hook, system prompt)
│   ├── api/                  # REST client & data transformers
│   ├── components/
│   │   ├── Chat/             # ChatPanel, ChatMessage, ToolCallCard
│   │   ├── TaskCard.tsx      # Individual task display
│   │   ├── TaskGroup.tsx     # Collapsible task groups
│   │   ├── FilterBar.tsx     # Search & filter panel
│   │   ├── ViewSwitcher.tsx  # Priority / Source view toggle
│   │   ├── Chevron.tsx       # Animated expand/collapse icon
│   │   └── SourceIcon.tsx    # Per-source emoji icons
│   ├── styles/               # Design tokens & global styles
│   ├── types/                # Task type definitions
│   └── utils/                # Date, priority, grouping helpers
└── dist/                     # Production build (served by Express)
```

## Service Setup

Each data source requires configuration in Keycard (or a direct API token for Slack).

### Google Services (Calendar, Gmail, Docs, Drive)

Configure in Keycard Console:
- Enable token exchange for each Google API resource
- Required scopes: `calendar.readonly`, `gmail.readonly`, `drive.readonly`, `documents.readonly`

### Linear

1. Create an OAuth app in Linear (Settings > API > OAuth Applications)
2. Add Linear as a credential provider in Keycard
3. Token exchange resource: `https://api.linear.app`, scope: `read`

### GitHub

1. Create a GitHub App (Settings > Developer settings > GitHub Apps)
2. Set permissions: Metadata (Read-only), Issues (Read-only), Pull requests (Read-only), Contents (Read-only)
3. Install the app on your GitHub account
4. Add GitHub as a credential provider in Keycard
5. Token exchange resource: `https://api.github.com` (no scopes — permissions controlled by GitHub App settings)

### Slack

Direct token (not via Keycard):
1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add user token scopes: `search:read`, `reactions:read`
3. Set `SLACK_USER_TOKEN` and optionally `SLACK_EMOJI_NAME` in `.env`

### Meeting Notes

Meeting notes are read from Google Drive (no separate API key needed). The tool searches a configurable folder (default: "Meeting Notes") for recent documents and extracts action items.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KEYCARD_STS_ISSUER_URL` | Keycard issuer URL | — (required) |
| `KEYCARD_CLIENT_ID` | Keycard client ID | — (required) |
| `KEYCARD_CLIENT_SECRET` | Keycard client secret | — (required) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Todaygent | — (required for chat) |
| `PORT` | Server port | `9005` |
| `HOST` | Server host | `localhost` |
| `SLACK_USER_TOKEN` | Slack user OAuth token | — |
| `SLACK_EMOJI_NAME` | Custom emoji for saved messages | `mcp-todo-reminder` |
| `LOG_LEVEL` | Logging level | `INFO` |
| `ENABLE_OTEL` | Enable OpenTelemetry | `true` |

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start server in dev mode (nodemon + ts-node) |
| `npm run build` | Compile server TypeScript |
| `npm run build:all` | Build server + UI |
| `npm run start:prod` | Start production server |
| `npm run dashboard` | Build (if needed), start server, open browser |
| `npm test` | Run tests |
| `npm run check` | Lint + format check |

## Documentation

- [Agent Planning Guide](./docs/agent-planning/README.md) — how the AI planning system works
- [System Prompt](./docs/agent-planning/system-prompt.md) — the Todaygent system prompt
- [Metadata Guide](./docs/agent-planning/metadata-guide.md) — priority scoring, dependencies, cross-references
- [Example Prompts](./docs/agent-planning/example-prompts.md) — pre-written prompts for common workflows
- [Claude Desktop Setup](./docs/agent-planning/claude-desktop-setup.md) — using with Claude Desktop
- [Data Reference](./docs/agent-planning/data-reference.md) — data structures and constants

## License

Apache-2.0 License — see LICENSE file for details.
