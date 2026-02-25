import { useMemo, memo } from "react";
import ReactMarkdown from "react-markdown";
import type { ChatMessage as ChatMessageType } from "../../chat/types";
import { ToolCallCard } from "./ToolCallCard";

/** Static ReactMarkdown overrides — extracted to module level to avoid re-creation */
const markdownComponents = {
  a: ({ children, href, ...props }: React.ComponentPropsWithoutRef<'a'>) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
}

interface ChatMessageProps {
  message: ChatMessageType
}

export const ChatMessage = memo(function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const assistantRenderText = message.text
  const formattedTime = useMemo(
    () => new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    [message.timestamp],
  )

  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <div className="chat-message__bubble">
        {message.text && (
          <div className={`chat-message__text ${message.isStreaming ? "chat-message__text--streaming" : ""}`}>
            {isUser ? (
              message.text
            ) : message.isStreaming ? (
              assistantRenderText
            ) : (
              <ReactMarkdown components={markdownComponents}>
                {assistantRenderText}
              </ReactMarkdown>
            )}
          </div>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="chat-message__tools">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
      <div className="chat-message__meta">
        {isUser ? "You" : "Todaygent"} &middot; {formattedTime}
      </div>
    </div>
  );
})
