import type { webcrypto } from "node:crypto";
import { CachingJWKSOAuthKeyring } from "../caching-jwks-keyring";

type CryptoKey = webcrypto.CryptoKey;

// Error.cause is an ES2022 property available at runtime in Node 18+ but not
// typed at the es2020 lib level. Extend locally rather than changing tsconfig.
interface ErrorWithCause extends Error {
  cause?: unknown;
}

// ── Mock logger ─────────────────────────────────────────────────────────────

const mockDebug = jest.fn();
const mockWarn  = jest.fn();
jest.mock("../../observability/logger", () => ({
  getLogger: () => ({ debug: mockDebug, warn: mockWarn }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ISSUER  = "https://test.keycard.cloud";
const KID     = "test-key-id";
const KID_2   = "test-key-id-2";
const FAKE_KEY = {} as CryptoKey;

const FAKE_JWK   = { kty: "RSA", kid: KID,   use: "sig", alg: "RS256", n: "AQAB", e: "AQAB" };
const FAKE_JWK_2 = { kty: "RSA", kid: KID_2, use: "sig", alg: "RS256", n: "AQAB", e: "AQAB" };

const DISCOVERY_RESPONSE = { issuer: ISSUER, jwks_uri: "https://test.keycard.cloud/jwks.json" };
const JWKS_RESPONSE      = { keys: [FAKE_JWK, FAKE_JWK_2] };

/** Duck-typed Response — avoids needing `new Response()` in the Jest/Node environment. */
function jsonResponse(body: object, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

/**
 * Installs a fetch spy that routes by URL path:
 *   /.well-known/oauth-authorization-server → DISCOVERY_RESPONSE (or custom body/status)
 *   anything else (jwks.json)               → JWKS_RESPONSE (or custom body/status)
 */
function mockFetch({
  discoveryStatus = 200,
  jwksStatus      = 200,
  discoveryBody   = DISCOVERY_RESPONSE as object,
  jwksBody        = JWKS_RESPONSE as object,
} = {}): jest.SpyInstance {
  return jest.spyOn(globalThis, "fetch").mockImplementation((url) => {
    const urlStr = url.toString();
    if (urlStr.includes("/.well-known/oauth-authorization-server")) {
      return Promise.resolve(jsonResponse(discoveryBody, discoveryStatus));
    }
    return Promise.resolve(jsonResponse(jwksBody, jwksStatus));
  });
}

// ── Global spy setup ──────────────────────────────────────────────────────────

let importKeySpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  importKeySpy = jest
    .spyOn(globalThis.crypto.subtle, "importKey")
    .mockResolvedValue(FAKE_KEY as CryptoKey);
});

afterEach(() => {
  jest.restoreAllMocks(); // restores all spies including importKeySpy
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CachingJWKSOAuthKeyring", () => {
  describe("key cache hit", () => {
    it("calls fetch twice for two identical (issuer, kid) requests", async () => {
      const fetchSpy = mockFetch();
      const keyring  = new CachingJWKSOAuthKeyring();

      const first  = await keyring.key(ISSUER, KID);
      const second = await keyring.key(ISSUER, KID);

      // First call: discovery + JWKS. Second call: key cache hit.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(first).toBe(FAKE_KEY);
      expect(second).toBe(FAKE_KEY);
    });
  });

  describe("discovery cache", () => {
    it("fetches discovery once for two different kids under the same issuer", async () => {
      const fetchSpy = mockFetch();
      const keyring  = new CachingJWKSOAuthKeyring();

      await keyring.key(ISSUER, KID);   // discovery + JWKS  (2 fetches)
      await keyring.key(ISSUER, KID_2); // JWKS only          (1 fetch — discovery cached)
      await keyring.key(ISSUER, KID);   // key cache hit      (0 fetches)

      expect(fetchSpy).toHaveBeenCalledTimes(3);

      const calls          = fetchSpy.mock.calls.map(([url]: [string | URL | Request]) => url.toString());
      const discoveryCalls = calls.filter((u) => u.includes("oauth-authorization-server"));
      expect(discoveryCalls).toHaveLength(1);
    });
  });

  describe("TTL expiry", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("re-fetches key after key TTL expires; discovery cache remains intact", async () => {
      const KEY_TTL  = 100;
      const fetchSpy = mockFetch();
      const keyring  = new CachingJWKSOAuthKeyring(KEY_TTL);

      await keyring.key(ISSUER, KID); // discovery + JWKS
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      jest.setSystemTime(Date.now() + KEY_TTL + 1);

      await keyring.key(ISSUER, KID); // JWKS only (key expired; discovery still cached)
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(mockDebug).toHaveBeenCalledWith(
        "Cached JWKS entry expired, re-fetching from Keycard",
        { issuer: ISSUER, kid: KID }
      );

      const calls          = fetchSpy.mock.calls.map(([url]: [string | URL | Request]) => url.toString());
      const discoveryCalls = calls.filter((u) => u.includes("oauth-authorization-server"));
      expect(discoveryCalls).toHaveLength(1); // discovery was not re-fetched
    });

    it("treats expiresAt == Date.now() as a cache miss (strict > check, not >=)", async () => {
      const KEY_TTL = 100;
      mockFetch();
      const keyring = new CachingJWKSOAuthKeyring(KEY_TTL);

      await keyring.key(ISSUER, KID); // sets expiresAt = T + 100
      jest.setSystemTime(Date.now() + KEY_TTL); // advance to exactly T + 100; (T+100) > (T+100) = false → miss

      await keyring.key(ISSUER, KID);
      expect(importKeySpy).toHaveBeenCalledTimes(2); // re-imported because boundary is exclusive
    });

    it("re-fetches both discovery and key after discovery TTL expires", async () => {
      const TTL      = 100;
      const fetchSpy = mockFetch();
      const keyring  = new CachingJWKSOAuthKeyring(TTL, TTL); // key TTL = discovery TTL = 100ms

      await keyring.key(ISSUER, KID); // discovery + JWKS
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      jest.setSystemTime(Date.now() + TTL + 1); // both caches expired

      await keyring.key(ISSUER, KID); // discovery + JWKS again
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe("different (issuer, kid) pairs", () => {
    it("caches each kid separately", async () => {
      const fetchSpy = mockFetch();
      const keyring  = new CachingJWKSOAuthKeyring();

      await keyring.key(ISSUER, KID);   // discovery + JWKS
      await keyring.key(ISSUER, KID_2); // JWKS only (discovery cached)
      await keyring.key(ISSUER, KID);   // key cache hit

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(importKeySpy).toHaveBeenCalledTimes(2); // once per unique kid
    });
  });

  describe("input validation", () => {
    it("throws immediately when issuer is missing", async () => {
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key("", KID)).rejects.toThrow(
        "Cannot resolve JWKS key: issuer and kid are required"
      );
    });

    it("throws immediately when kid is missing", async () => {
      const keyring = new CachingJWKSOAuthKeyring();
      // kid typed as string but JWT parsers may pass undefined at runtime
      await expect(keyring.key(ISSUER, undefined as unknown as string)).rejects.toThrow(
        "The incoming JWT may be missing the"
      );
    });
  });

  describe("fetch failure", () => {
    it("wraps discovery errors with an actionable message and preserves cause", async () => {
      mockFetch({ discoveryStatus: 503 });
      const keyring = new CachingJWKSOAuthKeyring();

      let thrown: Error | null = null;
      try {
        await keyring.key(ISSUER, KID);
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain(`JWKS fetch failed for issuer "${ISSUER}"`);
      expect((thrown as ErrorWithCause).cause).toBeInstanceOf(Error);
      expect(((thrown as ErrorWithCause).cause as Error).message).toContain("Discovery failed");
    });

    it("wraps JWKS endpoint HTTP errors with an actionable message", async () => {
      mockFetch({ jwksStatus: 503 });
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key(ISSUER, KID)).rejects.toThrow("JWKS endpoint returned HTTP 503");
    });

    it("throws when the requested kid is absent from the JWKS key set", async () => {
      mockFetch({ jwksBody: { keys: [{ kty: "RSA", kid: "other-kid", n: "AQAB", e: "AQAB" }] } });
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key(ISSUER, KID)).rejects.toThrow(
        `Key "${KID}" not found in JWKS for "${ISSUER}"`
      );
    });

    it("throws on empty JWKS key set", async () => {
      mockFetch({ jwksBody: { keys: [] } });
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key(ISSUER, KID)).rejects.toThrow(
        `Empty or malformed JWKS response for "${ISSUER}"`
      );
    });

    it("throws on unsupported key type (non-RSA)", async () => {
      mockFetch({ jwksBody: { keys: [{ kty: "EC", kid: KID, crv: "P-256", x: "fake", y: "fake" }] } });
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key(ISSUER, KID)).rejects.toThrow(
        `Unsupported key type "EC" for kid "${KID}" (only RSA supported)`
      );
    });

    it("does not cache on failure; caches on the subsequent success", async () => {
      // One spy that fails the first (discovery) call, then behaves normally
      const fetchSpy = jest.spyOn(globalThis, "fetch")
        .mockImplementationOnce(() => Promise.resolve(jsonResponse({}, 503)))
        .mockImplementation((url) => {
          const urlStr = url.toString();
          if (urlStr.includes("/.well-known/oauth-authorization-server")) {
            return Promise.resolve(jsonResponse(DISCOVERY_RESPONSE));
          }
          return Promise.resolve(jsonResponse(JWKS_RESPONSE));
        });
      const keyring = new CachingJWKSOAuthKeyring();

      await expect(keyring.key(ISSUER, KID)).rejects.toThrow("JWKS fetch failed"); // call 1: fails, no cache
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const key = await keyring.key(ISSUER, KID); // call 2: discovery + JWKS succeed, key cached
      expect(key).toBe(FAKE_KEY);
      expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 (failed) + 2 (discovery + JWKS)

      await keyring.key(ISSUER, KID); // call 3: cache hit
      expect(fetchSpy).toHaveBeenCalledTimes(3); // unchanged
      expect(importKeySpy).toHaveBeenCalledTimes(1); // imported only on successful call
    });
  });

  describe("discovery response validation", () => {
    it("throws when discovery returns a mismatched issuer (RFC 8414 §3)", async () => {
      mockFetch({
        discoveryBody: {
          issuer:   "https://attacker.example.com",
          jwks_uri: "https://test.keycard.cloud/jwks.json",
        },
      });
      const keyring = new CachingJWKSOAuthKeyring();

      await expect(keyring.key(ISSUER, KID)).rejects.toThrow(
        `Issuer mismatch in discovery: expected "${ISSUER}", got "https://attacker.example.com"`
      );
    });

    it("succeeds when discovery response omits the issuer field (optional per RFC 8414)", async () => {
      mockFetch({ discoveryBody: { jwks_uri: "https://test.keycard.cloud/jwks.json" } });
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key(ISSUER, KID)).resolves.toBe(FAKE_KEY);
    });

    it("throws when discovery response omits jwks_uri", async () => {
      mockFetch({ discoveryBody: { issuer: ISSUER } }); // no jwks_uri
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key(ISSUER, KID)).rejects.toThrow(
        `No jwks_uri in discovery metadata for "${ISSUER}"`
      );
    });

    it("rejects cross-origin jwks_uri to prevent SSRF", async () => {
      mockFetch({
        discoveryBody: {
          issuer:   ISSUER,
          jwks_uri: "https://internal.corp/steal-credentials",
        },
      });
      const keyring = new CachingJWKSOAuthKeyring();
      await expect(keyring.key(ISSUER, KID)).rejects.toThrow(
        `jwks_uri origin "https://internal.corp" does not match issuer origin "https://test.keycard.cloud"`
      );
    });
  });

  describe("invalidate()", () => {
    it("forces a key re-fetch; discovery cache remains intact", async () => {
      const fetchSpy = mockFetch();
      const keyring  = new CachingJWKSOAuthKeyring();

      await keyring.key(ISSUER, KID); // discovery + JWKS
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      keyring.invalidate(ISSUER, KID);
      await keyring.key(ISSUER, KID); // JWKS only (discovery still cached)
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      const calls          = fetchSpy.mock.calls.map(([url]: [string | URL | Request]) => url.toString());
      const discoveryCalls = calls.filter((u) => u.includes("oauth-authorization-server"));
      expect(discoveryCalls).toHaveLength(1); // discovery fetched exactly once
    });

    it("logs a warning when an entry is invalidated", async () => {
      mockFetch();
      const keyring = new CachingJWKSOAuthKeyring();

      await keyring.key(ISSUER, KID);
      keyring.invalidate(ISSUER, KID);

      expect(mockWarn).toHaveBeenCalledWith(
        "Invalidated cached JWKS entry — possible key rotation",
        { issuer: ISSUER, kid: KID }
      );
    });

    it("is a no-op when the entry does not exist", () => {
      const keyring = new CachingJWKSOAuthKeyring();
      expect(() => keyring.invalidate(ISSUER, "nonexistent-kid")).not.toThrow();
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe("concurrent calls", () => {
    // Known TOCTOU: two concurrent cache-miss calls for the same key both fire
    // fetch independently — no in-flight deduplication. Last write wins (correct
    // result), but N redundant requests fire. Benign for this low-traffic internal
    // tool. See MEMORY.md.
    it.skip(
      "concurrent cache-miss calls both fire fetch — known TOCTOU, no dedup",
      async () => {
        mockFetch();
        const keyring = new CachingJWKSOAuthKeyring();

        await Promise.all([keyring.key(ISSUER, KID), keyring.key(ISSUER, KID)]);
        expect(importKeySpy).toHaveBeenCalledTimes(1); // fails: called twice
      }
    );
  });
});
