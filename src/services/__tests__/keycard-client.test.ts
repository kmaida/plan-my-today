/**
 * Tests for the exchangeToken() error mapping contract.
 *
 * The SDK's TokenExchangeClient throws OAuthError (structured) or plain Error
 * (non-JSON). exchangeToken() must convert both into TokenExchangeError so that
 * downstream instanceof checks in handleToolError and formatAuthError continue
 * to work. This is the bridge between the SDK's error model and our error
 * handling chain.
 *
 * Success path and param forwarding are covered by TypeScript compilation
 * (wrong property names / missing fields won't compile).
 */

import type { TokenResponse } from "@keycardai/oauth";
import { OAuthError } from "@keycardai/oauth";

// Mock the SDK so no real HTTP calls are made and we control what's thrown.
// jest.mock is hoisted above imports, so the mock is in place when keycard-client loads.
// Note: mock variables are only safe to reference from inside closures here; jest's
// hoisting evaluates the factory before the const bindings are initialised, so any
// direct value reference would fail. Both overrides below wrap the mock fns in a
// function so the reference resolves at call time, not factory-definition time.
const mockExchangeToken = jest.fn();
const mockFetchMetadata = jest.fn();
jest.mock("@keycardai/oauth", () => {
  const actual = jest.requireActual("@keycardai/oauth");
  return {
    ...actual,
    TokenExchangeClient: jest.fn().mockImplementation(() => ({
      exchangeToken: mockExchangeToken,
    })),
    fetchAuthorizationServerMetadata: (...args: unknown[]) => mockFetchMetadata(...args),
  };
});

import { exchangeToken, TokenExchangeError } from "../keycard-client";

const MOCK_AUTH_INFO = {
  token: "test-subject-token",
  clientId: "test-client",
  scopes: [] as string[],
};

const RESOURCE = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

beforeEach(() => {
  mockExchangeToken.mockReset();
});

// ── Success path ───────────────────────────────────────────────────────────────

describe("exchangeToken → success", () => {
  it("should return the SDK TokenResponse on success", async () => {
    const sdkResponse: TokenResponse = {
      accessToken: "exchanged-token-123",
      tokenType: "bearer",
      expiresIn: 3600,
    };
    mockExchangeToken.mockResolvedValue(sdkResponse);

    const result = await exchangeToken(MOCK_AUTH_INFO, RESOURCE, SCOPES);

    expect(result).toBe(sdkResponse);
    expect(result.accessToken).toBe("exchanged-token-123");
  });

  it("should forward subjectToken, resource, and joined scopes to the SDK", async () => {
    mockExchangeToken.mockResolvedValue({ accessToken: "t", tokenType: "bearer" });

    await exchangeToken(MOCK_AUTH_INFO, RESOURCE, SCOPES);

    expect(mockExchangeToken).toHaveBeenCalledWith({
      subjectToken: "test-subject-token",
      resource: RESOURCE,
      scope: "https://www.googleapis.com/auth/calendar.readonly",
    });
  });

  it("should pass undefined scope when no scopes provided", async () => {
    mockExchangeToken.mockResolvedValue({ accessToken: "t", tokenType: "bearer" });

    await exchangeToken(MOCK_AUTH_INFO, RESOURCE);

    expect(mockExchangeToken).toHaveBeenCalledWith({
      subjectToken: "test-subject-token",
      resource: RESOURCE,
      scope: undefined,
    });
  });
});

// ── OAuthError mapping ─────────────────────────────────────────────────────────

describe("exchangeToken → OAuthError mapping", () => {
  it("should throw TokenExchangeError for OAuthError", async () => {
    mockExchangeToken.mockRejectedValue(new OAuthError("invalid_grant", "Token has been revoked"));

    await expect(exchangeToken(MOCK_AUTH_INFO, RESOURCE, SCOPES)).rejects.toThrow(
      TokenExchangeError
    );
  });

  it("should map OAuthError.message to TokenExchangeError.description", async () => {
    mockExchangeToken.mockRejectedValue(new OAuthError("invalid_grant", "Token has been revoked"));

    try {
      await exchangeToken(MOCK_AUTH_INFO, RESOURCE, SCOPES);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenExchangeError);
      const txError = error as TokenExchangeError;
      expect(txError.description).toBe("Token has been revoked");
      expect(txError.message).toContain("invalid_grant");
    }
  });

  it("should set status to undefined for OAuthError (SDK doesn't expose HTTP status)", async () => {
    mockExchangeToken.mockRejectedValue(new OAuthError("invalid_grant", "Token has been revoked"));

    try {
      await exchangeToken(MOCK_AUTH_INFO, RESOURCE, SCOPES);
      fail("Should have thrown");
    } catch (error) {
      expect((error as TokenExchangeError).status).toBeUndefined();
    }
  });
});

