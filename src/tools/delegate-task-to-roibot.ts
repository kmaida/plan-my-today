import { z } from "zod/v3";
import { type DelegateResult, isROIbotConfigured, startTask } from "../services/roibot-a2a-client";
import type { McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";

/**
 * MCP tool that delegates a free-form task from Todaygent to ROIbot
 * over A2A. Pass a natural-language description; ROIbot's own LLM
 * picks tools internally and returns a coherent reply.
 *
 * @remarks
 * **HITL gate is enforced UI-side, not here.** Todaygent's chat UI
 * intercepts every `delegate-task-to-roibot` invocation and waits for
 * the user to click Approve before the call ever reaches this handler.
 * The LLM cannot bypass the gate because dispatch happens in client
 * code; see `ui/src/chat/useChat.ts` (`TOOLS_REQUIRING_APPROVAL`).
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
        "Destructive actions (delete event, merge events, change config) are out of scope for A2A; if the " +
        "user wants one, tell them to use ROIbot directly in its own chat.",
      inputSchema: {
        task: z.string().min(1).describe("Natural-language task description for ROIbot's agent."),
      },
    },
    async ({ task }, { authInfo }) => {
      if (!authInfo) return errorResult("❌ Not authenticated.");
      if (!isROIbotConfigured())
        return errorResult(
          "⚠️ ROIBOT_AGENT_ENDPOINT not configured. Set it to ROIbot's /api/agent URL."
        );
      try {
        const result = await startTask(authInfo, task);
        return formatResult(result);
      } catch (error) {
        return handleToolError(
          error,
          "ROIbot",
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
    return errorResult(
      "⚠️ ROIbot returned an approval-required state, which is not allowed over A2A. " +
        "Destructive actions must be performed in ROIbot's own chat."
    );
  }
  if (result.state === "failed") {
    return errorResult(result.finalText || "ROIbot delegation failed.");
  }
  // completed
  return {
    content: [{ type: "text" as const, text: result.finalText || "Done." }],
  };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
