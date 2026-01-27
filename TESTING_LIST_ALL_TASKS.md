# Testing list-all-tasks-today Tool

## Overview
The `list-all-tasks-today` tool is a simple data aggregation MCP tool that returns raw JSON from all connected sources.

## How to Test

### 1. Start the Server
```bash
npm start
```

The server will start on `http://localhost:3000` (or your configured port).

### 2. Call the Tool

**Option A: Via MCP Client (Claude CLI, Cursor, etc.)**
```
Call the list-all-tasks-today tool
```

**Option B: Via REST API**
```bash
curl -X POST http://localhost:3000/api/tools/list-all-tasks-today \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Option C: With includeGithub parameter**
```bash
curl -X POST http://localhost:3000/api/tools/list-all-tasks-today \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"includeGithub": true}'
```

## Expected Output Structure

```json
{
  "calendar": [
    {
      "summary": "Team Standup",
      "start": { "dateTime": "2026-01-27T09:00:00-08:00" },
      "end": { "dateTime": "2026-01-27T09:30:00-08:00" },
      "htmlLink": "https://calendar.google.com/...",
      "attendees": [...],
      "location": "Zoom",
      ...
    }
  ],
  "linear": [
    {
      "identifier": "PROJ-123",
      "title": "Fix authentication bug",
      "url": "https://linear.app/...",
      "priority": 1,
      "priorityLabel": "Urgent",
      "dueDate": "2026-01-27",
      "estimate": 3,
      ...
    }
  ],
  "gmail": [
    {
      "id": "abc123",
      "subject": "Q1 Planning Discussion",
      "from": "teammate@company.com",
      "link": "https://mail.google.com/...",
      "timestamp": 1737936000000,
      "isImportant": false,
      "isStarred": true,
      "isFromIndividual": true,
      "needsReply": true,
      ...
    }
  ],
  "docs": [
    {
      "fileTitle": "Product Roadmap 2026",
      "actionType": "assignment",
      "fileLink": "https://docs.google.com/...",
      "timestamp": "2026-01-26T15:30:00Z",
      "isAssignment": true
    }
  ],
  "github": {
    "prs": [
      {
        "id": 456,
        "number": 123,
        "title": "Add new feature",
        "url": "https://github.com/org/repo/pull/123",
        "repo": "org/repo",
        "type": "review",
        "updatedAt": "2026-01-26T10:00:00Z",
        "isDraft": false
      }
    ],
    "issues": [
      {
        "id": 789,
        "number": 45,
        "title": "Bug in login flow",
        "url": "https://github.com/org/repo/issues/45",
        "repo": "org/repo",
        "updatedAt": "2026-01-25T14:00:00Z",
        "labels": ["bug", "high-priority"]
      }
    ]
  },
  "slack": [
    {
      "text": "Can you review the PR when you get a chance?",
      "user": "U12345",
      "userName": "John Doe",
      "channel": "C67890",
      "channelName": "engineering",
      "timestamp": "1737936000.123456",
      "permalink": "https://workspace.slack.com/...",
      "type": "mention"
    }
  ],
  "metadata": {
    "fetched_at": "2026-01-27T08:00:00.000Z",
    "date": "2026-01-27T08:00:00.000Z",
    "errors": []
  }
}
```

## What It Does NOT Do

- ❌ No workblock suggestions
- ❌ No priority scoring/ranking
- ❌ No timeline building
- ❌ No insights or recommendations
- ❌ No formatting or markdown

## What It DOES Do

- ✅ Fetches data from all sources in parallel
- ✅ Returns raw JSON grouped by source
- ✅ Includes metadata (timestamp, errors)
- ✅ Simple, fast, predictable
- ✅ Perfect for agents to analyze

## Next Steps (Phase 2)

Once you've verified the tool returns data correctly:

1. **Create an agent prompt** that uses this data
2. **Test interactively** by asking Claude to plan your day
3. **Refine the planning strategy** through conversation
4. **Eventually automate** with a scheduled script

## Migration from list-today-todos (DEPRECATED)

The `list-today-todos` tool has been deprecated in favor of agent-based planning.

### Key Differences

| Aspect | list-today-todos (DEPRECATED) | list-all-tasks-today (CURRENT) |
|--------|-------------------------------|--------------------------------|
| **Output** | Formatted markdown with timeline | Raw JSON grouped by source |
| **Intelligence** | Built-in: workblocks, insights, timeline | Priority metadata for agents |
| **Use case** | Ready-to-use daily plan | Data source for LLM agents |
| **Flexibility** | Fixed format and logic | Fully customizable by agent |
| **Size** | ~1000+ lines formatted output | Compact JSON (~200 lines) |
| **Performance** | Slower (complex processing) | Faster (raw data only) |

### Why the Change?

1. **Agent-First Design:** LLM agents build better plans with context-aware reasoning
2. **Flexibility:** Agents adapt to user preferences and context
3. **Maintainability:** Separates data from presentation
4. **Extensibility:** Easy to add sources without changing format logic

### Migration Guide

**Before (Old):**
```typescript
// Direct tool call with formatted output
const result = await tools.listTodayTodos({ includeCalendar: true })
```

**After (New):**
```typescript
// Agent fetches raw data and builds custom plan
const data = await tools.listAllTasksToday({ includeGithub: true })
// Agent analyzes priority metadata and creates contextual plan
// Agent can ask follow-up questions and adapt to preferences
```

**Benefits:**
- Plans adapt to your working style
- Agent reasons about task dependencies
- Dynamic prioritization based on context
- Natural conversation about schedule

## Testing Checklist

- [ ] Server starts without errors
- [ ] Tool appears in tool list
- [ ] Tool can be called successfully
- [ ] Returns valid JSON
- [ ] All sources are included (calendar, linear, gmail, etc.)
- [ ] Errors are handled gracefully
- [ ] Authentication works for all services
