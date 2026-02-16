# Claude Desktop Setup Guide

Step-by-step instructions for setting up agent-based daily planning with Claude Desktop.

## Prerequisites

1. **plan-my-today is running**
   - Server should be accessible (e.g., `http://localhost:9005` or your deployed URL)
   - You have valid authentication credentials

2. **Claude Desktop is installed**
   - Download from [claude.ai/download](https://claude.ai/download)
   - Logged in with your Anthropic account

3. **MCP server is configured in Claude Desktop**
   - Your `claude_desktop_config.json` includes the plan-my-today configuration

## Configuration File Location

The Claude Desktop MCP configuration file location depends on your OS:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

## Step 1: Configure MCP Server

Add your plan-my-today to the Claude Desktop config file:

```json
{
  "mcpServers": {
    "plan-my-today": {
      "command": "node",
      "args": ["/path/to/plan-my-today/dist/index.js"],
      "env": {
        "PORT": "9005"
      }
    }
  }
}
```

**For OAuth-based server:**

If your server uses OAuth authentication (recommended), use the HTTP transport:

```json
{
  "mcpServers": {
    "plan-my-today": {
      "url": "http://localhost:9005/mcp",
      "description": "Aggregates tasks from Calendar, Linear, Gmail, GitHub, Slack, etc."
    }
  }
}
```

Replace `http://localhost:9005` with your actual server URL (could be `https://your-domain.com` if deployed).

**Save the file** and restart Claude Desktop for changes to take effect.

## Step 2: Verify MCP Connection

1. Open Claude Desktop
2. Start a new conversation
3. Type: "Do you have access to list-all-tasks-today?"

**Expected response:**
```
Yes, I have access to the list-all-tasks-today tool. This tool fetches and aggregates
your tasks from multiple sources including Calendar, Linear, GitHub, Gmail, Slack,
Google Drive, and meeting summaries...
```

If Claude says it doesn't have access:
- Check that the config file is in the correct location
- Verify the server URL is correct and the server is running
- Restart Claude Desktop
- Check Claude Desktop logs (Help → View Logs)

## Step 3: Add System Prompt

You have two options for adding the system prompt:

### Option A: Custom Instructions (Global)

This applies the planning prompt to all conversations.

1. Open Claude Desktop
2. Click your profile icon → **Settings**
3. Navigate to **Custom Instructions**
4. Copy the entire system prompt from [system-prompt.md](./system-prompt.md)
5. Paste it into the custom instructions field
6. Click **Save**

**Pros:**
- Available in every conversation
- No need to set up per-conversation

**Cons:**
- Applies to all topics (even non-planning conversations)
- May make non-planning conversations feel constrained

### Option B: Project (Recommended)

This creates a dedicated space for planning conversations.

1. Open Claude Desktop
2. Click **Projects** in the sidebar
3. Click **+ New Project**
4. Name it: "Daily Planning Agent"
5. In the project settings, add **Custom Instructions**:
   - Copy the entire system prompt from [system-prompt.md](./system-prompt.md)
   - Paste it into the custom instructions field
6. Click **Save**

**Pros:**
- Isolated to planning conversations
- Can have multiple projects with different prompts
- Easier to iterate and refine

**Cons:**
- Need to switch to the project when planning

## Step 4: Test the Setup

In Claude Desktop (with custom instructions or in the Daily Planning project):

### Test 1: Basic Tool Call

**You:** "Call list-all-tasks-today and show me what you get"

**Expected:** Claude calls the tool and shows the raw data structure

### Test 2: Simple Planning

**You:** "Plan my day"

**Expected:** Claude calls `list-all-tasks-today` automatically and provides:
- Executive summary
- Time-blocked schedule
- Meeting prep
- Dependency analysis

### Test 3: Specific Queries

Try these prompts:
- "What's blocking work?"
- "Prep me for my next meeting"
- "What should I work on next?"
- "What items are mentioned multiple times?"

**Expected:** Claude should respond with relevant analysis from the data.

## Step 5: Create Quick Commands (Optional)

Speed up common workflows by creating shortcuts.

### Method 1: Text Expansion (macOS/Windows)

Use a text expander like [Alfred](https://www.alfredapp.com/) (macOS), [AutoHotkey](https://www.autohotkey.com/) (Windows), or [Espanso](https://espanso.org/) (cross-platform):

```
pmd → "Call list-all-tasks-today and plan my day"
wn → "Call list-all-tasks-today and tell me what to work on next"
pm → "Call list-all-tasks-today and prep me for my meetings today"
wb → "Call list-all-tasks-today and tell me what's blocking work"
```

### Method 2: Claude Desktop Project Templates

In your "Daily Planning Agent" project:
1. Create pinned messages with common prompts
2. Click them to quickly send pre-written queries

## Advanced Configuration

### Multi-Tenant Setup

If you're using a multi-tenant deployment:

```json
{
  "mcpServers": {
    "plan-my-today": {
      "url": "https://z123.your-domain.com/mcp",
      "description": "Todo MCP Server (Zone: z123)"
    }
  }
}
```

Replace `z123` with your actual zone ID.

### Customize Working Hours

Add this to your system prompt (in custom instructions):

```markdown
## My Working Hours
- Start: 10am
- End: 6pm
- Lunch: 1pm-2pm

Adjust time blocking recommendations accordingly.
```

### Customize Priority Thresholds

Add this to your system prompt:

```markdown
## My Priority Preferences
- I consider anything ≥200 as "urgent" (use 🔴)
- I consider anything 100-199 as "normal" (use 🔵)
- Anything <100 is "low priority" (use ⚪)

Use these categories instead of the default 4-tier system.
```

### Add Domain-Specific Rules

Customize for your workflow:

**Engineering focus:**
```markdown
## My Workflow Preferences
- Prioritize GitHub PRs over Linear issues
- Group code-related work together
- Morning = deep work (code), Afternoon = reviews and meetings
```

**Management focus:**
```markdown
## My Workflow Preferences
- Prioritize meeting prep and Slack messages
- Show attendee context for all meetings
- Flag emails from reports as high priority
```

## Troubleshooting

### Claude doesn't call the tool automatically

**Problem:** Claude responds without calling `list-all-tasks-today`

**Solutions:**
1. Be explicit: "Call list-all-tasks-today and..."
2. Check that the system prompt is properly loaded
3. Try in a fresh conversation
4. Restart Claude Desktop

### MCP server connection fails

**Problem:** Error: "Failed to connect to MCP server"

**Check:**
1. Server is running (`curl http://localhost:9005/api/tools` should return data)
2. Config file path is correct
3. URL in config matches your server
4. Restart Claude Desktop after config changes
5. Check Claude Desktop logs: Help → View Logs

### Authentication errors

**Problem:** `metadata.errors` includes auth failures

**Solutions:**
1. Visit your server's `/auth` dashboard (e.g., `http://localhost:9005/auth`)
2. Reconnect any failing sources (Gmail, Slack, Linear, GitHub, etc.)
3. Check that OAuth tokens haven't expired

### System prompt seems ignored

**Problem:** Claude doesn't follow the planning format

**Check:**
1. Custom instructions or project instructions are saved
2. You're in the correct project (if using Option B)
3. Try starting with "Following your instructions, plan my day"
4. The system prompt is the one from `system-prompt.md` (not truncated)

### Response is too verbose/brief

**Problem:** Output is too long or too short

**Solutions:**
1. Add to your prompt: "Give me a concise summary" or "Give me detailed analysis"
2. Customize the system prompt output format section
3. Train Claude by giving feedback: "That's too detailed, just give me bullet points"

### No data returned

**Problem:** `list-all-tasks-today` returns empty arrays

**Check:**
1. Time windows: GitHub (30 days), Gmail/Docs (14 days), Slack (2 days)
2. Items exist in those time windows
3. Auth is working for all sources
4. Server logs for errors

### Priority scores seem wrong

**Problem:** Items have unexpected priority scores

**Understand:**
- Priority is calculated based on multiple factors (see [metadata-guide.md](./metadata-guide.md))
- Ask Claude: "Why is PROJ-123 scored at 215?"
- Claude will explain using `priorityMetadata.reasons`

## Updating the System Prompt

As you refine your planning needs:

1. Edit [system-prompt.md](./system-prompt.md)
2. Copy the updated prompt
3. Update your custom instructions or project settings
4. No need to restart Claude Desktop (changes apply to new conversations)

## Alternative Clients

This setup guide is for Claude Desktop, but the same approach works with:

### Custom MCP Client

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "planning-client",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: "node",
  args: ["/path/to/plan-my-today/dist/index.js"]
});

await client.connect(transport);

// Call the tool
const result = await client.callTool({
  name: "list-all-tasks-today",
  arguments: {}
});

// Pass result to Claude API with system prompt
// (see Claude API docs)
```

### Automated Script

Create a daily briefing script:

```bash
#!/bin/bash

# 1. Call the tool via MCP
# 2. Pass data + system prompt to Claude API
# 3. Send result via email/Slack
# 4. Schedule with cron: 0 8 * * * /path/to/script.sh
```

See the [Claude API documentation](https://docs.anthropic.com/claude/reference/messages_post) for details.

## Next Steps

1. Test the basic setup with "Plan my day"
2. Try different prompts from [example-prompts.md](./example-prompts.md)
3. Refine the system prompt based on your workflow
4. Share effective prompts with your team

## Resources

- [Claude Desktop Download](https://claude.ai/download)
- [MCP Documentation](https://modelcontextprotocol.io/)
- [System Prompt](./system-prompt.md)
- [Example Prompts](./example-prompts.md)
- [Metadata Guide](./metadata-guide.md)
