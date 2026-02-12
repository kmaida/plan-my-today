import type { ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { AuthHint } from './AuthHint'
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
          <img src="/logo.svg" alt="" className="auth-gate__logo" />
          <h1 className="auth-gate__title app-brand">PLAN MY <span className="app-brand__to">TO</span>DAY</h1>
          <p className="auth-gate__subtitle">Your <span className="app-brand__to">Tod</span><strong>a</strong><span className="app-brand__to">y</span><strong>gent</strong> is waiting.</p>

          {error && <p className="auth-gate__error">{error}</p>}

          <button className="auth-gate__button btn--inverted" onClick={() => login()}>
            Connect
          </button>
          <div className="auth-gate__hint">
            <AuthHint />
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
