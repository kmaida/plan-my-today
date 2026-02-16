import { useState, useRef, useMemo, useCallback, type ReactNode } from 'react'
import type { FilterState, TaskSource, PriorityCategory } from '../types/tasks'
import { DEFAULT_FILTERS } from '../types/tasks'
import { SourceIcon, getSourceLabel } from './SourceIcon'
import { Chevron } from './Chevron'
import './FilterBar.css'

interface FilterBarProps {
  filters: FilterState
  onFiltersChange: (filters: FilterState) => void
  totalCount: number
  filteredCount: number
  viewSwitcher?: ReactNode
}

const SOURCES: TaskSource[] = [
  'linear', 'github', 'gmail', 'slack', 'calendar', 'drive', 'meeting-notes',
]

const PRIORITIES: PriorityCategory[] = ['critical', 'high', 'medium', 'low']

const TIME_OPTIONS: Array<{ value: FilterState['timeFilter']; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'later', label: 'Later' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'no-due', label: 'No Date' },
]

export function FilterBar({ filters, onFiltersChange, totalCount, filteredCount, viewSwitcher }: FilterBarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const activeFilterCount = useMemo(
    () =>
      (filters.search ? 1 : 0) +
      filters.sources.length +
      filters.priorities.length +
      (filters.timeFilter !== 'all' ? 1 : 0),
    [filters],
  )

  const hasActiveFilters = activeFilterCount > 0

  const toggleSource = useCallback((source: TaskSource) => {
    const current = filters.sources
    const next = current.includes(source)
      ? current.filter(s => s !== source)
      : [...current, source]
    onFiltersChange({ ...filters, sources: next })
  }, [filters, onFiltersChange])

  const togglePriority = useCallback((priority: PriorityCategory) => {
    const current = filters.priorities
    const next = current.includes(priority)
      ? current.filter(p => p !== priority)
      : [...current, priority]
    onFiltersChange({ ...filters, priorities: next })
  }, [filters, onFiltersChange])

  const setTimeFilter = useCallback((time: FilterState['timeFilter']) => {
    onFiltersChange({ ...filters, timeFilter: time })
  }, [filters, onFiltersChange])

  const setSearch = useCallback((search: string) => {
    onFiltersChange({ ...filters, search })
  }, [filters, onFiltersChange])

  const clearAll = useCallback(() => {
    onFiltersChange(DEFAULT_FILTERS)
    if (searchRef.current) searchRef.current.value = ''
  }, [onFiltersChange])

  return (
    <div className="filter-bar">
      <div className="filter-bar__header">
        {viewSwitcher}
        <button
          className="filter-bar__toggle"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
        >
          <Chevron direction={isOpen ? 'down' : 'right'} size={12} className="filter-bar__toggle-icon" />
          <span>Search & Filter</span>
          {hasActiveFilters && (
            <span className="filter-bar__badge">{activeFilterCount}</span>
          )}
          {hasActiveFilters && (
            <span className="filter-bar__active-summary">
              {filteredCount} of {totalCount}
            </span>
          )}
        </button>
      </div>

      <div className={`filter-bar__collapse${isOpen ? ' filter-bar__collapse--open' : ''}`}>
        <div className="filter-bar__panel">
          <div className="filter-bar__search">
            <input
              ref={searchRef}
              type="search"
              placeholder="Search tasks..."
              value={filters.search}
              onChange={(e) => setSearch(e.target.value)}
              className="filter-bar__search-input"
            />
          </div>

          <div className="filter-bar__row">
            <span className="filter-bar__label">Source</span>
            <div className="filter-bar__chips">
              {SOURCES.map(source => (
                <button
                  key={source}
                  className={`filter-bar__chip${filters.sources.includes(source) ? ' filter-bar__chip--active' : ''}`}
                  onClick={() => toggleSource(source)}
                >
                  <SourceIcon source={source} size={12} />
                  <span>{getSourceLabel(source)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="filter-bar__row">
            <span className="filter-bar__label">Priority</span>
            <div className="filter-bar__chips">
              {PRIORITIES.map(priority => (
                <button
                  key={priority}
                  className={`filter-bar__chip filter-bar__chip--priority-${priority}${filters.priorities.includes(priority) ? ' filter-bar__chip--active' : ''}`}
                  onClick={() => togglePriority(priority)}
                >
                  {priority.charAt(0).toUpperCase() + priority.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-bar__row">
            <span className="filter-bar__label">When</span>
            <div className="filter-bar__chips">
              {TIME_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`filter-bar__chip${filters.timeFilter === opt.value ? ' filter-bar__chip--active' : ''}`}
                  onClick={() => setTimeFilter(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {hasActiveFilters && (
            <div className="filter-bar__summary">
              <span className="filter-bar__count">
                {filteredCount} of {totalCount} tasks
              </span>
              <button className="filter-bar__clear" onClick={clearAll}>
                Clear filters ({activeFilterCount})
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
