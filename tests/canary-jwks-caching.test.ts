/**
 * CANARY TEST — @keycardai/oauth JWKSOAuthKeyring caching
 *
 * test.failing() contract:
 *   RIGHT NOW:      test fails (SDK fetches on every call, 4 fetches total)
 *                   → suite PASSES as expected
 *   AFTER SDK FIX:  test passes (SDK caches, 2 fetches total)
 *                   → suite FAILS with "Expected test to fail, but it passed"
 *                   → remove this file and src/services/caching-jwks-keyring.ts,
 *                     revert server.ts to requireBearerAuth({ requiredScopes: [] })
 */

import type { webcrypto } from "node:crypto";
import { JWKSOAuthKeyring } from "@keycardai/oauth/keyring";

// CryptoKey is a Web Crypto type — not a global in @types/node; pull from webcrypto namespace.
type CryptoKey = webcrypto.CryptoKey;

// globalThis.fetch and globalThis.crypto.subtle became stable globals in Node 18.
// If this guard throws, Jest reports "Test suite failed to run" — not a test.failing()
// pass — so a broken canary cannot silently masquerade as a passing one.
const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
if (nodeVersion < 18) {
  throw new Error(
    `canary-jwks-caching.test.ts requires Node 18+ for globalThis.fetch and ` +
      `globalThis.crypto.subtle (current: Node ${process.versions.node})`
  );
}

const TEST_ISSUER = "https://test.keycard.cloud";
const TEST_KID = "test-key-id";

const mockDiscovery = {
  issuer: TEST_ISSUER,
  jwks_uri: `${TEST_ISSUER}/.well-known/jwks.json`,
};

const mockJwks = {
  keys: [{ kty: "RSA", kid: TEST_KID, n: "fake_n", e: "AQAB" }],
};

describe("canary: @keycardai/oauth JWKSOAuthKeyring caching", () => {
  beforeEach(() => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes(".well-known/oauth-authorization-server")) {
        return { ok: true, json: () => Promise.resolve(mockDiscovery) } as unknown as Response;
      }
      if (urlStr.includes("jwks.json")) {
        return { ok: true, json: () => Promise.resolve(mockJwks) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch in canary test: ${urlStr}`);
    });
    jest.spyOn(globalThis.crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey);
  });

  afterEach(() => jest.restoreAllMocks());

  // When this test starts passing, @keycardai/oauth now caches JWKS internally.
  // See the removal checklist at the top of this file.
  test.failing(
    "caches JWKS between calls with the same issuer+kid (currently uncached — expect 4 fetches, not 2)",
    async () => {
      const keyring = new JWKSOAuthKeyring();

      await keyring.key(TEST_ISSUER, TEST_KID);
      await keyring.key(TEST_ISSUER, TEST_KID); // should be a cache hit if SDK adds caching

      // Without SDK caching: 4 fetches (discovery + JWKS, once per key() call)
      // With    SDK caching: 2 fetches (discovery + JWKS, only on first call)
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );
});
