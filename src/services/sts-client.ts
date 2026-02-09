import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "../config";
import { parseJWTPayload } from "../types/index";
import { decodeJWT } from "../utils/auth-utils";

export interface TokenExchangeResponse {
  access_token: string;
  issued_token_type: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export class STSClient {
  private stsBaseUrl: string;
  private clientId: string;
  private clientSecret: string;

  constructor() {
    this.stsBaseUrl = config.keycardStsIssuerUrl;
    this.clientId = config.keycardClientId;
    this.clientSecret = config.keycardClientSecret;
  }

  private getIssuerFromAuthInfo(authInfo: AuthInfo): string | undefined {
    const fromExtra = parseJWTPayload(authInfo.extra)?.iss;
    if (fromExtra) {
      return fromExtra;
    }

    if (!authInfo.token) {
      return undefined;
    }

    return decodeJWT(authInfo.token)?.iss;
  }

  async exchange(
    authInfo: AuthInfo,
    resource: string,
    scopes?: string[]
  ): Promise<TokenExchangeResponse> {
    const stsBaseUrl = this.stsBaseUrl || this.getIssuerFromAuthInfo(authInfo);
    if (!stsBaseUrl) {
      throw new Error("Token exchange failed: missing STS issuer URL");
    }

    const params = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: authInfo.token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: resource,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    if (scopes?.length) {
      params.set("scope", scopes.join(" "));
    }

    const requestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    } satisfies RequestInit;

    const tokenUrl = `${stsBaseUrl}/oauth/2/token`;

    let response = await fetch(tokenUrl, requestInit);
    if (response.status === 404) {
      const fallbackUrl = `${stsBaseUrl}/oauth/token`;
      response = await fetch(fallbackUrl, requestInit);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }

    return await response.json() as TokenExchangeResponse;
  }
}

// Singleton instance
export const stsClient = new STSClient();