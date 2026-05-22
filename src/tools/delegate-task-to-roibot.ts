import { z } from "zod/v3";
import { type DelegateResult, delegateTask } from "../services/roibot-a2a-client";
import type { McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";

/**
 * MCP tool that delegates a free-form task from Todaygent to ROIbot
 * over A2A. Pass a natural-language description; ROIbot's own LLM
 * picks tools internally and returns a coherent reply.
 *
 * @remarks
 * **HITL gate gates LLM-driven invocations only.** Todaygent's chat UI
 * intercepts every LLM-initiated `delegate-task-to-roibot` call and
 * waits for the user to click Approve before dispatching. The threat
 * model is "stop the LLM from auto-delegating in an agentic loop
 * without user consent" — NOT "stop the user." Direct API access
 * (`POST /api/tools/delegate-task-to-roibot`, `POST /mcp` with
 * `tools/call`) is intentionally permitted for scripted use, dashboards,
 * and power users. See `ui/src/chat/useChat.ts`
 * (`TOOLS_REQUIRING_APPROVAL`) for the gate; there is no server-side
 * counterpart, by design.
 *
 * **Destructive actions are out of scope for A2A.** ROIbot can take
 * destructive actions in its own chat (with its own HITL), but those
 * are forbidden over A2A. If ROIbot ever returns `state:
 * 'input-required'` here, we refuse with a loud error rather than
 * surfacing a mid-task approval flow.
 */
export function registerROIbotDelegateTools(mcpServer: McpServer): void {
  // ── delegate-task-to-roibot ────────────────────────────────────────────
  mcpServer.registerTool(
    "delegate-task-to-roibot",
    {
      title: "Delegate task to ROIbot",
      description:
        "Delegate an Event ROI task to ROIbot. Use this for: assessing events for sponsorship/speaking fit, " +
        "listing or filtering events in the pipeline, recording sponsorship/speaking decisions, recording " +
        "post-event outcomes (leads, content performance), generating ROI reports, or managing Linear " +
        "issues for events. " +
        "Pass a natural-language task description; ROIbot's own agent picks the right tools internally and " +
        "returns a coherent answer. " +
        "These tasks are long-running: assessments and Linear-heavy delegations typically take 1-5 minutes. " +
        "Destructive actions (delete event, merge events, change config) are out of scope for A2A; if the " +
        "user wants one, tell them to use ROIbot directly in its own chat.",
      inputSchema: {
        task: z.string().min(1).describe("Natural-language task description for ROIbot's agent."),
      },
    },
    async ({ task }, { authInfo }) => {
      if (!authInfo) return failureResult("❌ Not authenticated.");
      try {
        const result = await delegateTask(authInfo, task);
        return formatResult(result);
      } catch (error) {
        return handleToolError(
          error,
          "roibot",
          [],
          [],
          ["Check ROIBOT_AGENT_ENDPOINT and the Keycard zone delegation chain."]
        );
      }
    }
  );
}

/**
 * Translate a {@link DelegateResult} into an MCP tool result.
 *
 * `input-required` is defensive: under the policy, ROIbot must not
 * request human approval over A2A. If it does, refuse loudly rather
 * than silently dropping the response or surfacing a stale approval
 * flow that no longer exists on this side.
 */
function formatResult(result: DelegateResult) {
  if (result.state === "input-required") {
    return failureResult(
      "⚠️ ROIbot returned an approval-required state, which is not allowed over A2A. " +
        "Destructive actions must be performed in ROIbot's own chat."
    );
  }
  if (result.state === "failed") {
    return failureResult(result.finalText || "ROIbot delegation failed.");
  }
  // completed
  return {
    content: [{ type: "text" as const, text: result.finalText || "Done." }],
  };
}

/**
 * Build a structured failure response for known terminal failures
 * (missing auth, missing config, defensive A2A `input-required`, A2A
 * `failed` state). Distinct from {@link handleToolError}, which is for
 * caught exceptions and emits the full `_meta.error` payload. The
 * `isError: true` flag is what tells the UI to render ❌ and tells the
 * LLM the call genuinely failed — without it, callers would render ✓
 * pills on failure and the LLM would treat the failure text as soft data.
 */
function failureResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}
