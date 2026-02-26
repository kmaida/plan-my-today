# JWKS Caching Workaround

**Status:** Active workaround — in place until `@keycardai/oauth` adds native JWKS caching.
**Introduced:** 2026-02-25
**Tracked by:** canary test at `tests/canary-jwks-caching.test.ts`

---

## The Problem

Every JWT verification in the MCP server calls `JWKSOAuthKeyring.key(issuer, kid)`. The
`@keycardai/oauth` SDK's implementation makes **two uncached network requests on every call**:

1. `GET https://<issuer>/.well-known/oauth-authorization-server` → resolves `jwks_uri`
2. `GET <jwks_uri>` → fetches the key set, imports the matching key as a `CryptoKey`

There is no caching at either level. Every incoming request that requires auth verification
triggers two round-trips to Keycard.

### Why this caused production auth failures

Keycard rotates signing keys. Each new `kid` value in an incoming JWT is a cache miss — which,
with the stock SDK, means a fresh discovery request. Under normal operation this is merely
inefficient (2 fetches per request). Under degraded conditions it becomes a hard failure:

- A transient non-200 from the Keycard discovery endpoint breaks auth for all incoming requests
  until the next retry — no backoff, no circuit breaking, no fallback.
- The error surfaced as:
  ```
  Error: JWKS fetch failed for issuer "https://<tenant>.keycard.cloud" (kid: "..."):
    Failed to fetch OAuth authorization server metadata for "https://<tenant>.keycard.cloud"
  ```

### Error seen in production

```
JWKS fetch failed for issuer "https://chzabf1qgzjia0wfd17eietx70.keycard.cloud"
  (kid: "019bc861-8925-744d-bbf2-8a76bd593f8b"):
  Failed to fetch OAuth authorization server metadata for
  "https://chzabf1qgzjia0wfd17eietx70.keycard.cloud".
```

This caused the MCP server to reject all authenticated requests until the issue self-resolved.

---

## The Workaround

`src/services/caching-jwks-keyring.ts` — `CachingJWKSOAuthKeyring`

Replaces `JWKSOAuthKeyring` with a direct two-step fetch implementation that caches both
network layers:

| Cache | Key | TTL | Notes |
|---|---|---|---|
| `discoveryCache` | `issuer` | 1 hour | `jwks_uri` from `/.well-known/oauth-authorization-server` |
| `keyCache` | `issuer::kid` | 5 minutes | Imported `CryptoKey` |

**Net result:** Discovery runs at most once per server restart per issuer. New `kid` values
(key rotation) cost one JWKS fetch only — discovery is already cached. Subsequent requests
for a known `kid` cost zero fetches.

### Architecture

```
key(issuer, kid)
│
├─ keyCache hit?  → return CryptoKey immediately (0 fetches)
│
└─ cache miss / expired
   │
   ├─ resolveJwksUri(issuer)
   │   ├─ discoveryCache hit? → return jwksUri (0 fetches)
   │   └─ GET /.well-known/oauth-authorization-server  (1 fetch)
   │       ├─ validate: response issuer matches requested issuer (RFC 8414 §3)
   │       ├─ validate: jwks_uri present
   │       ├─ SSRF guard: jwks_uri must be same-origin as issuer
   │       └─ cache jwksUri for 1 hour
   │
   └─ fetchKey(issuer, kid, jwksUri)
       ├─ GET <jwksUri>  (1 fetch)
       ├─ validate: non-empty keys array
       ├─ find matching kid
       ├─ validate: kty === "RSA" (only RSA/RS256 supported)
       └─ crypto.subtle.importKey → CryptoKey
       └─ cache CryptoKey for 5 minutes
```

### Security properties

**SSRF guard:** The `jwks_uri` returned by discovery is validated before use. Its origin must
match the issuer's origin. This prevents a misconfigured or malicious discovery endpoint from
redirecting JWKS fetches to an internal network address. `new URL(jwksUri)` also rejects
malformed URIs (relative paths, `javascript:` schemes, etc.) for free.

```typescript
// In resolveJwksUri():
let jwksOrigin: string;
try {
  jwksOrigin = new URL(jwksUri).origin;
} catch {
  throw new Error(`jwks_uri "${jwksUri}" in discovery metadata for "${issuer}" is not a valid URL`);
}
if (jwksOrigin !== url.origin) {
  throw new Error(
    `jwks_uri origin "${jwksOrigin}" does not match issuer origin "${url.origin}" for "${issuer}" — refusing to fetch`
  );
}
```

