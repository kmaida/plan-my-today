# Todo MCP UI - Demo

## Quick Start

To see the UI in action:

```bash
cd ui
npm run dev
```

This will start the Vite dev server at [http://localhost:9006](http://localhost:9006)

## What's Built So Far

### ✅ Design System
- **"Paper Over Coffee" Aesthetic**: Warm colors, serif fonts, subtle shadows
- **Color Palettes**: Light and dark mode support (dark mode toggle not yet implemented)
- **Typography**: Lora (serif) for headers, Inter (sans-serif) for body text
- **Design tokens**: All CSS variables defined in `src/styles/design-tokens.css`

### ✅ Components

**PriorityBadge** (`src/components/PriorityBadge.tsx`)
- Displays priority with muted color-coded pills
- Shows priority score and reasoning on hover
- Supports: critical (red), high (orange), medium (teal), low (gray)

**SourceIcon** (`src/components/SourceIcon.tsx`)
- Emoji-based icons for each task source
- Tooltips with source names
- Supports: Linear, Gmail, GitHub, Slack, Calendar, Docs, Meeting Notes

**TaskCard** (`src/components/TaskCard.tsx`)
- Compact by default with title, source, priority, metadata
- Expandable to show:
  - Cross-references ("Also mentioned in: Slack, Email")
  - Dependencies (for Linear tasks)
  - Priority reasoning
- Hover actions: "View in [Source]", "Mark Complete"
- Smooth animations

**TaskGroup** (`src/components/TaskGroup.tsx`)
- Collapsible sections with task counts
- Elegant header with expand/collapse toggle
- Used for grouping by priority, source, etc.

### ✅ Type System
- Comprehensive TypeScript interfaces for all 8 task sources
- Type guards for task discrimination
- Rich metadata types (priority, dependencies, cross-references)

### ✅ API Client
- REST endpoint wrappers for all MCP tools
- Ready to connect to backend at `/api/tools/:toolName`

### ✅ Utilities
- Priority helpers (sorting, grouping, color mapping)
- Date helpers (relative time, due date formatting)

## Current Demo

The current `App.tsx` shows:
- Mock data with 4 tasks (2 critical, 1 high, 1 medium)
- Tasks grouped by priority
- All components working together
- Design system in action (sidebar shows component samples)

## What's NOT Built Yet

- [ ] ViewSwitcher (Priority, Source, Timeline, Related views)
- [ ] FilterPanel (search, filters)
- [ ] ThemeToggle (dark mode switcher)
- [ ] Intelligent grouping algorithm for "Related" view
- [ ] Data fetching hooks (useTasks, useCompletion)
- [ ] TaskList component (uses TaskGroup internally)
- [ ] Real API integration (currently using mock data)
- [ ] Server integration (serving UI from Express)

## Next Steps

1. **Review the design**: Does the "paper over coffee" aesthetic match your vision?
2. **Test interactions**: Click on task cards, expand cross-references, hover on badges
3. **Check responsiveness**: Resize the browser to see mobile layout
4. **Decide on next steps**: Continue building remaining features, or adjust design first?

## Notes

- The dev server proxies `/api` and `/mcp` requests to `localhost:9005` (see `vite.config.ts`)
- Mock data is in `App.tsx` - this will be replaced with real API calls
- All components use CSS modules for styling (not Tailwind)
- Design follows the plan's specifications for elegance and information density
