# Changelog

## [Unreleased] — A2A delegation to ROIbot (May 2026)

### BREAKING CHANGES

- **Replaced ROIbot MCP-proxy with A2A task delegation.** The old approach connected
  Todaygent to ROIbot's MCP server as a client, exposing every ROIbot tool name to
  Todaygent's LLM. The new approach uses the A2A protocol to send a free-form task
  description to ROIbot's `/api/agent` endpoint; ROIbot's own agent picks tools
  internally and returns a coherent answer. Todaygent's LLM never sees ROIbot's
  tool names.
- `ROIBOT_MCP_ENDPOINT` env var renamed to `ROIBOT_AGENT_ENDPOINT`. Set it to
  ROIbot's `/api/agent` URL (e.g. `https://event-roi.fly.dev/api/agent`).
- The old delegation tools (`list-roibot-tools`, `delegate-to-roibot`) have been
  removed. Replacement: `delegate-task-to-roibot` (LLM-facing). The tool's
  invocation is intercepted by Todaygent's chat UI for user approval before
  any network call happens.
- **Destructive actions are out of scope for A2A delegation.** ROIbot retains
  its own HITL for destructive actions inside its own chat, but those actions
  cannot be triggered via `delegate-task-to-roibot`. If ROIbot's agent ever
  returns `state: 'input-required'` over A2A, the calling tool refuses with a
  loud error rather than threading approval state back through.

### Added

- **`@a2a-js/sdk@^0.3.13`** — A2A protocol client for delegated agent calls.
- **UI-enforced pre-call approval gate for A2A delegation.** Tools listed in
  `TOOLS_REQUIRING_APPROVAL` in `ui/src/chat/useChat.ts` (currently just
  `delegate-task-to-roibot`) never dispatch until the user clicks Approve on
  an inline `ApprovalCard`. The dispatch happens in client code, so the LLM
  cannot bypass the gate — making the property "every A2A call is human-
  initiated" load-bearing in the code, not emergent from the prompt. Denial
  feeds a synthetic "user denied" result back to Claude so the conversation
  stays well-formed and the agent doesn't retry. Stop-button aborts during
  a pending card unwind cleanly without orphaning a `tool_use` block.
- New files:
  - `src/services/roibot-a2a-client.ts` — `startTask` via A2A SDK.
  - `src/tools/delegate-task-to-roibot.ts` — the single delegation tool.
  - `ui/src/components/Chat/ApprovalCard.{tsx,css}` — pre-call approval UI.

### Changed

- `ui/src/chat/types.ts` — added `PendingApprovalMeta` (`{ toolInput, resolve }`);
  `ChatMessage` gained an optional `pendingApproval` field.
- `ui/src/chat/useChat.ts` — pre-call HITL gate inside the agentic loop: when
  the LLM wants to invoke a tool in `TOOLS_REQUIRING_APPROVAL`, the loop awaits
  the user's click before calling MCP. Adding a new gated tool is a one-line
  change to the `TOOLS_REQUIRING_APPROVAL` set.
- `ui/src/chat/chat-persistence.ts` — strips `pendingApproval` on rehydration
  so a stale `resolve` callback (functions don't serialize through JSON) can't
  surface a permanently-stuck card.
- `ui/src/chat/system-prompt.ts` — instructs Todaygent to delegate only when
  the user explicitly invites it (allow-list rule with two trigger conditions),
  and notes that every call is UI-gated.

### Removed (compared to mid-branch pass-through HITL prototype)

- `resume-roibot-task` MCP tool and its `_meta.pendingApproval` round-trip path.
  ROIbot can still pause for its own destructive-action HITL in its own chat,
  but PMT no longer surfaces those mid-task approvals through A2A. The earlier
  prototype is preserved on the `stash/roibot-passthrough-hitl` branch for
  reference if we revisit pass-through HITL later.

## [0.2.3](https://github.com/kmaida/plan-my-today/compare/v0.2.1...v0.2.3) (2026-02-20)

## [0.2.0] - 2026-01-27

### BREAKING CHANGES
- **Removed `list-today-todos` tool** - Deprecated in favor of agent-based planning with `list-all-tasks-today`
  - Old tool: Pre-formatted markdown with built-in timeline and insights
  - New approach: Raw JSON with priority metadata for LLM agent consumption
  - Agents create personalized plans adapted to user context

### Migration Guide
- Replace `list-today-todos` calls with agent workflows using `list-all-tasks-today`
- See [TESTING_LIST_ALL_TASKS.md](./TESTING_LIST_ALL_TASKS.md) for detailed guidance
- Priority metadata (score, category, signals, reasons) enables intelligent planning

### Removed
- Tool registration for `list-today-todos`
- Implementation files: `index.ts`, `insights.ts`, `timeline.ts` (~1700 lines)

### Preserved
- All shared utilities: calendar, linear, email, docs, github, slack
- Priority calculation functions for `list-all-tasks-today`
- Type definitions

### Documentation
- Added migration notice to README
- Expanded TESTING_LIST_ALL_TASKS.md with comparison and examples
- Updated all user-facing messages
