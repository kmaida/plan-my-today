# Plan: Making Todo MCP Server Shareable for Coworkers

## Executive Summary

**Current Situation:**
- HTTP-based MCP server with Keycard OAuth authentication
- High setup burden: requires Keycard account/zone, public tunnel, complex OAuth configuration
- Slack emoji hardcoded to `"kims-reminder-for-mcp"` in [src/constants.ts:41](src/constants.ts#L41)

**Recommendation:** Create a **stdio version** for easy local installation alongside maintaining the HTTP version for enterprise use.

**Answer to Key Questions:**
- **Should you make a stdio version?** YES - dramatically reduces setup friction for coworkers
- **Would it be difficult?** Moderate - estimated **4-6 days** of development work
- **Best approach:** Dual-track - maintain both HTTP (enterprise) and stdio (individual) versions

---

## Comparison: HTTP vs stdio Versions

| Aspect | HTTP + Keycard (Current) | stdio + Claude Desktop | Winner |
|--------|-------------------------|------------------------|---------|
| **Setup Time** | 2-3 hours | 15-30 minutes | stdio |
| **Setup Steps** | 10+ steps (Keycard, tunnel, OAuth apps) | 3 steps (install, config, restart) | stdio |
| **Multi-User Support** | ✅ Multi-tenant capable | ❌ Single-user only | HTTP |
| **Tunnel Required** | ❌ No (localhost for dev) | ❌ No | Tie |
| **OAuth Management** | Keycard (centralized) | Claude Desktop (native) | Depends on use case |
| **MCP Client Support** | Any (Cursor, Claude Desktop, etc.) | Claude Desktop only | HTTP |
| **Maintenance** | Server to run, public endpoint | Local process | stdio |
| **Enterprise Features** | Auth dashboard, auditing, policies | None | HTTP |

**Verdict:** stdio is ideal for coworkers wanting simple local use. HTTP remains valuable for team/enterprise deployments.

---

## Recommended Architecture: Dual Distribution

Maintain **both versions** sharing the same core tool logic:

```
plan-my-today/
├── src/
│   ├── tools/           # Shared: 13 tools across both versions
│   ├── services/        # Shared: service utilities
│   ├── stdio.ts         # NEW: stdio entry point
│   ├── http.ts          # REFACTORED: HTTP entry point (from index.ts)
│   └── ...
├── package.json         # Scripts for both: build:stdio, build:http, start:stdio, start:http
└── README.md            # Updated with both deployment options
```

**Benefits:**
- Coworkers get simple stdio version
- Enterprise users keep HTTP version
- Shared tools = single codebase for features/fixes
- Clear separation of transport layers

---

## Implementation Plan: stdio Version

### Phase 1: Core Transport Migration (2 days)

**1.1 Create stdio entry point** - [src/stdio.ts](src/stdio.ts)
- Import `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
- Create single MCP server instance (no session pattern needed)
- Register all 13 tools from `TOOL_REGISTRY`
- Connect transport and start stdio communication

**1.2 Refactor tool authentication**
- Current: Tools receive `authInfo` from Express middleware + Keycard token exchange
- New: Tools request service tokens from Claude Desktop via MCP auth protocol
- Update all tool handlers to use Claude Desktop's OAuth connectors
- Remove dependency on [src/services/keycard-client.ts](src/services/keycard-client.ts) for stdio version

**1.3 Refactor HTTP version**
- Rename [src/index.ts](src/index.ts) → [src/http.ts](src/http.ts)
- Keep HTTP-specific code isolated
- Ensure shared tools work with both transports

**Critical Files:**
- [src/server.ts](src/server.ts) - HTTP server setup; reference for stdio pattern
- [src/tools/index.ts](src/tools/index.ts) - Tool registry (reuse as-is)
- [src/services/keycard-client.ts](src/services/keycard-client.ts) - Replace with Claude connector calls

### Phase 2: Claude Desktop OAuth Integration (2 days)

**2.1 Map services to Claude Desktop connectors**

Configure Claude Desktop to provide OAuth tokens for:
- **Google Calendar:** `https://www.googleapis.com/calendar/v3` + scope `calendar.readonly`
- **Gmail:** `https://www.googleapis.com/gmail/v1` + scope `gmail.modify`
- **Google Drive:** For docs/drive activity tools
- **Linear:** `https://api.linear.app` + scope `read`
- **GitHub:** `https://api.github.com` + scopes `repo`, `read:org`

**2.2 Update tool token acquisition**

Replace Keycard token exchange with Claude Desktop token requests:
```typescript
// Before (HTTP + Keycard):
const tokenResponse = await keycardClient.exchange(authInfo, GMAIL_RESOURCE, GMAIL_SCOPES);
const accessToken = tokenResponse.access_token;

// After (stdio + Claude Desktop):
const accessToken = await mcpServer.requestServiceToken('gmail', ['gmail.modify']);
```

Update these files:
- [src/tools/calendar.ts](src/tools/calendar.ts)
- [src/tools/gmail.ts](src/tools/gmail.ts)
- [src/tools/linear.ts](src/tools/linear.ts)
- [src/tools/github.ts](src/tools/github.ts)
- [src/tools/drive-activity.ts](src/tools/drive-activity.ts)
- [src/tools/today-todos/*.ts](src/tools/today-todos/) (aggregation utilities)

**2.3 Handle token refresh**
- Claude Desktop should auto-refresh tokens
- Add retry logic for expired token edge cases

### Phase 3: Configuration & Multi-User Support (1-2 days)

**3.1 Make Slack emoji configurable** ⚠️ **CRITICAL FOR COWORKERS**

Current: Hardcoded in [src/constants.ts:41](src/constants.ts#L41) as `"kims-reminder-for-mcp"`

Changes needed:
```typescript
// src/constants.ts
export const SLACK_SAVED_MESSAGES = {
  EMOJI_NAME: process.env.SLACK_EMOJI_NAME || "mcp-todo-reminder",
  DAYS_BACK: 14,
  MAX_RESULTS: 50,
} as const;
```

Update [.env.example](.env.example):
```bash
# Slack custom emoji name (without colons, e.g., "my-todo-reminder")
# Create a custom emoji in your Slack workspace first
SLACK_EMOJI_NAME=my-todo-reminder
```

Files to update:
- [src/constants.ts](src/constants.ts) - Make emoji configurable
- [src/tools/today-todos/slack-utils.ts](src/tools/today-todos/slack-utils.ts) - Uses emoji constant
- [src/tools/slack-list.ts](src/tools/slack-list.ts) - References emoji
- [src/tools/mark-action-complete.ts](src/tools/mark-action-complete.ts) - Removes emoji

**3.2 stdio configuration file**

Create `config.schema.json` and document required settings:
```json
{
  "slack": {
    "emojiName": "my-custom-emoji"  // Per-user customization (optional)
  },
  "services": {
    "calendar": { "enabled": true },
    "gmail": { "enabled": true },
    "linear": { "enabled": true },
    "github": { "enabled": true },
    "drive": { "enabled": true }
  }
}
```

**3.3 Completion tracking**

Current implementation ([src/services/action-completion-store.ts](src/services/action-completion-store.ts)) uses in-memory Map - this works fine for stdio since each user runs their own process.

Optional enhancement: Persistent storage (SQLite) for completion state across restarts.

### Phase 4: Testing & Documentation (1 day)

**4.1 Testing**
- Test stdio transport with Claude Desktop
- Verify OAuth flows for all 5+ services
- Test all 13 tools end-to-end
- Validate custom Slack emoji configuration

**4.2 Documentation**

Create **README-STDIO.md** with:
1. **Prerequisites:** Node.js 18+, Claude Desktop
2. **Installation:**
   ```bash
   git clone https://github.com/kmaida/plan-my-today.git
   cd plan-my-today
   npm install
   npm run build:stdio
   ```
3. **Configuration:** Add to `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "plan-my-today": {
         "command": "node",
         "args": ["/absolute/path/to/plan-my-today/dist/stdio/stdio.js"],
         "env": {
           "SLACK_EMOJI_NAME": "your-custom-emoji"
         }
       }
     }
   }
   ```
4. **Service Setup:**
   - How to authenticate each service via Claude Desktop UI
   - Authorizing Slack via Keycard consent flow
   - Creating custom Slack emoji in workspace
5. **Troubleshooting:** Common issues and solutions

Update main [README.md](README.md):
- Add section comparing HTTP vs stdio deployments
- Link to README-STDIO.md for individual users
- Keep HTTP documentation for enterprise users

---

## Configuration Changes (Both Versions)

### A. Slack Emoji (Required for Multi-User)

**Files to modify:**
1. [src/constants.ts](src/constants.ts#L41) - Use `process.env.SLACK_EMOJI_NAME`
2. [.env.example](.env.example) - Add `SLACK_EMOJI_NAME` with documentation
3. [src/config.ts](src/config.ts) - Add validation warning if not set

**User instructions:**
1. Go to Slack workspace → Customize Slack → Add Custom Emoji
2. Upload an image (or use existing emoji)
3. Name it (e.g., "my-todo-reminder")
4. Set `SLACK_EMOJI_NAME=my-todo-reminder` in config

### B. Multi-User Isolation (HTTP Version Only)

Current issue: [src/services/action-completion-store.ts](src/services/action-completion-store.ts) has global completion tracking (no user scoping).

Fix:
```typescript
// Current: Map<string, CompletedAction>
// New: Map<string, Map<string, CompletedAction>>
//      userId -> actionId -> CompletedAction
```

Extract user ID from JWT and scope all completion operations.

---

## Deployment Options for Coworkers

### Option 1: stdio (Recommended for Individual Use)

**Setup time:** 15-30 minutes

**Steps:**
1. Clone repo, run `npm install`
2. Build: `npm run build:stdio`
3. Add to Claude Desktop config with custom Slack token/emoji
4. Restart Claude Desktop
5. Authenticate services via Claude Desktop UI

**Pros:** Simple, no tunnel, no Keycard account
**Cons:** Claude Desktop only, no multi-tenant features

### Option 2: HTTP (Recommended for Teams)

**Setup time:** 2-3 hours

**Steps:**
1. Create Keycard account and zone
2. Configure OAuth apps for all services
3. Configure `.env` with Keycard credentials
5. Start server: `npm run build:http && npm run start:http`
6. Configure MCP client (Cursor/Claude Desktop)

**Pros:** Multi-tenant, works with any MCP client, enterprise features
**Cons:** Complex setup, requires tunnel, Keycard account

---

## Development Timeline

**Total Effort: 4-6 days**

| Phase | Effort | Key Deliverables |
|-------|--------|------------------|
| 1. Transport migration | 2 days | stdio entry point, refactored HTTP version |
| 2. OAuth integration | 2 days | Claude Desktop connectors, updated tools |
| 3. Configuration | 1-2 days | Custom Slack emoji, multi-user support |
| 4. Testing & docs | 1 day | README-STDIO.md, troubleshooting guide |

**Iterative Approach:**
- Week 1: Minimal stdio prototype, test with 1-2 coworkers (alpha)
- Week 2: Gather feedback, fix critical issues
- Week 3: Polish, comprehensive documentation (beta)
- Week 4: Backport improvements to HTTP version

---

## Risk Assessment

### stdio Conversion Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude Desktop connector limitations | Medium | High | Research connectors early; test each service |
| OAuth scope incompatibilities | Low | Medium | Verify scopes match current Keycard setup |
| Lost HTTP features (auth dashboard) | High | Low | Document as expected; create CLI alternative |
| User confusion with two versions | Medium | Low | Clear documentation, version naming |

### Multi-User Configuration Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Completion state collisions (HTTP) | High | High | Implement user-scoped storage immediately |
| Slack emoji conflicts | Low | Low | Per-user emoji is workspace-specific |

---

## Verification Plan

After implementation, verify:

1. **stdio Transport:**
   - [ ] MCP server starts with StdioServerTransport
   - [ ] Claude Desktop successfully connects
   - [ ] All 13 tools appear in Claude Desktop

2. **OAuth Integration:**
   - [ ] Google Calendar authentication works via Claude Desktop
   - [ ] Gmail authentication works via Claude Desktop
   - [ ] Linear authentication works via Claude Desktop
   - [ ] GitHub authentication works via Claude Desktop
   - [ ] Drive authentication works via Claude Desktop
   - [ ] Tokens refresh automatically

3. **Slack Integration:**
   - [ ] Custom emoji name configurable via `SLACK_EMOJI_NAME`
   - [ ] Different users can use different emoji names
   - [ ] `list-slack-todos` shows saved messages with user's emoji
   - [ ] `mark-action-complete` removes user's custom emoji

4. **End-to-End Tool Testing:**
   - [ ] `whoami` - Returns user info
   - [ ] `list-calendar-events` - Shows upcoming events
   - [ ] `list-gmail-todos` - Shows email todos
   - [ ] `list-linear-issues` - Shows assigned issues
   - [ ] `list-github-todos` - Shows PRs and issues
   - [ ] `list-slack-todos` - Shows mentions, DMs, saved messages
   - [ ] `list-all-tasks-today` - Aggregates all tasks with priorities
   - [ ] `mark-action-complete` - Marks items complete across sources

5. **Documentation:**
   - [ ] README-STDIO.md complete with setup instructions
   - [ ] Troubleshooting guide covers common issues
   - [ ] Main README.md updated with deployment comparison

---

## Critical Files Reference

**For stdio implementation:**
- [src/stdio.ts](src/stdio.ts) - NEW: stdio entry point to create
- [src/server.ts](src/server.ts) - Reference for transport pattern
- [src/tools/index.ts](src/tools/index.ts) - Tool registry (reuse)
- [src/services/keycard-client.ts](src/services/keycard-client.ts) - Replace with Claude connectors
- [src/constants.ts](src/constants.ts#L41) - Make Slack emoji configurable
- [src/config.ts](src/config.ts) - Adapt for stdio deployment

**For configuration changes:**
- [.env.example](.env.example) - Add `SLACK_EMOJI_NAME` documentation
- [src/tools/today-todos/slack-utils.ts](src/tools/today-todos/slack-utils.ts) - Uses emoji constant
- [src/services/action-completion-store.ts](src/services/action-completion-store.ts) - Add user scoping for HTTP version

---

## Next Steps

1. **Validate approach:** Confirm stdio + dual-track is the right path
2. **Research Claude Desktop connectors:** Verify OAuth capabilities for all 5+ services
3. **Start Phase 1:** Create minimal stdio prototype for early testing
4. **Test with coworkers:** Get feedback before full implementation
5. **Iterate:** Polish based on real-world usage before broader rollout
