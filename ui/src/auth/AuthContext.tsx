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
import { discoverEndpoints } from './discovery'
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
  token: string | null
  user: AuthUser | null
  error: string | null
  login: () => Promise<void>
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
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)

  // ── Restore or handle callback on mount ────────────────────────────────────

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')

    if (code && state) {
      handleCallback(code, state)
    } else {
      restoreSession()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function restoreSession() {
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
      if (!stored) throw new Error('Missing PKCE state — login may have expired')

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

  const login = useCallback(async () => {
    try {
      setError(null)

      const codeVerifier = generateCodeVerifier()
      const codeChallenge = await generateCodeChallenge(codeVerifier)
      const state = generateState()

      // Store PKCE params for callback validation
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state, code_verifier: codeVerifier }))

      // Discover authorization endpoint
      const { authorization_endpoint } = await discoverEndpoints(AUTH_CONFIG.discoveryBaseUrl)

      // Build authorization URL
      const params = new URLSearchParams({
        client_id: AUTH_CONFIG.clientId,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: AUTH_CONFIG.redirectUri,
        response_type: 'code',
        scope: AUTH_CONFIG.scope,
        state,
        resource: AUTH_CONFIG.resource,
      })

      window.location.href = `${authorization_endpoint}?${params.toString()}`
    } catch (err) {
      console.error('Login failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to start login')
    }
  }, [])

  // ── Logout ─────────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    setAuthToken(null)
    sessionStorage.removeItem(STORAGE_KEY)
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token,
        isLoading,
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
