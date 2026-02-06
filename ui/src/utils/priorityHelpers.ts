// Priority helpers - format priority scores and categories

import type { PriorityCategory, PriorityMetadata } from '../types/tasks'

/**
 * Get priority color CSS variable name
 */
export function getPriorityColor(category: PriorityCategory): string {
  const colors: Record<PriorityCategory, string> = {
    critical: 'var(--color-critical)',
    high: 'var(--color-high)',
    medium: 'var(--color-medium)',
    low: 'var(--color-low)',
  }
  return colors[category]
}

/**
 * Get priority icon/emoji
 */
export function getPriorityIcon(category: PriorityCategory): string {
  const icons: Record<PriorityCategory, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
  }
  return icons[category]
}

/**
 * Format priority score with context
 */
export function formatPriorityScore(score: number): string {
  return `${score}/300`
}

/**
 * Get human-readable priority label
 */
export function getPriorityLabel(category: PriorityCategory): string {
  const labels: Record<PriorityCategory, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  }
  return labels[category]
}

/**
 * Sort tasks by priority score (descending)
 */
export function sortByPriority<T extends { priorityMetadata: PriorityMetadata }>(
  tasks: T[]
): T[] {
  return [...tasks].sort((a, b) => b.priorityMetadata.score - a.priorityMetadata.score)
}

/**
 * Group tasks by priority category
 */
export function groupByPriority<T extends { priorityMetadata: PriorityMetadata }>(
  tasks: T[]
): Record<PriorityCategory, T[]> {
  const groups: Record<PriorityCategory, T[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  }

  tasks.forEach((task) => {
    groups[task.priorityMetadata.category].push(task)
  })

  return groups
}
