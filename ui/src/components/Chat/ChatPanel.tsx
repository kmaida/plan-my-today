import { useState, useRef, useEffect } from 'react'
import { useChat } from '../../chat/useChat'
import { useMCP } from '../../mcp'
import { ChatMessage } from './ChatMessage'
import './ChatPanel.css'

const SYSTEM_PROMPT = `You are a daily planning assistant helping the user maximize productivity by analyzing their tasks from multiple sources. You have access to MCP tools that can fetch tasks from Calendar, Linear, Gmail, GitHub, Slack, Google Docs, and Meeting Notes.

Key behaviors:
- When the user asks to plan their day or check tasks, call list-all-tasks-today first
- Analyze priority metadata (score 0-300, categories: critical/high/medium/low)
- Always include clickable links for every item you mention
- Use visual indicators: red circle for critical, yellow circle for high, blue circle for medium, white circle for low
- Be concise and scannable — use markdown headers and bullet points
- Explain your reasoning when prioritizing work

Available completion tools:
- mark-email-complete: Mark a Gmail message as complete
- mark-action-complete: Mark a meeting note, Slack message, or ad-hoc task as complete`

interface ChatPanelProps {
  isOpen: boolean
  onToggle: () => void
  onTasksUpdated?: () => void
}

export function ChatPanel({ isOpen, onToggle, onTasksUpdated }: ChatPanelProps) {
  const { isConnected } = useMCP()
  const { messages, isLoading, error, sendMessage, clearMessages } = useChat(SYSTEM_PROMPT)
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
        <h2 className="chat-panel__title">Chat</h2>
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
        {!isConnected && (
          <div className="chat-panel__notice">
            MCP client not connected. Sign in to start chatting.
          </div>
        )}

        {isConnected && messages.length === 0 && (
          <div className="chat-panel__notice">
            Ask me to plan your day, check your tasks, or help you prioritize.
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {isLoading && (
          <div className="chat-panel__thinking">Thinking...</div>
        )}

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
          placeholder={isConnected ? 'Ask about your tasks...' : 'Sign in to chat'}
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
