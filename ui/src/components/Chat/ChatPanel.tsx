import { useState, useRef, useEffect } from 'react'
import { useChat } from '../../chat/useChat'
import { useAuth } from '../../auth'
import { useMCP } from '../../mcp'
import { ChatMessage } from './ChatMessage'
import { ErrorDetail } from './ErrorDetail'
import { ThinkingIndicator } from './ThinkingIndicator'
import { TodaygentMascot } from './TodaygentMascot'
import { buildSystemPrompt } from '../../chat/system-prompt'
import { Chevron } from '../Chevron'
import type { SessionUsage } from '../../chat/useChat'
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
   *  list-all-tasks-today ran (so the caller can re-read the task store) and any
   *  auth errors detected from tool results. */
  onToolCallsComplete?: (result: { didFetchAllTasks: boolean; authErrors: string[] }) => void
  /** Called just before list-all-tasks-today executes, so the header can start
   *  its loading animation (cycling text, logo spin) during the API call. */
  onFetchStarted?: () => void
}

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

export function ChatPanel({ isOpen, onToggle, onToolCallsComplete, onFetchStarted }: ChatPanelProps) {
  const { isAuthenticated } = useAuth()
  const { isConnected, error: mcpError } = useMCP()
  // Auth error detection is handled inside useChat at call time (via the
  // onToolRoundComplete callback) — no effect-based scanning needed here.
  const { messages, isLoading, error, sessionUsage, sendMessage, cancel, clearMessages } = useChat(
    buildSystemPrompt,
    onToolCallsComplete,
    onFetchStarted,
  )
  const [input, setInput] = useState('')
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [showTokenDetails, setShowTokenDetails] = useState(false)
  const [placeholder] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])
  const [welcomeMsg] = useState(() => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)])

  // Auto-focus the input when the chat panel opens.
  // Delay allows Suspense lazy-load mount to complete first.
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Keep the messages container scrolled to the bottom.
  // Uses scrollTop on the container directly — no sentinel div, no rAF,
  // no layout-timing fragility. Works for both restored and new messages.
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, isOpen])

  const lastMessageIsAssistant =
    messages.length > 0 && messages[messages.length - 1].role === 'assistant'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || isLoading) return
    setInput('')
    await sendMessage(text)
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

      <div className="chat-panel__messages" ref={messagesRef}>
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
          <div className="chat-panel__welcome">
            <TodaygentMascot state="idle" size={100} className="chat-panel__welcome-mascot" />
            <p className="chat-panel__welcome-text">{welcomeMsg}</p>
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {error && (
          <div className="chat-panel__error">
            <div className="chat-panel__error-summary">{error.summary}</div>
            {error.detail && <ErrorDetail error={error.detail} />}
          </div>
        )}

      </div>

      {/* ── Pinned mascot strip (between messages + input, doesn't scroll) ── */}
      {isLoading ? (
        <div className="chat-panel__mascot-strip">
          <ThinkingIndicator />
        </div>
      ) : lastMessageIsAssistant && (
        <div className="chat-panel__mascot-strip chat-panel__mascot-strip--idle">
          <TodaygentMascot state="idle" size={40} />
        </div>
      )}

      {sessionUsage.totalInputTokens > 0 && (
        <div className="token-stats">
          <button
            className="token-stats__toggle"
            onClick={() => setShowTokenDetails((prev) => !prev)}
            title="Toggle token usage details"
          >
            {formatTokenCount(sessionUsage.totalInputTokens + sessionUsage.totalOutputTokens)} tokens
            <Chevron direction={showTokenDetails ? 'left' : 'right'} size={10} />
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
          ref={inputRef}
          className="chat-panel__input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isConnected ? placeholder : 'Sign in to chat'}
          disabled={!isConnected || isLoading}
        />
        {isLoading ? (
          <button
            className="chat-panel__stop"
            type="button"
            onClick={cancel}
            title="Stop generating"
          >
            Stop
          </button>
        ) : (
          <button
            className="chat-panel__send btn--inverted"
            type="submit"
            disabled={!isConnected || !input.trim()}
          >
            Send
          </button>
        )}
      </form>
    </div>
  )
}

export default ChatPanel
