import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage as ChatMessageType } from "../../chat/types";
import { ChatMessage } from "./ChatMessage";

/**
 * Build a minimal assistant chat message for rendering tests.
 */
function makeAssistantMessage(overrides: Partial<ChatMessageType>): ChatMessageType {
  return {
    id: "assistant_1",
    role: "assistant",
    text: "",
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe("ChatMessage markdown rendering", () => {
  it("renders raw markdown while assistant message is streaming", () => {
    render(
      <ChatMessage
        message={makeAssistantMessage({
          isStreaming: true,
          text: "A [link](https://example.com) still streaming",
        })}
      />,
    );

    expect(screen.queryByRole("link", { name: "link" })).not.toBeInTheDocument();
    expect(screen.getByText("A [link](https://example.com) still streaming")).toBeInTheDocument();
  });

  it("renders markdown once streaming completes", () => {
    render(
      <ChatMessage
        message={makeAssistantMessage({
          isStreaming: false,
          text: "A [link](https://example.com) fully rendered",
        })}
      />,
    );

    expect(screen.getByRole("link", { name: "link" })).toHaveAttribute("href", "https://example.com");
  });

  it("does not mutate near-miss markdown into links", () => {
    render(
      <ChatMessage
        message={makeAssistantMessage({
          isStreaming: false,
          text: "Literal text: [label] (https://example.com)",
        })}
      />,
    );

    expect(screen.queryByRole("link", { name: "label" })).not.toBeInTheDocument();
    expect(screen.getByText("Literal text: [label] (https://example.com)")).toBeInTheDocument();
  });
});

