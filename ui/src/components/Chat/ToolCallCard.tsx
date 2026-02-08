import { useState } from 'react'
import type { ToolCall } from '../../chat/types'

interface ToolCallCardProps {
  toolCall: ToolCall
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`tool-call-card ${toolCall.isError ? 'tool-call-card--error' : ''}`}>
      <button
        className="tool-call-card__header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="tool-call-card__icon">
          {toolCall.isError ? '\u2716' : '\u2714'}
        </span>
        <span className="tool-call-card__name">{toolCall.name}</span>
        <span className="tool-call-card__toggle">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {expanded && (
        <div className="tool-call-card__details">
          {Object.keys(toolCall.input).length > 0 && (
            <div className="tool-call-card__section">
              <span className="tool-call-card__label">Input</span>
              <pre className="tool-call-card__code">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div className="tool-call-card__section">
              <span className="tool-call-card__label">Result</span>
              <pre className="tool-call-card__code">
                {truncate(toolCall.result, 500)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '\n\u2026 (truncated)'
}
