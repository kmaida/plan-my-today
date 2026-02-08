import ReactMarkdown from 'react-markdown'
import type { ChatMessage as ChatMessageType } from '../../chat/types'
import { ToolCallCard } from './ToolCallCard'

interface ChatMessageProps {
  message: ChatMessageType
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user'

  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <div className="chat-message__bubble">
        {message.text && (
          <div className="chat-message__text">
            {isUser ? (
              message.text
            ) : (
              <ReactMarkdown
                components={{
                  a: ({ children, href, ...props }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                      {children}
                    </a>
                  ),
                }}
              >
                {message.text}
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
        {isUser ? 'You' : 'Claude'} &middot;{' '}
        {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  )
}
