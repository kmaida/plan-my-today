# Plan My Today — UI

The browser-based dashboard and AI chat agent for Plan My Today.

## Running

**Development** (hot reload via Vite):
```bash
cd ui
npm run dev
# → http://localhost:9006 (proxies /api and /mcp to localhost:9005)
```

**Production** (served by Express from `ui/dist/`):
```bash
# From project root:
npm run build:all
npm run start:prod
# → http://localhost:9005
```

In production, the Express server serves the built UI as static files and handles all API/MCP/chat routes on the same port.

## Design System

**"Paper Over Coffee" aesthetic** — warm earth tones, serif headers, subtle shadows, muted priority colors.

- **Typography**: Lora (serif) for headings, Inter (sans-serif) for body
- **Design tokens**: `src/styles/design-tokens.css` — colors, spacing, typography, shadows, z-indices, transitions
- **Animations**: CSS grid collapse for expand/collapse, CSS transitions for chevron rotation, fade-in for chat panel
- **Reduced motion**: All animations respect `prefers-reduced-motion: reduce`

## Architecture

```
src/
├── App.tsx                    # Main layout: header, task groups, sidebar chat
├── App.css                    # Layout, banner, responsive styles
├── auth/                      # OAuth 2.0 with Keycard
│   ├── AuthContext.tsx         # Auth state provider (tokens, login/logout)
│   ├── AuthGate.tsx           # Sign-in gate (wraps app)
│   ├── AuthHint.tsx           # Tooltip explaining multi-grant flow
│   ├── config.ts              # OAuth config (client ID, redirect URI, resource)
│   ├── discovery.ts           # OIDC discovery endpoint fetcher
│   └── pkce.ts                # PKCE code challenge/verifier
├── mcp/                       # MCP client (SSE transport)
│   └── MCPClientContext.tsx    # React context providing MCP connection
├── chat/                      # Todaygent AI chat
│   ├── useChat.ts             # Chat hook (agentic loop, tool calls, streaming)
│   ├── system-prompt.ts       # Builds system prompt with current task context
│   └── types.ts               # Chat message types
├── api/                       # REST API client
│   ├── client.ts              # Fetch wrappers (listAllTasks, dismissTask, restoreDismissedTask)
│   └── transformers.ts        # Raw API → typed Task objects
├── components/
│   ├── Chat/
│   │   ├── ChatPanel.tsx      # Sidebar chat panel with input, messages, tool calls
│   │   ├── ChatMessage.tsx    # User/assistant message bubbles with markdown
│   │   ├── ToolCallCard.tsx   # Expandable tool call display
│   │   └── ThinkingIndicator  # Loading dots animation
│   ├── TaskCard.tsx           # Task display with priority, source, metadata, actions
│   ├── TaskGroup.tsx          # Collapsible group with smooth grid animation
│   ├── FilterBar.tsx          # Search + source/priority/time filter chips
│   ├── ViewSwitcher.tsx       # Priority / Source view toggle
│   ├── Chevron.tsx            # Animated rotate-on-toggle SVG chevron
│   └── SourceIcon.tsx         # Emoji icons per data source
├── styles/
│   ├── design-tokens.css      # All CSS custom properties
│   └── global.css             # Base styles, resets, button defaults
├── types/
│   └── tasks.ts               # Task, FilterState, ViewMode, PriorityCategory types
└── utils/
    ├── dateHelpers.ts         # Relative time, due date formatting
    ├── priorityHelpers.ts     # Score → category, color mapping
    ├── taskGrouping.ts        # Group tasks by priority or source
    └── taskHelpers.ts         # Filter logic, task identifiers
```

## Key Patterns

**OAuth flow**: `AuthGate` wraps the app. On first visit, shows a sign-in screen. After OAuth redirect, tokens are stored in `AuthContext` and passed to both the REST client and MCP transport.

**Data flow**: On sign-in, `App.tsx` calls `listAllTasks()` via REST, which hits `/api/tools/list-all-tasks-today`. The response is transformed into typed `Task[]` objects and rendered in `TaskGroup` components.

**Chat agent**: `ChatPanel` uses the `useChat` hook, which runs an agentic loop — sends messages to `/api/chat` (proxied to Claude API), handles tool calls by invoking MCP tools, and streams responses back.

**Animations**: TaskGroup and FilterBar use the CSS `grid-template-rows: 0fr → 1fr` technique for smooth height collapse/expand. Chevron rotates via CSS `transform`. Chat panel fades in on mount.

## Dev Notes

- Vite config (`vite.config.ts`) proxies `/api` and `/mcp` to `localhost:9005`
- All components use plain CSS files (BEM-style class names), not CSS modules or Tailwind
- The MCP resource identifier is always `http://localhost:9005/mcp` (registered with Keycard) — see `auth/config.ts`
