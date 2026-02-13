import { useState, useRef, useEffect } from 'react'
import { useChat } from '../../chat/useChat'
import { useAuth } from '../../auth'
import { useMCP } from '../../mcp'
import { ChatMessage } from './ChatMessage'
import type { ChatMessage as ChatMessageType } from '../../chat/types'
import { ThinkingIndicator } from './ThinkingIndicator'
import { buildSystemPrompt } from '../../chat/system-prompt'
import type { SessionUsage } from '../../chat/useChat'
import { extractToolCallAuthErrors } from '../../chat/auth-error-detection'
import './ChatPanel.css'

/** Format a token count as a compact string (e.g., 1234 → "1.2k"). */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}

/** Calculate cache hit percentage from session usage. */
function getCacheHitPercent(usage: SessionUsage): number {
  const totalInput =
    usage.totalInputTokens + usage.totalCacheCreationTokens + usage.totalCacheReadTokens
  if (totalInput === 0) return 0
  return Math.round((usage.totalCacheReadTokens / totalInput) * 100)
}

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
  'I\'m Todaygent. I pull from your calendar, Linear, Gmail, Slack, etc. so you don\'t have to. Tell me to plan your day.',
  'Todaygent, reporting for duty. I\'ve got eyes on your calendar, inbox, Slack, Linear, GitHub, etc. Say the word and I\'ll brief you.',
  'I\'m Todaygent. I aggregate your calendar, email, meeting notes, Slack, Linear, etc. into one plan. They don\'t let me execute on it yet, but I make a great briefing.',
  'Todaygent here. I read your calendar, email, meeting notes, Slack, Linear, GitHub, etc. so you don\'t have to open even MORE tabs. Ask me to plan your day.',
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
 * Scan completed tool calls for auth-related errors.
 * Delegates to the shared auth-error-detection utility for per-tool-call
 * analysis (structured JSON parsing for aggregate tools, pattern matching
 * for individual tools).
 */
function extractAuthErrors(messages: ChatMessageType[]): string[] {
  const errors: string[] = []
  for (const msg of messages) {
    if (!msg.toolCalls) continue
    for (const tc of msg.toolCalls) {
      errors.push(...extractToolCallAuthErrors(tc))
    }
  }
  return errors
}

export function ChatPanel({ isOpen, onToggle, onToolCallsComplete }: ChatPanelProps) {
  const { isAuthenticated } = useAuth()
  const { isConnected, error: mcpError } = useMCP()
  const { messages, isLoading, error, sessionUsage, sendMessage, clearMessages } = useChat(buildSystemPrompt)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [showTokenDetails, setShowTokenDetails] = useState(false)
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
    } else {
      // Messages changed without a loading transition (e.g., restored from
      // sessionStorage). Mark them as already scanned so old auth errors
      // from a previous session aren't re-reported on the next real turn.
      scannedCountRef.current = messages.length
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

      {sessionUsage.totalInputTokens > 0 && (
        <div className="token-stats">
          <button
            className="token-stats__toggle"
            onClick={() => setShowTokenDetails((prev) => !prev)}
            title="Toggle token usage details"
          >
            {formatTokenCount(sessionUsage.totalInputTokens + sessionUsage.totalOutputTokens)} tokens
            {showTokenDetails ? ' \u2212' : ' +'}
          </button>
          {showTokenDetails && (
            <div className="token-stats__details">
              <span className="token-stats__item">
                <span className="token-stats__label">in:</span>
                {formatTokenCount(sessionUsage.totalInputTokens)}
              </span>
              <span className="token-stats__item">
                <span className="token-stats__label">out:</span>
                {formatTokenCount(sessionUsage.totalOutputTokens)}
              </span>
              {sessionUsage.totalCacheReadTokens > 0 && (
                <span className="token-stats__item token-stats__cache-hit">
                  <span className="token-stats__label">cached:</span>
                  {getCacheHitPercent(sessionUsage)}%
                </span>
              )}
            </div>
          )}
        </div>
      )}

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
