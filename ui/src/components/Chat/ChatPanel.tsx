import { useState, useRef, useEffect } from 'react'
import { useChat } from '../../chat/useChat'
import { useAuth } from '../../auth'
import { useMCP } from '../../mcp'
import { ChatMessage } from './ChatMessage'
import type { ChatMessage as ChatMessageType } from '../../chat/types'
import { ThinkingIndicator } from './ThinkingIndicator'
import { buildSystemPrompt } from '../../chat/system-prompt'
import './ChatPanel.css'

interface ChatPanelProps {
  isOpen: boolean
  onToggle: () => void
  /** Called after a chat turn completes with tool calls. Includes whether
   *  list-all-tasks-today ran (so the caller can re-read the cache) and any
   *  auth errors detected from tool results. */
  onToolCallsComplete?: (result: { didFetchAllTasks: boolean; authErrors: string[] }) => void
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

const WELCOME_MESSAGES = [
  // Informative with personality
  'I\'m Todaygent. I pull from your calendar, Linear, Gmail, Slack, and GitHub so you don\'t have to. Tell me to plan your day.',
  'Todaygent, reporting for duty. I\'ve got eyes on your calendar, inbox, Slack, Linear, and GitHub. Say the word and I\'ll brief you.',
  'I\'m Todaygent. I aggregate your calendar, email, Slack, Linear, and GitHub into one plan. They don\'t let me execute on it yet, but I make a great briefing.',
  'Todaygent here. I read your calendar, email, Slack, Linear, and GitHub so you don\'t have to open six tabs. Ask me to plan your day.',
  'I\'m Todaygent. I exist because calendar blocking didn\'t work. You just kept pushing those blocks to Friday. Let me plan your day instead.',
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

/**
 * Patterns in tool results that indicate an auth/token error requiring reauthorization.
 * Mirrored in src/utils/__tests__/auth-error-detection-contract.test.ts — update both.
 */
const AUTH_ERROR_PATTERNS = [
  'unauthorized',
  'invalid_grant',
  'not allowed to exchange token',
  'token exchange failed',
  'authentication failed',
  'access denied',
  'reauthoriz',
  '401',
  '403',
  'forbidden',
]

/**
 * Scan completed tool calls for auth-related errors.
 * Returns an array of human-readable error strings (empty if none found).
 */
function extractAuthErrors(messages: ChatMessageType[]): string[] {
  const errors: string[] = []
  for (const msg of messages) {
    if (!msg.toolCalls) continue
    for (const tc of msg.toolCalls) {
      if (!tc.result) continue
      const lower = tc.result.toLowerCase()
      const isAuthError = AUTH_ERROR_PATTERNS.some((p) => lower.includes(p))
      if (isAuthError) {
        errors.push(`${tc.name}: ${tc.result.slice(0, 200)}`)
      }
    }
  }
  return errors
}

export function ChatPanel({ isOpen, onToggle, onToolCallsComplete }: ChatPanelProps) {
  const { isAuthenticated } = useAuth()
  const { isConnected, error: mcpError } = useMCP()
  const { messages, isLoading, error, sendMessage, clearMessages } = useChat(buildSystemPrompt)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [placeholder, setPlaceholder] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])
  const [buttonLabel, setButtonLabel] = useState(() => BUTTON_LABELS[Math.floor(Math.random() * BUTTON_LABELS.length)])
  const [welcomeMsg, setWelcomeMsg] = useState(() => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)])

  // Re-randomize labels each time the chat is toggled
  useEffect(() => {
    setPlaceholder(PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])
    setButtonLabel(BUTTON_LABELS[Math.floor(Math.random() * BUTTON_LABELS.length)])
    setWelcomeMsg(WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)])
  }, [isOpen])

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // After each chat turn completes, notify the parent about what happened.
  // Only scans messages added since the last scan to avoid re-reporting old errors.
  const prevLoadingRef = useRef(false)
  const scannedCountRef = useRef(0)
  useEffect(() => {
    const wasLoading = prevLoadingRef.current
    prevLoadingRef.current = isLoading
    if (wasLoading && !isLoading && messages.length > 0 && onToolCallsComplete) {
      const newMessages = messages.slice(scannedCountRef.current)
      scannedCountRef.current = messages.length

      const didFetchAllTasks = newMessages.some(
        (m) => m.toolCalls?.some((tc) => tc.name === 'list-all-tasks-today'),
      )
      const authErrors = extractAuthErrors(newMessages)

      if (didFetchAllTasks || authErrors.length > 0) {
        onToolCallsComplete({ didFetchAllTasks, authErrors })
      }
    }
  }, [isLoading, messages, onToolCallsComplete])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || isLoading) return
    setInput('')
    await sendMessage(text)
  }

  if (!isOpen) {
    return (
      <button className="chat-toggle" onClick={onToggle} title="Open chat">
        <img src="/logo-sm.svg" alt="" className="chat-toggle__icon" />
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
            {welcomeMsg}
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
