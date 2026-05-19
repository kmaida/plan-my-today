/**
 * Pre-call HITL approval card. Rendered inline in the chat when Todaygent
 * tries to invoke a tool in `TOOLS_REQUIRING_APPROVAL` (currently just
 * `delegate-task-to-roibot`). The user must click Approve before the call
 * is dispatched — the dispatch happens client-side, so the LLM cannot
 * bypass this gate.
 *
 * @remarks
 * **Why this exists**: making A2A delegation human-initiated is a
 * load-bearing property of the system, not an emergent LLM behavior. The
 * agentic loop in `useChat.ts` pauses at this card and only calls the
 * underlying MCP tool if the user clicks Approve. Deny feeds a synthetic
 * "user denied" result back to Claude so the conversation stays
 * well-formed and the agent doesn't retry.
 *
 * **Shape**: the card guards a single tool invocation. For
 * `delegate-task-to-roibot` the input is `{ task: string }`, so we render
 * the task text directly. When a second tool joins the allowlist, add a
 * `toolName` field to PendingApprovalMeta and switch on it here.
 */

import { useState } from "react";
import type { PendingApprovalMeta } from "../../chat/types";
import "./ApprovalCard.css";

interface ApprovalCardProps {
  pending: PendingApprovalMeta;
}

export function ApprovalCard({ pending }: ApprovalCardProps) {
  const [submitted, setSubmitted] = useState(false);

  function decide(approved: boolean) {
    if (submitted) return;
    setSubmitted(true);
    pending.resolve({ approved });
  }

  // delegate-task-to-roibot's only input is `task: string`. Other tools
  // added to TOOLS_REQUIRING_APPROVAL would need their own rendering.
  const taskText =
    (pending.toolInput as { task?: string })?.task ??
    JSON.stringify(pending.toolInput, null, 2);

  return (
    <div className="approval-card" role="region" aria-label="Pending delegation approval">
      <div className="approval-card__header">
        <span className="approval-card__lock" aria-hidden="true">
          🔒
        </span>
        <strong>Todaygent wants to delegate to ROIbot</strong>
      </div>
      <p className="approval-card__intro">
        Approve to send this task over A2A. Nothing leaves your browser until
        you click.
      </p>
      <p className="approval-card__intro">
        Heads up: ROIbot assessments and Linear-heavy tasks can take a few
        minutes. The pill below will spin until ROIbot replies.
      </p>
      <blockquote className="approval-card__task">{taskText}</blockquote>
      <div className="approval-card__footer">
        <button
          type="button"
          className="approval-card__btn approval-card__btn--deny"
          disabled={submitted}
          onClick={() => decide(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="approval-card__btn approval-card__btn--approve approval-card__submit"
          disabled={submitted}
          onClick={() => decide(true)}
        >
          Approve and send
        </button>
      </div>
    </div>
  );
}
