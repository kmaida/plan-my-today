import { useState, useRef, useEffect } from 'react'
import { useChat } from '../../chat/useChat'
import { useAuth } from '../../auth'
import { useMCP } from '../../mcp'
import { ChatMessage } from './ChatMessage'
import { ThinkingIndicator } from './ThinkingIndicator'
import { buildSystemPrompt } from '../../chat/system-prompt'
import './ChatPanel.css'

interface ChatPanelProps {
  isOpen: boolean
  onToggle: () => void
  onTasksUpdated?: () => void
}

export function ChatPanel({ isOpen, onToggle, onTasksUpdated }: ChatPanelProps) {
  const { isAuthenticated } = useAuth()
  const { isConnected, error: mcpError } = useMCP()
  const { messages, isLoading, error, sendMessage, clearMessages } = useChat(buildSystemPrompt)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Notify parent when tasks may have been updated (after tool calls complete)
  useEffect(() => {
    if (!isLoading && messages.length > 0 && onTasksUpdated) {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg.toolCalls?.some((tc) => tc.name === 'list-all-tasks-today')) {
        onTasksUpdated()
      }
    }
  }, [isLoading, messages, onTasksUpdated])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || isLoading) return
    setInput('')
    await sendMessage(text)
  }

  if (!isOpen) {
    return (
      <button className="chat-toggle btn--inverted" onClick={onToggle} title="Open chat">
        Chat
      </button>
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel__header">
        <h2 className="chat-panel__title">Todaygent</h2>
        <div className="chat-panel__actions">
          {messages.length > 0 && (
            <button
              className="chat-panel__clear"
              onClick={clearMessages}
              title="Clear conversation"
            >
              Clear
            </button>
          )}
          <button className="chat-panel__close" onClick={onToggle} title="Close chat">
            &times;
          </button>
        </div>
      </div>

      <div className="chat-panel__messages">
        {!isConnected && !isAuthenticated && (
          <div className="chat-panel__notice">
            Sign in to start chatting.
          </div>
        )}

        {!isConnected && isAuthenticated && (
          <div className="chat-panel__notice">
            {mcpError
              ? 'Could not connect to server. Try reloading the page or signing out and back in.'
              : 'Connecting to server...'}
          </div>
        )}

        {isConnected && messages.length === 0 && (
          <div className="chat-panel__notice">
            I'm Todaygent. Tell me to plan your day and I'll pull in everything from your calendar, Linear, Gmail, Slack, GitHub, and more.
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {isLoading && <ThinkingIndicator />}

        {error && (
          <div className="chat-panel__error">{error}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="chat-panel__input-area" onSubmit={handleSubmit}>
        <input
          className="chat-panel__input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isConnected ? 'What do I have today?' : 'Sign in to chat'}
          disabled={!isConnected || isLoading}
        />
        <button
          className="chat-panel__send btn--inverted"
          type="submit"
          disabled={!isConnected || isLoading || !input.trim()}
        >
          Send
        </button>
      </form>
    </div>
  )
}
