import { z } from "zod/v3";
import {
  isROIbotConfigured,
  resumeTask,
  startTask,
  type DelegateResult,
} from "../services/roibot-a2a-client";
import type { McpServer } from "../types/index";
import { handleToolError } from "../utils/tool-error-utils";

/**
 * Two tools that together implement A2A delegation to ROIbot:
 *
 * 1. `delegate-task-to-roibot` — the LLM-facing entry point. Pass a
 *    natural-language task description; ROIbot picks tools internally.
 *
 * 2. `resume-roibot-task` — INTERNAL. Called by Todaygent's chat HITL
 *    infrastructure (NOT by the LLM directly) after the user clicks
 *    Approve/Deny on a pending action card. The system prompt forbids
 *    the LLM from calling this tool itself — that's how we make the
 *    HITL gate UI-enforced rather than vibes-based.
 *
 * @remarks
 * **Tool result `_meta.pendingApproval` is the security boundary**
 *
 * When ROIbot returns `state: 'input-required'`, this tool returns a
 * `_meta.pendingApproval` field on the tool result. MCP's `_meta` is
 * a documented extension field that tool result consumers (the chat
 * UI) can read but the LLM never sees. The chat UI intercepts results
 * with `_meta.pendingApproval` and renders an approval card BEFORE
 * feeding anything back to the LLM. The LLM can't self-approve
 * because it physically never sees the pending state.
 *
 * **Two tools, not one polymorphic schema**
 *
 * Splitting `delegate-task-to-roibot` (start) from `resume-roibot-task`
 * (continuation) keeps each schema narrow and makes the LLM's choice
 * obvious. A single polymorphic tool with optional `taskId`/`approvals`
 * fields would invite the LLM to call resume directly — which would
 * defeat the chat-UI HITL boundary. The system prompt's "never call
 * resume" rule + the resume tool's INTERNAL marker reinforce the split.
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
        "If the task involves a destructive action (delete event, merge events, change config), the chat UI " +
        "will pause for user approval automatically — do NOT call resume-roibot-task yourself.",
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe("Natural-language task description for ROIbot's agent."),
      },
    },
    async ({ task }, { authInfo }) => {
      if (!authInfo) return errorResult("❌ Not authenticated.");
      if (!isROIbotConfigured())
        return errorResult(
          "⚠️ ROIBOT_AGENT_ENDPOINT not configured. Set it to ROIbot's /api/agent URL.",
        );
      try {
        const result = await startTask(authInfo, task);
        return formatResult(result);
      } catch (error) {
        return handleToolError(error, "ROIbot", [], [
          "Check ROIBOT_AGENT_ENDPOINT and the Keycard zone delegation chain.",
        ]);
      }
    },
  );

  // ── resume-roibot-task ────────────────────────────────────────────────
  mcpServer.registerTool(
    "resume-roibot-task",
    {
      title: "Resume ROIbot task with approvals (INTERNAL)",
      description:
        "INTERNAL — called by Todaygent's chat UI after the user clicks Approve or Deny on a pending action " +
        "card. Do NOT call this directly. The chat UI invokes it with the structured approval payload " +
        "after rendering the card. If you (the assistant) call this tool, you are bypassing the human-in-" +
        "the-loop gate, which is a violation of the safety contract.",
      inputSchema: {
        taskId: z
          .string()
          .describe("Echo from a prior input-required tool result, to continue."),
        contextId: z
          .string()
          .describe("Echo from a prior input-required tool result, to continue."),
        approvals: z
          .record(
            z.string(),
            z.union([
              z.object({ approved: z.literal(true) }),
              z.object({ approved: z.literal(false), reason: z.string().optional() }),
            ]),
          )
          .describe(
            "Per-tool_use_id approval decisions: { [toolUseId]: { approved: boolean, reason?: string } }",
          ),
      },
    },
    async ({ taskId, contextId, approvals }, { authInfo }) => {
      if (!authInfo) return errorResult("❌ Not authenticated.");
      try {
        const result = await resumeTask(authInfo, taskId, contextId, approvals);
        return formatResult(result);
      } catch (error) {
        return handleToolError(error, "ROIbot", [], [
          "Continuation failed; the task may have expired (24h TTL).",
        ]);
      }
    },
  );
}

/**
 * Translate a {@link DelegateResult} into an MCP tool result.
 *
 * For `input-required`, attach the structured pending state under
 * `_meta.pendingApproval` so the chat UI can render an approval card.
 * The text content describes the situation in plain English so it
 * also makes sense to a non-card-aware client (e.g. mcp-remote).
 */
function formatResult(result: DelegateResult) {
  if (result.state === "input-required") {
    const pendingSummary = result.pendingToolCalls
      ?.map(
        (p, i) =>
          `${i + 1}. ${p.toolName}(${JSON.stringify(p.toolInput).slice(0, 200)})`,
      )
      .join("\n") ?? "(no pending tool calls reported)";
    return {
      content: [
        {
          type: "text" as const,
          text:
            `🔒 ROIbot needs human approval before proceeding:\n\n${pendingSummary}\n\n` +
            (result.finalText ? `${result.finalText}\n` : ""),
        },
      ],
      _meta: {
        pendingApproval: {
          taskId: result.taskId,
          contextId: result.contextId,
          pendingToolCalls: result.pendingToolCalls ?? [],
        },
      },
    };
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
