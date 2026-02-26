import type { webcrypto } from "node:crypto";
import type { OAuthKeyring } from "@keycardai/oauth/keyring";
import { getLogger } from "../observability/logger";

// CryptoKey and JsonWebKey are Web Crypto API types; @types/node exposes them under
// the webcrypto namespace rather than as globals (no DOM lib needed).
type CryptoKey  = webcrypto.CryptoKey;
type JsonWebKey = webcrypto.JsonWebKey;

const KEY_TTL_MS       = 5  * 60 * 1000;  // 5 min — individual key
const DISCOVERY_TTL_MS = 60 * 60 * 1000;  // 1 hour — jwks_uri from discovery
const FETCH_TIMEOUT_MS = 10_000;           // 10 s per request

interface CacheEntry {
  key: CryptoKey;
  expiresAt: number;
}

interface DiscoveryEntry {
  jwksUri: string;
  expiresAt: number;
}

/**
 * In-memory two-level cache for JWKS key verification.
 *
 * The @keycardai/oauth SDK's JWKSOAuthKeyring makes two uncached network
 * requests on every key() call: (1) GET /.well-known/oauth-authorization-server
 * to resolve jwks_uri, and (2) GET <jwks_uri> to fetch the key set. This class
 * replaces that delegation with direct fetching, caching both layers:
 *
 *   discoveryCache: issuer → jwks_uri  (1-hour TTL)
 *   keyCache:       issuer::kid → CryptoKey  (5-minute TTL)
 *
 * On a cache-miss for a new kid, only the JWKS endpoint is re-fetched — not
 * the discovery endpoint. Discovery re-runs at most once per hour per issuer.
 *
 * Fragile cases:
 * - Network failure on cache miss: rethrows with actionable message + Error.cause.
 * - Key rotation (stale key → invalid signature): call invalidate(issuer, kid)
 *   from a higher layer, or wait for the 5-minute TTL.
 * - Concurrent cache-miss calls for the same key: both fire independently (TOCTOU).
 *   Last write wins, which is correct; only the extra network calls are wasted.
 *   Same known issue as before; benign for this low-traffic internal tool.
 *
 * Removal: when @keycardai/oauth adds native caching, delete this file and update
 * server.ts to use JWKSOAuthKeyring directly. The canary test at
 * tests/canary-jwks-caching.test.ts will fail (unexpected pass) to signal this.
 */
export class CachingJWKSOAuthKeyring implements OAuthKeyring {
  private readonly keyCache       = new Map<string, CacheEntry>();
  private readonly discoveryCache = new Map<string, DiscoveryEntry>();
  private readonly ttlMs:          number;
  private readonly discoveryTtlMs: number;

  constructor(ttlMs = KEY_TTL_MS, discoveryTtlMs = DISCOVERY_TTL_MS) {
    this.ttlMs          = ttlMs;
    this.discoveryTtlMs = discoveryTtlMs;
  }

  /**
   * Returns a CryptoKey for the given issuer and kid.
   *
   * On cache miss: resolves jwks_uri via discovery (cached 1h), fetches JWKS,
   * imports and caches the key (5 min). On cache hit: returns immediately.
   */
  async key(issuer: string, kid: string): Promise<CryptoKey> {
    if (!issuer || !kid) {
      throw new Error(
        `Cannot resolve JWKS key: issuer and kid are required ` +
          `(got issuer="${issuer}", kid="${kid}"). ` +
          `The incoming JWT may be missing the "kid" header claim.`
      );
    }

    const logger   = getLogger();
    const cacheKey = `${issuer}::${kid}`;
    const cached   = this.keyCache.get(cacheKey);

    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.key;
      logger.debug("Cached JWKS entry expired, re-fetching from Keycard", { issuer, kid });
    }

    try {
      const jwksUri   = await this.resolveJwksUri(issuer);
      const cryptoKey = await this.fetchKey(issuer, kid, jwksUri);
      this.keyCache.set(cacheKey, { key: cryptoKey, expiresAt: Date.now() + this.ttlMs });
      return cryptoKey;
    } catch (error) {
      throw Object.assign(
        new Error(
          `JWKS fetch failed for issuer "${issuer}" (kid: "${kid}"): ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `Keycard may be temporarily unreachable — auth will recover automatically once it is. ` +
            `If this persists, check Keycard service health.`
        ),
        { cause: error }
      );
    }
  }

  /**
   * Explicitly removes a key cache entry. Call this if upstream signature
   * verification fails on a previously-cached key (indicates key rotation).
   * The next call to key() will re-fetch from JWKS.
   *
   * Note: only clears keyCache. discoveryCache is unaffected because jwks_uri
   * is stable across key rotation — Keycard uses a single stable endpoint.
   */
  invalidate(issuer: string, kid: string): void {
    const cacheKey = `${issuer}::${kid}`;
    if (this.keyCache.delete(cacheKey)) {
      getLogger().warn("Invalidated cached JWKS entry — possible key rotation", { issuer, kid });
    }
  }

  /**
   * Fetches and caches jwks_uri from the issuer's discovery document.
   * Cached for 1 hour — runs at most once per server lifetime per issuer,
   * regardless of how many keys rotate or how many new kid values appear.
   */
  private async resolveJwksUri(issuer: string): Promise<string> {
    const cached = this.discoveryCache.get(issuer);
    if (cached && cached.expiresAt > Date.now()) return cached.jwksUri;

    // URL construction mirrors @keycardai/oauth's discovery.js
    const url     = new URL(issuer);
    const path    = url.pathname.replace(/\/$/, "");
    const metaUrl = `${url.origin}/.well-known/oauth-authorization-server${path}`;

    const res = await fetch(metaUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Discovery failed for "${issuer}" (HTTP ${res.status})`);

    const meta = (await res.json()) as Record<string, unknown>;

    // RFC 8414 §3: validate issuer binding if the field is present
    if (typeof meta.issuer === "string" && meta.issuer !== issuer) {
      throw new Error(`Issuer mismatch in discovery: expected "${issuer}", got "${meta.issuer}"`);
    }

    const jwksUri = meta.jwks_uri;
    if (typeof jwksUri !== "string" || !jwksUri) {
      throw new Error(`No jwks_uri in discovery metadata for "${issuer}"`);
    }

    // SSRF guard: jwks_uri must be same-origin as the issuer.
    // new URL() also rejects malformed URIs (relative paths, javascript: schemes, etc.)
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

    this.discoveryCache.set(issuer, { jwksUri, expiresAt: Date.now() + this.discoveryTtlMs });
    return jwksUri;
  }

  /**
   * Fetches JWKS, finds the key by kid, and imports it as a CryptoKey.
   * Only RSA/RS256 is supported — matches @keycardai/oauth's implementation.
   * Add a branch here if EC or OKP key support is needed.
   */
  private async fetchKey(issuer: string, kid: string, jwksUri: string): Promise<CryptoKey> {
    const res = await fetch(jwksUri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`JWKS endpoint returned HTTP ${res.status} for "${issuer}"`);

    const body = (await res.json()) as { keys?: unknown[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw new Error(`Empty or malformed JWKS response for "${issuer}"`);
    }

    const jwk = (body.keys as Array<Record<string, unknown>>).find((k) => k.kid === kid);
    if (!jwk) throw new Error(`Key "${kid}" not found in JWKS for "${issuer}"`);

    if (jwk.kty !== "RSA") {
      throw new Error(
        `Unsupported key type "${jwk.kty}" for kid "${kid}" (only RSA supported)`
      );
    }

    return crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
      true,
      ["verify"]
    );
  }
}
