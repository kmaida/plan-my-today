import { useEffect, useRef, useCallback } from 'react'
import './Toast.css'

interface ToastProps {
  message: string
  actionLabel?: string
  onAction?: () => void
  onDismiss: () => void
  duration?: number
}

/**
 * Temporary notification bar fixed to the bottom of the viewport.
 * Auto-dismisses after `duration` ms (default 5000). Optionally shows
 * an action button (e.g. "Undo") that calls `onAction` then dismisses.
 */
export function Toast({ message, actionLabel, onAction, onDismiss, duration = 5000 }: ToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const dismiss = useCallback(() => {
    onDismiss()
  }, [onDismiss])

  useEffect(() => {
    timerRef.current = setTimeout(dismiss, duration)
    return () => clearTimeout(timerRef.current)
  }, [dismiss, duration])

  const handleAction = () => {
    clearTimeout(timerRef.current)
    onAction?.()
    dismiss()
  }

  return (
    <div className="toast" role="status" aria-live="polite" aria-atomic="true">
      <span className="toast__message">{message}</span>
      {actionLabel && onAction && (
        <button className="toast__action" onClick={handleAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}
