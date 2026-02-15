import '../styles/hint-tooltip.css'
import './AuthHint.css'

const TOOLTIP_TEXT =
  "You may be asked to select your Google account several times, once for each service (Calendar, Gmail, Drive, etc.)."

export function AuthHint() {
  return (
    <span className="hint-tooltip auth-hint">
      <svg className="hint-tooltip__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="500">?</text>
      </svg>
      <span className="hint-tooltip__tooltip">{TOOLTIP_TEXT}</span>
    </span>
  )
}
