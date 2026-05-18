import { useState } from 'react'
import type { ToolCall } from '../../chat/types'
import { ErrorDetail } from './ErrorDetail'

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
          {toolCall.errorDetails && toolCall.errorDetails.length > 0 && (
            <div className="tool-call-card__section">
              <span className="tool-call-card__label">
                {toolCall.errorDetails.length > 1
                  ? `Errors (${toolCall.errorDetails.length})`
                  : 'Error'}
              </span>
              {toolCall.errorDetails.map((err, i) => (
                <ErrorDetail key={`${err.source}-${err.timestamp}-${i}`} error={err} />
              ))}
            </div>
          )}
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
                {formatResult(toolCall.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatResult(str: string): string {
  // Try to parse as JSON and pretty-print
  try {
    const parsed = JSON.parse(str)
    const formatted = JSON.stringify(parsed, null, 2)
    return truncate(formatted, 2000)
  } catch {
    return truncate(str, 500)
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '\n\u2026 (truncated)'
}
