import type { ReactNode } from 'react'
import { useAuth } from './AuthContext'
import './AuthGate.css'

export function AuthGate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, login, error } = useAuth()

  if (isLoading) {
    return (
      <div className="auth-gate">
        <div className="auth-gate__card">
          <p className="auth-gate__loading">Checking authentication...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="auth-gate">
        <div className="auth-gate__card">
          <h1 className="auth-gate__title app-brand">PLAN MY <span className="app-brand__to">TO</span>DAY</h1>
          <p className="auth-gate__subtitle">Sign in to view your tasks</p>

          {error && <p className="auth-gate__error">{error}</p>}

          <button className="auth-gate__button btn--inverted" onClick={login}>
            Sign in with Keycard
          </button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