// ── Plain Error mapping ────────────────────────────────────────────────────────

describe("exchangeToken → plain Error mapping", () => {
  it("should throw TokenExchangeError for plain Error", async () => {
    mockExchangeToken.mockRejectedValue(new Error("Token exchange failed (HTTP 500)"));

    await expect(exchangeToken(MOCK_AUTH_INFO, RESOURCE)).rejects.toThrow(TokenExchangeError);
  });

  it("should use Error.message as TokenExchangeError.message", async () => {
    mockExchangeToken.mockRejectedValue(new Error("Token exchange failed (HTTP 500)"));

    try {
      await exchangeToken(MOCK_AUTH_INFO, RESOURCE);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenExchangeError);
      expect((error as TokenExchangeError).message).toBe("Token exchange failed (HTTP 500)");
      expect((error as TokenExchangeError).description).toBeUndefined();
    }
  });

  it("should handle non-Error thrown values", async () => {
    mockExchangeToken.mockRejectedValue("unexpected string error");

    try {
      await exchangeToken(MOCK_AUTH_INFO, RESOURCE);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenExchangeError);
      expect((error as TokenExchangeError).message).toBe("unexpected string error");
    }
  });
});

// ── getTokenEndpoint ───────────────────────────────────────────────────────────
//
// Each test re-loads keycard-client via jest.isolateModules so the module-scope
// tokenEndpointPromise starts fresh. The @keycardai/oauth mock above applies
// globally to the test file, so both the top-level import and the isolated
// requires see the same mocked fetchAuthorizationServerMetadata.

describe("getTokenEndpoint", () => {
  type KeycardClient = typeof import("../keycard-client");

  function loadKeycardClient(): KeycardClient {
    let mod: KeycardClient | undefined;
    jest.isolateModules(() => {
      mod = require("../keycard-client");
    });
    if (!mod) throw new Error("Failed to load keycard-client");
    return mod;
  }

  beforeEach(() => {
    mockFetchMetadata.mockReset();
  });

  it("returns the token_endpoint from discovery", async () => {
    mockFetchMetadata.mockResolvedValue({
      issuer: "https://sts.example/zone",
      token_endpoint: "https://sts.example/zone/oauth/2/token",
    });

    const { getTokenEndpoint } = loadKeycardClient();

    await expect(getTokenEndpoint()).resolves.toBe("https://sts.example/zone/oauth/2/token");
    expect(mockFetchMetadata).toHaveBeenCalledTimes(1);
  });

  it("shares a single in-flight discovery fetch across concurrent callers", async () => {
    // Hold discovery open so both calls land before it resolves.
    let resolveMetadata: ((value: unknown) => void) | undefined;
    mockFetchMetadata.mockReturnValue(
      new Promise((resolve) => {
        resolveMetadata = resolve;
      })
    );

    const { getTokenEndpoint } = loadKeycardClient();

    const first = getTokenEndpoint();
    const second = getTokenEndpoint();

    resolveMetadata?.({
      issuer: "https://sts.example/zone",
      token_endpoint: "https://sts.example/zone/oauth/2/token",
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe("https://sts.example/zone/oauth/2/token");
    expect(b).toBe("https://sts.example/zone/oauth/2/token");
    expect(mockFetchMetadata).toHaveBeenCalledTimes(1);
  });

  it("caches the token_endpoint across subsequent calls", async () => {
    mockFetchMetadata.mockResolvedValue({
      issuer: "https://sts.example/zone",
      token_endpoint: "https://sts.example/zone/oauth/2/token",
    });

    const { getTokenEndpoint } = loadKeycardClient();

    await getTokenEndpoint();
    await getTokenEndpoint();
    await getTokenEndpoint();

    expect(mockFetchMetadata).toHaveBeenCalledTimes(1);
  });

  it("retries discovery after a failure (failures are not cached)", async () => {
    mockFetchMetadata.mockRejectedValueOnce(new Error("DNS lookup failed")).mockResolvedValueOnce({
      issuer: "https://sts.example/zone",
      token_endpoint: "https://sts.example/zone/oauth/2/token",
    });

    const { getTokenEndpoint } = loadKeycardClient();

    await expect(getTokenEndpoint()).rejects.toThrow("DNS lookup failed");
    await expect(getTokenEndpoint()).resolves.toBe("https://sts.example/zone/oauth/2/token");
    expect(mockFetchMetadata).toHaveBeenCalledTimes(2);
  });

  it("throws a descriptive error when metadata is missing token_endpoint", async () => {
    mockFetchMetadata.mockResolvedValue({ issuer: "https://sts.example/zone" });

    const { getTokenEndpoint } = loadKeycardClient();

    await expect(getTokenEndpoint()).rejects.toThrow(/does not advertise a token_endpoint/);
  });
});
