import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingApprovalMeta } from "../../chat/types";
import { ApprovalCard } from "./ApprovalCard";

/**
 * Build a {@link PendingApprovalMeta} with a fresh resolve spy.
 *
 * The shape mirrors what `awaitPreCallApproval` in useChat constructs for
 * `delegate-task-to-roibot` invocations. The `resolve` spy lets each test
 * assert exactly how it was called (or not).
 */
function makePending(
  toolInput: PendingApprovalMeta["toolInput"] = { task: "assess SREcon" }
): { pending: PendingApprovalMeta; resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn();
  return { pending: { toolInput, resolve }, resolve };
}

describe("ApprovalCard", () => {
  it("renders the task text from toolInput.task", () => {
    const { pending } = makePending({ task: "Generate ROI report for Q1 events" });
    render(<ApprovalCard pending={pending} />);

    expect(screen.getByText("Generate ROI report for Q1 events")).toBeInTheDocument();
  });

  it("falls back to JSON.stringify when toolInput has no `task` field", () => {
    // Defensive path for hypothetical future tools in the allowlist that
    // don't follow the `{ task: string }` shape. We render the raw input
    // rather than rendering nothing — the user can still see what's pending.
    const { pending } = makePending({ event: "SREcon", action: "delete" });
    render(<ApprovalCard pending={pending} />);

    expect(screen.getByText(/"event": "SREcon"/)).toBeInTheDocument();
    expect(screen.getByText(/"action": "delete"/)).toBeInTheDocument();
  });

  it("calls resolve with { approved: true } when Approve is clicked", () => {
    const { pending, resolve } = makePending();
    render(<ApprovalCard pending={pending} />);

    fireEvent.click(screen.getByRole("button", { name: /approve and send/i }));

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ approved: true });
  });

  it("calls resolve with { approved: false } when Deny is clicked", () => {
    const { pending, resolve } = makePending();
    render(<ApprovalCard pending={pending} />);

    fireEvent.click(screen.getByRole("button", { name: /^deny$/i }));

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ approved: false });
  });

  it("disables both buttons after the first click and ignores subsequent clicks", () => {
    // Defense against double-resolve. Even if the user (or a flaky event)
    // triggers a second click before the card unmounts, the resolve callback
    // must only fire once — otherwise the agentic loop's promise resolution
    // contract breaks.
    const { pending, resolve } = makePending();
    render(<ApprovalCard pending={pending} />);

    const approve = screen.getByRole("button", { name: /approve and send/i });
    const deny = screen.getByRole("button", { name: /^deny$/i });

    fireEvent.click(approve);
    expect(approve).toBeDisabled();
    expect(deny).toBeDisabled();

    fireEvent.click(approve);
    fireEvent.click(deny);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
