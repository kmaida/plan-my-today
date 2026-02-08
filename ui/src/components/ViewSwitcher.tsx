import type { ViewMode } from '../types/tasks'
import './ViewSwitcher.css'

interface ViewSwitcherProps {
  activeView: ViewMode
  onViewChange: (view: ViewMode) => void
}

const VIEW_OPTIONS: Array<{ mode: ViewMode; label: string }> = [
  { mode: 'priority', label: 'Priority' },
  { mode: 'source', label: 'Source' },
]

export function ViewSwitcher({ activeView, onViewChange }: ViewSwitcherProps) {
  return (
    <nav className="view-switcher" aria-label="Task view">
      {VIEW_OPTIONS.map(({ mode, label }) => (
        <button
          key={mode}
          className={`view-switcher__tab${mode === activeView ? ' view-switcher__tab--active' : ''}`}
          onClick={() => onViewChange(mode)}
          aria-current={mode === activeView ? 'page' : undefined}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
