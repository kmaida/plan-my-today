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
const mockExchangeToken = jest.fn();
jest.mock("@keycardai/oauth", () => {
  const actual = jest.requireActual("@keycardai/oauth");
  return {
    ...actual,
    TokenExchangeClient: jest.fn().mockImplementation(() => ({
      exchangeToken: mockExchangeToken,
    })),
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
