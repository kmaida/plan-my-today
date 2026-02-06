// Task grouping - organize tasks into groups for each view mode

import type { Task, ViewMode, TaskSource } from '../types/tasks'
import type { TaskGroup as TaskGroupType } from '../types/tasks'
import { isLinearTask, isCalendarTask } from '../types/tasks'
import { groupByPriority, sortByPriority } from './priorityHelpers'
import { getTaskTimestamp, getTaskTitle, normalizeSource } from './taskHelpers'
import { isToday, isThisWeek } from './dateHelpers'
import { getSourceLabel } from '../components/SourceIcon'

// --- Priority View (existing behavior, formalized) ---

function groupByPriorityView(tasks: Task[]): TaskGroupType[] {
  const grouped = groupByPriority(tasks)
  const categories: Array<{ key: keyof typeof grouped; label: string }> = [
    { key: 'critical', label: 'Critical' },
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
  ]
  return categories
    .filter(c => grouped[c.key].length > 0)
    .map(c => ({
      label: c.label,
      count: grouped[c.key].length,
      tasks: sortByPriority(grouped[c.key]),
    }))
}

// --- Source View ---

const SOURCE_ORDER: TaskSource[] = [
  'linear', 'github', 'gmail', 'slack', 'calendar', 'docs', 'meeting-notes',
]

function groupBySourceView(tasks: Task[]): TaskGroupType[] {
  const buckets = new Map<TaskSource, Task[]>()
  for (const task of tasks) {
    const key = normalizeSource(task.source)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(task)
  }
  return SOURCE_ORDER
    .filter(s => buckets.has(s))
    .map(s => ({
      label: getSourceLabel(s),
      count: buckets.get(s)!.length,
      tasks: sortByPriority(buckets.get(s)!),
    }))
}

// --- Timeline View ---

type TimeBucket = 'Overdue' | 'Now' | 'Next Hour' | 'Today' | 'This Week' | 'Later' | 'No Date'

function getTimeBucket(task: Task): TimeBucket {
  const ts = getTaskTimestamp(task)
  if (!ts) return 'No Date'

  const date = new Date(ts)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()

  // Calendar events that are currently happening
  if (isCalendarTask(task) && diffMs <= 0 && new Date(task.end).getTime() > now.getTime()) {
    return 'Now'
  }

  if (diffMs < 0) return 'Overdue'
  if (diffMs <= 60 * 60 * 1000) return 'Next Hour'
  if (isToday(ts)) return 'Today'
  if (isThisWeek(ts)) return 'This Week'
  return 'Later'
}

const TIMELINE_ORDER: TimeBucket[] = [
  'Overdue', 'Now', 'Next Hour', 'Today', 'This Week', 'Later', 'No Date',
]

function groupByTimelineView(tasks: Task[]): TaskGroupType[] {
  const buckets = new Map<TimeBucket, Task[]>()
  for (const task of tasks) {
    const bucket = getTimeBucket(task)
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket)!.push(task)
  }
  return TIMELINE_ORDER
    .filter(b => buckets.has(b))
    .map(b => ({
      label: b,
      count: buckets.get(b)!.length,
      tasks: sortByPriority(buckets.get(b)!),
    }))
}

// --- Related View ---

function groupByRelatedView(tasks: Task[]): TaskGroupType[] {
  const used = new Set<number>()
  const groups: TaskGroupType[] = []

  // Pass 1: cluster by cross-reference overlap
  for (let i = 0; i < tasks.length; i++) {
    if (used.has(i)) continue
    const task = tasks[i]
    const refs = 'crossReferences' in task ? task.crossReferences : undefined
    if (!refs?.relatedItems?.length && !refs?.mentionedIn?.length) continue

    const cluster: number[] = [i]
    const refIds = new Set(refs.relatedItems?.map(r => r.id) || [])

    for (let j = i + 1; j < tasks.length; j++) {
      if (used.has(j)) continue
      const other = tasks[j]
      const otherRefs = 'crossReferences' in other ? other.crossReferences : undefined
      if (!otherRefs) continue

      const otherIds = otherRefs.relatedItems?.map(r => r.id) || []
      if (otherIds.some(id => refIds.has(id))) {
        cluster.push(j)
      }
    }

    if (cluster.length > 1) {
      const clusterTasks = sortByPriority(cluster.map(idx => tasks[idx]))
      const primaryTitle = getTaskTitle(clusterTasks[0])
      const label = primaryTitle.length > 50
        ? primaryTitle.slice(0, 47) + '...'
        : primaryTitle
      groups.push({
        label: `Related: ${label}`,
        count: clusterTasks.length,
        tasks: clusterTasks,
      })
      cluster.forEach(idx => used.add(idx))
    }
  }

  // Pass 2: cluster by Linear dependencies (blockedBy / blocks)
  for (let i = 0; i < tasks.length; i++) {
    if (used.has(i)) continue
    const task = tasks[i]
    if (!isLinearTask(task) || !task.dependencies) continue
    const depIds = new Set([
      ...(task.dependencies.blockedBy || []),
      ...(task.dependencies.blocks || []),
    ])
    if (depIds.size === 0) continue

    const cluster: number[] = [i]
    for (let j = 0; j < tasks.length; j++) {
      if (i === j || used.has(j)) continue
      const other = tasks[j]
      if (isLinearTask(other) && depIds.has(other.identifier)) {
        cluster.push(j)
      }
    }

    if (cluster.length > 1) {
      const clusterTasks = sortByPriority(cluster.map(idx => tasks[idx]))
      const primary = clusterTasks[0]
      const id = isLinearTask(primary) ? primary.identifier : getTaskTitle(primary)
      groups.push({
        label: `Dependency chain: ${id}`,
        count: clusterTasks.length,
        tasks: clusterTasks,
      })
      cluster.forEach(idx => used.add(idx))
    }
  }

  // Pass 3: remaining unclustered tasks
  const standalone = tasks.filter((_, i) => !used.has(i))
  if (standalone.length > 0) {
    groups.push({
      label: 'Standalone Tasks',
      count: standalone.length,
      tasks: sortByPriority(standalone),
    })
  }

  return groups
}

// --- Public entry point ---

export function groupTasks(tasks: Task[], viewMode: ViewMode): TaskGroupType[] {
  switch (viewMode) {
    case 'priority': return groupByPriorityView(tasks)
    case 'source': return groupBySourceView(tasks)
    case 'timeline': return groupByTimelineView(tasks)
    case 'related': return groupByRelatedView(tasks)
  }
}
