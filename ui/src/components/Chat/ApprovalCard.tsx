/**
 * Approval card rendered inline in the chat when ROIbot pauses at a Tier-1
 * destructive action. The user must explicitly approve or deny each pending
 * tool call before the chat resumes — this is the UI-enforced HITL gate.
 *
 * @remarks
 * **Why this exists**: ROIbot's orchestrator returns `state: 'input-required'`
 * when it wants to run a destructive tool. The MCP tool result carries
 * `_meta.pendingApproval` with structured pending-tool details. `useChat`
 * intercepts that meta BEFORE feeding any result back to the LLM and
 * surfaces this card. The LLM physically cannot self-approve because it
 * never sees the pending state — that's the security argument.
 *
 * **Per-tool decisions**: when ROIbot emits multiple Tier-1 tools in one
 * turn, each gets its own card; the user approves or denies them
 * independently. The "submit decisions" button is enabled only once
 * every card has been resolved.
 */

import { useState } from "react";
import type { PendingApprovalMeta } from "../../chat/types";
import "./ApprovalCard.css";

interface ApprovalCardProps {
  pending: PendingApprovalMeta;
}

export function ApprovalCard({ pending }: ApprovalCardProps) {
  // Per-toolUseId state: undefined = unresolved, true = approve, false = deny.
  const [decisions, setDecisions] = useState<
    Record<string, { approved: boolean; reason?: string } | undefined>
  >({});
  const [submitted, setSubmitted] = useState(false);

  const allResolved = pending.pendingToolCalls.every(
    (p) => decisions[p.toolUseId] !== undefined,
  );

  function setDecision(toolUseId: string, approved: boolean) {
    if (submitted) return;
    setDecisions((prev) => ({ ...prev, [toolUseId]: { approved } }));
  }

  function handleSubmit() {
    if (!allResolved || submitted) return;
    // TS doesn't know `decisions[k]` is non-undefined after the allResolved
    // check; assert via map.
    const final: Record<string, { approved: true } | { approved: false; reason?: string }> = {};
    for (const p of pending.pendingToolCalls) {
      const d = decisions[p.toolUseId];
      if (!d) continue; // shouldn't happen given allResolved
      final[p.toolUseId] = d.approved ? { approved: true } : { approved: false };
    }
    setSubmitted(true);
    pending.resolve(final);
  }

  return (
    <div className="approval-card" role="region" aria-label="Pending action approval">
      <div className="approval-card__header">
        <span className="approval-card__lock" aria-hidden="true">
          🔒
        </span>
        <strong>ROIbot needs your approval</strong>
      </div>
      <p className="approval-card__intro">
        ROIbot wants to run the following destructive action
        {pending.pendingToolCalls.length > 1 ? "s" : ""}. Approve or deny each
        before the task continues.
      </p>
      <ul className="approval-card__list">
        {pending.pendingToolCalls.map((p) => {
          const decision = decisions[p.toolUseId];
          return (
            <li key={p.toolUseId} className="approval-card__item">
              <div className="approval-card__tool">
                <code>{p.toolName}</code>
                <pre className="approval-card__input">
                  {JSON.stringify(p.toolInput, null, 2)}
                </pre>
              </div>
              <div className="approval-card__buttons">
                <button
                  type="button"
                  disabled={submitted}
                  className={`approval-card__btn approval-card__btn--approve${decision?.approved === true ? " approval-card__btn--selected" : ""}`}
                  onClick={() => setDecision(p.toolUseId, true)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={submitted}
                  className={`approval-card__btn approval-card__btn--deny${decision?.approved === false ? " approval-card__btn--selected" : ""}`}
                  onClick={() => setDecision(p.toolUseId, false)}
                >
                  Deny
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="approval-card__footer">
        <button
          type="button"
          className="approval-card__submit"
          disabled={!allResolved || submitted}
          onClick={handleSubmit}
        >
          {submitted
            ? "Resuming…"
            : allResolved
              ? "Submit decisions"
              : "Choose Approve or Deny for each item"}
        </button>
      </div>
    </div>
  );
}
