import { useState } from 'react'
import { Chevron } from '../Chevron'
import type { StructuredToolError } from '../../chat/types'

interface ErrorDetailProps {
  error: StructuredToolError
  /** Optional class hook so callers can tweak spacing in different contexts. */
  className?: string
}

/**
 * Expandable error renderer used by the chat banner and tool-call cards.
 * Header: category badge + source + short message.
 * Expanded: technical fields + "Copy details" for pasting into bug reports.
 */
export function ErrorDetail({ error, className }: ErrorDetailProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(JSON.stringify(error, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API not available — silently no-op.
    }
  }

  return (
    <div className={`error-detail ${className ?? ''}`}>
      <button
        className="error-detail__header"
        onClick={() => setExpanded(!expanded)}
        type="button"
        aria-expanded={expanded}
      >
        <Chevron direction={expanded ? 'down' : 'right'} size={10} />
        <span className={`error-detail__badge error-detail__badge--${error.category}`}>
          {error.category.replace('_', ' ')}
        </span>
        <span className="error-detail__source">{error.source}</span>
        <span className="error-detail__separator">·</span>
        <span className="error-detail__message">{error.message}</span>
      </button>

      {expanded && (
        <div className="error-detail__body">
          <dl className="error-detail__fields">
            {error.status !== undefined && (
              <>
                <dt>Status</dt>
                <dd>{error.status}</dd>
              </>
            )}
            {error.description && (
              <>
                <dt>Description</dt>
                <dd>{error.description}</dd>
              </>
            )}
            {error.resource && (
              <>
                <dt>Resource</dt>
                <dd className="error-detail__mono">{error.resource}</dd>
              </>
            )}
            {error.scopes && error.scopes.length > 0 && (
              <>
                <dt>Scopes</dt>
                <dd className="error-detail__mono">{error.scopes.join('\n')}</dd>
              </>
            )}
            {error.hint && (
              <>
                <dt>Hint</dt>
                <dd>{error.hint}</dd>
              </>
            )}
            <dt>Timestamp</dt>
            <dd className="error-detail__mono">{error.timestamp}</dd>
          </dl>
          <button
            className="error-detail__copy"
            onClick={copy}
            type="button"
          >
            {copied ? 'Copied!' : 'Copy details'}
          </button>
        </div>
      )}
    </div>
  )
}
