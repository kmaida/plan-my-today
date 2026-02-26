import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { AuthProvider, useAuth } from "./AuthContext"

vi.mock("./discovery", () => ({
  discoverEndpoints: vi.fn().mockResolvedValue({
    authorization_endpoint: "https://keycard.example.com/oauth/2/authorize",
    token_endpoint: "https://keycard.example.com/oauth/2/token",
  }),
  prefetchEndpoints: vi.fn(),
}))

vi.mock("../api/client", () => ({
  setAuthToken: vi.fn(),
}))

vi.mock("./pkce", () => ({
  generateCodeVerifier: vi.fn(() => "mock-verifier"),
  generateCodeChallenge: vi.fn(async () => "mock-challenge"),
  generateState: vi.fn(() => "mock-state"),
}))

/** Build a minimal signed-looking JWT with the given payload. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const body = btoa(JSON.stringify({ sub: "user-123", ...payload }))
  return `${header}.${body}.fakesig`
}

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

describe("AuthContext", () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.history.replaceState({}, "", "/")
    vi.clearAllMocks()
  })

  afterEach(() => {
    sessionStorage.clear()
    window.history.replaceState({}, "", "/")
    vi.unstubAllGlobals()
  })

  // ── Session restore ─────────────────────────────────────────────────────────

  describe("session restore", () => {
    it("restores a valid non-expired token", async () => {
      const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 120 })
      sessionStorage.setItem("pkce_token", token)

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.isAuthenticated).toBe(true)
    })

    it("ignores a token expiring within the 60s buffer", async () => {
      // 30s from now → within the 60s buffer → treated as expired
      const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 })
      sessionStorage.setItem("pkce_token", token)

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.isAuthenticated).toBe(false)
    })

    it("ignores a past-expired token", async () => {
      const token = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
      sessionStorage.setItem("pkce_token", token)

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.isAuthenticated).toBe(false)
    })

    it("records a failure when a stale PKCE key from an abandoned login is found", async () => {
      sessionStorage.setItem("pkce_auth", JSON.stringify({ state: "xyz", code_verifier: "abc" }))

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(sessionStorage.getItem("pkce_auth")).toBeNull()
      expect(sessionStorage.getItem("auth_fail_count")).toBe("1")
      expect(sessionStorage.getItem("force_fresh_login")).toBeNull() // not yet at threshold
    })
  })

  // ── OAuth error callback ─────────────────────────────────────────────────────

  describe("?error=... callback", () => {
    it("shows error_description and increments failure count", async () => {
      window.history.replaceState({}, "", "/?error=access_denied&error_description=Access+denied")

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.error).toBe("Access denied")
      expect(result.current.isAuthenticated).toBe(false)
      expect(sessionStorage.getItem("auth_fail_count")).toBe("1")
      expect(sessionStorage.getItem("force_fresh_login")).toBeNull()
    })

    it("falls back to the error code when error_description is absent", async () => {
      window.history.replaceState({}, "", "/?error=server_error")

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.error).toBe("server_error")
    })

    it("clears the PKCE key if present when an error is returned", async () => {
      sessionStorage.setItem("pkce_auth", JSON.stringify({ state: "s", code_verifier: "v" }))
      window.history.replaceState({}, "", "/?error=access_denied")

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(sessionStorage.getItem("pkce_auth")).toBeNull()
    })

    it("arms force_fresh_login after 2 consecutive failures", async () => {
      // Simulate a pre-existing failure from a prior abandoned login
      sessionStorage.setItem("auth_fail_count", "1")
      window.history.replaceState({}, "", "/?error=access_denied")

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(sessionStorage.getItem("auth_fail_count")).toBe("2")
      expect(sessionStorage.getItem("force_fresh_login")).toBe("1")
    })

    it("keeps force_fresh_login armed on further failures beyond the threshold", async () => {
      sessionStorage.setItem("auth_fail_count", "3")
      sessionStorage.setItem("force_fresh_login", "1")
      window.history.replaceState({}, "", "/?error=access_denied")

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(sessionStorage.getItem("auth_fail_count")).toBe("4")
      expect(sessionStorage.getItem("force_fresh_login")).toBe("1")
    })
  })

  // ── handleCallback ───────────────────────────────────────────────────────────

  describe("handleCallback", () => {
    it("records failure and shows friendly error when PKCE key is missing", async () => {
      // No pkce_auth in sessionStorage — simulates browser startup restore
      window.history.replaceState({}, "", "/?code=authcode&state=somestate")

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.error).toMatch(/session expired/i)
      expect(sessionStorage.getItem("auth_fail_count")).toBe("1")
    })

    it("shows state mismatch error on CSRF detection", async () => {
      sessionStorage.setItem(
        "pkce_auth",
        JSON.stringify({ state: "stored-state", code_verifier: "verifier" }),
      )
      window.history.replaceState({}, "", "/?code=authcode&state=tampered-state")

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.error).toMatch(/state mismatch/i)
    })

    it("clears failure counters on successful token exchange", async () => {
      const pkceState = "matching-state"
      const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })

      sessionStorage.setItem(
        "pkce_auth",
        JSON.stringify({ state: pkceState, code_verifier: "verifier" }),
      )
      sessionStorage.setItem("auth_fail_count", "2")
      sessionStorage.setItem("force_fresh_login", "1")
      window.history.replaceState({}, "", `/?code=authcode&state=${pkceState}`)

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ access_token: token }),
        }),
      )

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isAuthenticated).toBe(true))

      expect(sessionStorage.getItem("auth_fail_count")).toBeNull()
      expect(sessionStorage.getItem("force_fresh_login")).toBeNull()
    })

    it("sets an error and keeps the user logged out on token exchange failure", async () => {
      const pkceState = "matching-state"
      sessionStorage.setItem(
        "pkce_auth",
        JSON.stringify({ state: pkceState, code_verifier: "verifier" }),
      )
      window.history.replaceState({}, "", `/?code=authcode&state=${pkceState}`)

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        }),
      )

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      expect(result.current.isAuthenticated).toBe(false)
      expect(result.current.error).toMatch(/token exchange failed/i)
    })
  })
})
