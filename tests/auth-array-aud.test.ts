/**
 * Canary test for the Keycard SDK's array `aud` handling.
 *
 * The SDK's JWTOAuthTokenVerifier does `new URL(claims.aud)` which mangles
 * array audiences into a garbage comma-joined URL. We work around this with
 * ArrayAudTokenVerifier in src/middleware/auth.ts.
 *
 * The `it.failing` test below proves the SDK bug exists. Once the upstream
 * PR is merged and we bump the SDK, it will start passing — Jest will then
 * report it as a failure (since it's expected to fail). That's our signal to:
 *   1. Delete ArrayAudTokenVerifier from src/middleware/auth.ts
 *   2. Delete this test file
 *
 * Upstream PR: https://github.com/keycardai/typescript-sdk
 */

import { JWTOAuthTokenVerifier } from "@keycardai/mcp/server/auth/verifiers/jwt";
import { JWKSOAuthKeyring } from "@keycardai/oauth/keyring";

// Mock the low-level JWT verifier to skip real JWKS fetching and signature
// verification. This lets us control exactly what claims are returned.
jest.mock("@keycardai/oauth/jwt/verifier", () => {
  const mockVerify = jest.fn();
  return {
    JWTVerifier: jest.fn().mockImplementation(() => ({
      verify: mockVerify,
    })),
    __mockVerify: mockVerify,
  };
});

const RESOURCE_URL = "http://localhost:9005/mcp";
const USERINFO_URL = "https://example.keycard.cloud/openid/connect/userinfo";
const DUMMY_TOKEN = "header.payload.signature";

/** Builds a realistic JWT claims payload matching Keycard's token structure. */
function baseClaims(audOverride: string | string[]) {
  return {
    iss: "https://example.keycard.cloud",
    sub: "user-123",
    aud: audOverride,
    client_id: "test-client-id",
    scope: "openid profile",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("JWTOAuthTokenVerifier array aud handling (SDK canary)", () => {
  let verifier: JWTOAuthTokenVerifier;
  let mockVerify: jest.Mock;

  beforeEach(() => {
    // Access the shared mock function via the module's exported helper
    const mod = require("@keycardai/oauth/jwt/verifier");
    mockVerify = mod.__mockVerify;
    mockVerify.mockReset();

    verifier = new JWTOAuthTokenVerifier(new JWKSOAuthKeyring());
  });

  it("handles string aud correctly (baseline)", async () => {
    mockVerify.mockResolvedValue(baseClaims(RESOURCE_URL));

    const authInfo = await verifier.verifyAccessToken(DUMMY_TOKEN);

    expect(authInfo.resource?.toString()).toBe(RESOURCE_URL);
  });

  // ── Expected to FAIL with the current SDK ──────────────────────────────
  // The SDK does `new URL(claims.aud)` which, when aud is an array, coerces
  // it to "http://localhost:9005/mcp,https://example.keycard.cloud/..."
  // instead of picking the first valid URL.
  //
  // When this test starts PASSING, the upstream fix has landed. Delete
  // ArrayAudTokenVerifier from src/middleware/auth.ts and this test file.
  it.failing(
    "handles array aud by picking the first valid URL (upstream SDK fix needed)",
    async () => {
      mockVerify.mockResolvedValue(baseClaims([RESOURCE_URL, USERINFO_URL]));

      const authInfo = await verifier.verifyAccessToken(DUMMY_TOKEN);

      expect(authInfo.resource?.toString()).toBe(RESOURCE_URL);
    }
  );
});
