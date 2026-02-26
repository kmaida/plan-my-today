import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce'
import { discoverEndpoints, prefetchEndpoints } from './discovery'
import { AUTH_CONFIG } from './config'
import { setAuthToken } from '../api/client'

// ── Types ──────────────────────────────────────────────────────────────────────

interface AuthUser {
  sub: string
  name?: string
  email?: string
}

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  isLoggingIn: boolean
  token: string | null
  user: AuthUser | null
  error: string | null
  login: (opts?: { reauth?: boolean }) => Promise<void>
  logout: () => void
}

const STORAGE_KEY = 'pkce_token'
const PKCE_KEY = 'pkce_auth'

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Decode a JWT payload without verification (safe for extracting claims client-side). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Check whether a JWT is expired (with 60s buffer). */
function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload.exp !== 'number') return true
  return Date.now() / 1000 > payload.exp - 60
}

/** Extract basic user info from a JWT. */
function extractUser(token: string): AuthUser | null {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload.sub !== 'string') return null
  return {
    sub: payload.sub,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  }
}

// ── Context ────────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

// ── Provider ───────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)

  // ── Auth failure tracking ───────────────────────────────────────────────────

  /** Increment consecutive failure counter; arms force_fresh_login after 2+ failures. */
  function recordAuthFailure() {
    const stored = parseInt(sessionStorage.getItem('auth_fail_count') ?? '0', 10)
    const count = (isNaN(stored) ? 0 : stored) + 1
    sessionStorage.setItem('auth_fail_count', String(count))
    if (count >= 2) {
      sessionStorage.setItem('force_fresh_login', '1')
    }
  }

  /** Reset failure counter and fresh-login flag after a successful login. */
  function clearAuthFailures() {
    sessionStorage.removeItem('auth_fail_count')
    sessionStorage.removeItem('force_fresh_login')
  }

  // ── Restore or handle callback on mount ────────────────────────────────────

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    // Eagerly discover OAuth endpoints so they're cached before the user
    // clicks "Connect". The two-step .well-known fetch is the main bottleneck.
    prefetchEndpoints(AUTH_CONFIG.discoveryBaseUrl)

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error')
    const errorDescription = params.get('error_description')

    if (code && state) {
      handleCallback(code, state)
    } else if (error) {
      recordAuthFailure()
      sessionStorage.removeItem(PKCE_KEY)
      window.history.replaceState({}, '', '/')
      setError(errorDescription ?? error)
      setIsLoading(false)
    } else {
      restoreSession()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function restoreSession() {
    // If a login was started but never completed (user got stuck at Keycard and
    // navigated back manually), record as a failure and flag for potential escalation.
    if (sessionStorage.getItem(PKCE_KEY)) {
      sessionStorage.removeItem(PKCE_KEY)
      recordAuthFailure()
    }

    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (saved && !isTokenExpired(saved)) {
        setToken(saved)
        setUser(extractUser(saved))
        setAuthToken(saved)
      }
    } catch {
      // sessionStorage unavailable — start fresh
    }
    setIsLoading(false)
  }

  async function handleCallback(code: string, state: string) {
    try {
      // Validate state
      const stored = sessionStorage.getItem(PKCE_KEY)
      if (!stored) {
        recordAuthFailure()
        throw new Error('Your login session expired. Click "Connect" to log in again.')
      }

      const pkce = JSON.parse(stored) as { state: string; code_verifier: string }
      if (pkce.state !== state) throw new Error('State mismatch — possible CSRF attack')

      // Exchange code for token via backend proxy (adds client_secret server-side)
      const res = await fetch('/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: pkce.code_verifier,
          redirect_uri: AUTH_CONFIG.redirectUri,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Token exchange failed (${res.status}): ${errText}`)
      }

      const data = await res.json()
      const accessToken: string = data.access_token
      if (!accessToken) throw new Error('No access_token in token response')

      // Persist and apply
      setToken(accessToken)
      setUser(extractUser(accessToken))
      setAuthToken(accessToken)
      sessionStorage.setItem(STORAGE_KEY, accessToken)
      sessionStorage.removeItem(PKCE_KEY)
      clearAuthFailures()

      // Clean URL
      window.history.replaceState({}, '', '/')
    } catch (err) {
      console.error('Auth callback failed:', err)
      setError(err instanceof Error ? err.message : 'Authentication failed')
      sessionStorage.removeItem(PKCE_KEY)
      window.history.replaceState({}, '', '/')
    } finally {
      setIsLoading(false)
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  const login = useCallback(async (opts?: { reauth?: boolean }) => {
    try {
      setError(null)
      setIsLoggingIn(true)

      const codeVerifier = generateCodeVerifier()
      const codeChallenge = await generateCodeChallenge(codeVerifier)
      const state = generateState()

      // Store PKCE params for callback validation
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state, code_verifier: codeVerifier }))

      // On reauth, signal the dashboard to auto-refresh once MCP reconnects.
      // Initial login skips this — the dashboard starts empty by design.
      if (opts?.reauth) {
        sessionStorage.setItem('pending_refresh', '1')
      }

      // Discover authorization endpoint (usually cached from prefetch)
      const { authorization_endpoint } = await discoverEndpoints(AUTH_CONFIG.discoveryBaseUrl)

      // Build authorization URL
      const forceFreshLogin = sessionStorage.getItem('force_fresh_login') === '1'
      if (forceFreshLogin) {
        sessionStorage.removeItem('force_fresh_login')
      }

      const authParams = new URLSearchParams({
        client_id: AUTH_CONFIG.clientId,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: AUTH_CONFIG.redirectUri,
        response_type: 'code',
        scope: AUTH_CONFIG.scope,
        state,
        resource: AUTH_CONFIG.resource,
      })
      if (forceFreshLogin) {
        authParams.set('prompt', 'login')
      }

      window.location.href = `${authorization_endpoint}?${authParams.toString()}`
    } catch (err) {
      console.error('Login failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to start login')
      setIsLoggingIn(false)
    }
  }, [])

  // ── Logout ─────────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    setAuthToken(null)
    sessionStorage.clear()
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token,
        isLoading,
        isLoggingIn,
        token,
        user,
        error,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
