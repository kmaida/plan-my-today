import type { PriorityCategory } from '../types/tasks'
import { getPriorityColor, getPriorityIcon, getPriorityLabel, formatPriorityScore } from '../utils/priorityHelpers'
import './PriorityBadge.css'

interface PriorityBadgeProps {
  category: PriorityCategory
  score?: number
  reasons?: string
  showLabel?: boolean
}

export function PriorityBadge({ category, score, reasons, showLabel = true }: PriorityBadgeProps) {
  const color = getPriorityColor(category)
  const icon = getPriorityIcon(category)
  const label = getPriorityLabel(category)

  const tooltip = reasons
    ? `${label} Priority (${score ? formatPriorityScore(score) : ''})\n${reasons}`
    : `${label} Priority${score ? ` (${formatPriorityScore(score)})` : ''}`

  const className = showLabel
    ? `priority-badge priority-badge--${category}`
    : `priority-badge priority-badge--${category} priority-badge--icon-only`

  return (
    <span
      className={className}
      style={showLabel ? { borderColor: color } : undefined}
      title={tooltip}
    >
      <span className="priority-badge__icon">{icon}</span>
      {showLabel && <span className="priority-badge__label">{label}</span>}
    </span>
  )
}