**RFC 8414 §3 issuer binding:** If the discovery response includes an `issuer` field, it must
match the issuer we requested. Prevents mix-up attacks where a discovery endpoint returns
metadata for a different issuer.

**Fetch timeouts:** Both discovery and JWKS fetches use `AbortSignal.timeout(10_000)` (10s).
This bounds the worst-case auth latency on network degradation.

**RSA-only:** `kty !== "RSA"` throws immediately with a clear error. Keycard uses RS256;
this is a forward-incompatibility guard, not a restriction.

### Known limitation: TOCTOU on concurrent cache misses

Two concurrent requests for the same `(issuer, kid)` that both arrive during a cache-miss
window will both fire fetch independently. Last write wins — the final cached value is correct
— but N redundant requests fire. This is benign for a low-traffic internal tool and is
documented with a skipped test.

### Key rotation handling

Call `keyring.invalidate(issuer, kid)` from a higher layer when a previously-cached key
fails signature verification (indicating the key was rotated before the 5-minute TTL expired).
The next `key()` call will re-fetch JWKS. Discovery is unaffected — `jwks_uri` is stable
across Keycard key rotations.

---

## How It's Wired

`src/server.ts`:

```typescript
import { JWTOAuthTokenVerifier } from "@keycardai/mcp/server/auth/verifiers/jwt";
import { CachingJWKSOAuthKeyring } from "./services/caching-jwks-keyring";

const keyring    = new CachingJWKSOAuthKeyring();
const authVerifier = new JWTOAuthTokenVerifier(keyring);
const authMiddleware = requireBearerAuth({ verifier: authVerifier, requiredScopes: [] });
```

The `JWTOAuthTokenVerifier` from `@keycardai/mcp` accepts any `OAuthKeyring` implementation.
`CachingJWKSOAuthKeyring` implements that interface.

---

## The Canary Test

`tests/canary-jwks-caching.test.ts` uses `test.failing()` to encode the removal signal.

**Right now:** The test verifies that `JWKSOAuthKeyring` makes 4 fetches for two consecutive
`key()` calls with the same `(issuer, kid)` — confirming the SDK is uncached. Because that is
the expected behavior, `test.failing()` reports the suite as passing.

**After the SDK fix:** If `@keycardai/oauth` adds native caching, the SDK will make only 2
fetches. The test's assertion (`expect(fetch).toHaveBeenCalledTimes(2)`) will pass — but
`test.failing()` expects failure. Jest reports:

```
✗  Expected test to fail, but it passed.
```

This is the removal signal. It cannot be silently ignored.

---

## Upstream: What `@keycardai/oauth` Needs to Fix

The `JWKSOAuthKeyring` class needs a two-level cache equivalent to what this workaround
implements:

1. **Discovery cache** (`issuer → jwks_uri`, configurable TTL, default 1h)
   The critical fix. This is what causes repeated network traffic and failure cascades.

2. **Key cache** (`issuer::kid → CryptoKey`, configurable TTL, default 5min)
   Avoids re-importing the same key on every request.

The SDK should also expose an `invalidate(issuer, kid)` method for key-rotation handling,
and apply `AbortSignal.timeout` to its fetches (or accept one as a config option).

---

## Removal Checklist

When `@keycardai/oauth` adds native caching and the canary test fails with "Expected test to
fail, but it passed":

- [ ] Delete `src/services/caching-jwks-keyring.ts`
- [ ] Delete `src/services/__tests__/caching-jwks-keyring.test.ts`
- [ ] Delete `tests/canary-jwks-caching.test.ts`
- [ ] Revert `src/server.ts`:
  - Remove `import { JWTOAuthTokenVerifier } from "@keycardai/mcp/server/auth/verifiers/jwt"`
  - Remove `import { CachingJWKSOAuthKeyring } from "./services/caching-jwks-keyring"`
  - Remove `const keyring = new CachingJWKSOAuthKeyring()`
  - Remove `const authVerifier = new JWTOAuthTokenVerifier(keyring)`
  - Restore: `const authMiddleware = requireBearerAuth({ requiredScopes: [] })`
- [ ] Verify `npm test` passes (728+ tests, 0 failures)
- [ ] Verify `npm run build:check` passes

---

## Files

| File | Purpose |
|---|---|
| `src/services/caching-jwks-keyring.ts` | The workaround implementation |
| `src/services/__tests__/caching-jwks-keyring.test.ts` | Unit tests (21 passing, 1 skipped TOCTOU) |
| `tests/canary-jwks-caching.test.ts` | SDK caching canary — removal signal |
| `src/server.ts` | Wiring — `JWTOAuthTokenVerifier(keyring)` |
