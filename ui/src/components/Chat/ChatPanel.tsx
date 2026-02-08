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

const BUTTON_LABELS = [
  // Practical
  'Ask Todaygent',
  'Plan my day',
  'Need a plan?',
  'Talk to Todaygent',
  'Get organized',
  // Personality (sprinkled in)
  'Summon Todaygent',
  'Deploy Todaygent',
]

const PLACEHOLDERS = [
  // Practical / planner
  'What do I have today?',
  'Plan my day',
  'What should I tackle first?',
  'What\'s urgent?',
  'Help me prioritize',
  'Where should I start?',
  'Summarize my tasks',
  'What\'s on my plate?',
  // Personality (sprinkled in)
  'What\'s on fire today?',
  'How bad is it today?',
  'Give me the damage report',
  'Brief me, Todaygent',
]

export function ChatPanel({ isOpen, onToggle, onTasksUpdated }: ChatPanelProps) {
  const { isAuthenticated } = useAuth()
  const { isConnected, error: mcpError } = useMCP()
  const { messages, isLoading, error, sendMessage, clearMessages } = useChat(buildSystemPrompt)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [placeholder, setPlaceholder] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])
  const [buttonLabel, setButtonLabel] = useState(() => BUTTON_LABELS[Math.floor(Math.random() * BUTTON_LABELS.length)])

  // Re-randomize labels each time the chat is toggled
  useEffect(() => {
    setPlaceholder(PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])
    setButtonLabel(BUTTON_LABELS[Math.floor(Math.random() * BUTTON_LABELS.length)])
  }, [isOpen])

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
        {buttonLabel}
      </button>
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel__header">
        <h2 className="chat-panel__title"><img src="/logo-sm.svg" alt="" className="chat-panel__logo" /><span><span className="app-brand__to">Tod</span><strong>a</strong><span className="app-brand__to">y</span><strong>gent</strong></span></h2>
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
          placeholder={isConnected ? placeholder : 'Sign in to chat'}
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
