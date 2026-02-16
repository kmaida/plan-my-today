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
- **Design tokens**: `src/styles/design-tokens.css` — 100+ CSS custom properties for colors, spacing, typography, shadows, z-indices, transitions
- **Theming**: Light, dark, and system modes via `[data-theme]` attribute on `<html>`. Dark mode redefines all color tokens in a `[data-theme="dark"]` block. Theme preference is persisted to `localStorage`.
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
│   ├── chat-persistence.ts    # Persist/restore chat messages to localStorage
│   ├── tool-round-utils.ts    # Tool call execution, result processing, auth error extraction
│   └── types.ts               # Chat message types
├── api/                       # REST API client
│   ├── client.ts              # Fetch wrappers (listAllTasks, dismissTask, restoreDismissedTask)
│   └── transformers.ts        # Raw API → typed Task objects
├── hooks/
│   └── useTheme.ts            # Theme toggle (light/system/dark), persists to localStorage
├── components/
│   ├── Chat/
│   │   ├── ChatPanel.tsx      # Sidebar chat panel with input, messages, token stats
│   │   ├── ChatMessage.tsx    # User/assistant message bubbles with markdown
│   │   ├── ToolCallCard.tsx   # Expandable tool call display
│   │   ├── TodaygentMascot.tsx # Animated clipboard robot (idle/thinking/static states)
│   │   └── ThinkingIndicator.tsx # Loading dots animation
│   ├── TaskCard.tsx           # Task display with priority, source, metadata, actions
│   ├── TaskGroup.tsx          # Collapsible group with smooth grid animation
│   ├── FilterBar.tsx          # Search + source/priority/time filter chips
│   ├── ViewSwitcher.tsx       # Priority / Source view toggle
│   ├── Toast.tsx              # Feedback notifications (dismiss/restore, errors)
│   ├── Chevron.tsx            # Animated SVG chevron (right/down/left directions)
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

**Data flow**: On sign-in, `App.tsx` calls `listAllTasks()` via REST, which hits `/api/tools/list-all-tasks-today`. The response is transformed into typed `Task[]` objects and rendered in `TaskGroup` components. Dismissed tasks are filtered server-side before returning.

**Chat agent**: `ChatPanel` uses the `useChat` hook, which runs an agentic loop — sends messages to `/api/chat` (proxied to Claude API with prompt caching), handles tool calls by invoking MCP tools via `tool-round-utils.ts`, and streams responses back. Chat history persists to `localStorage` via `chat-persistence.ts` and survives page reloads.

**Theming**: `useTheme` hook manages a three-way toggle (light/system/dark). Sets `data-theme` attribute on `<html>`, which triggers the dark mode token overrides in `design-tokens.css`. Preference is stored in `localStorage`.

**Task dismissal**: Users can dismiss tasks from the dashboard. The `dismiss-task` MCP tool writes to a local JSON store (`action-completion-store.ts`). `filterCompletedTasks` strips dismissed items server-side before returning data. Restoring a task calls `restore-dismissed-task`. A `Toast` notification confirms each action.

**Animations**: TaskGroup, FilterBar, and auth error banner use the CSS `grid-template-rows: 0fr → 1fr` technique for smooth height collapse/expand. The shared `Chevron` component rotates via CSS `transform` with a 150ms transition. Chat panel fades in on mount.

## Dev Notes

- Vite config (`vite.config.ts`) proxies `/api` and `/mcp` to `localhost:9005`
- All components use plain CSS files (BEM-style class names), not CSS modules or Tailwind
- The MCP resource identifier is always `http://localhost:9005/mcp` (registered with Keycard) — see `auth/config.ts`
