import request from "supertest";
import { createApp } from "../src/server";

describe("Plan My Today MCP Integration Tests", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  describe("OAuth metadata", () => {
    // The SDK's discovery route relays the issuer's own metadata over the
    // network. Stub that one fetch: the suite must pass with no network at all
    // (the factory judge runs checks in a container with --network none), and
    // a live issuer is not what this test checks.
    const ISSUER_METADATA = {
      issuer: "https://issuer.test",
      authorization_endpoint: "https://issuer.test/oauth/2/authorize",
      token_endpoint: "https://issuer.test/oauth/2/token",
    };
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return new Response(JSON.stringify(ISSUER_METADATA), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected network call in test: ${url}`);
      });
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("should provide OAuth discovery endpoint", async () => {
      const response = await request(app)
        .get("/.well-known/oauth-authorization-server")
        .expect(200);

      // The route relays the issuer's metadata and pins authorization_endpoint
      // to this server with a `resource` parameter.
      expect(response.body).toMatchObject({
        issuer: ISSUER_METADATA.issuer,
        token_endpoint: ISSUER_METADATA.token_endpoint,
      });
      const authorizationUrl = new URL(response.body.authorization_endpoint);
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(ISSUER_METADATA.authorization_endpoint);
      expect(authorizationUrl.searchParams.get("resource")).toMatch(/^http:\/\/127\.0\.0\.1/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/\.well-known\/oauth-authorization-server$/);
    });

    it("should provide protected resource metadata", async () => {
      const response = await request(app)
        .get("/.well-known/oauth-protected-resource")
        .expect(200);

      expect(response.body).toMatchObject({
        authorization_servers: expect.arrayContaining([expect.any(String)]),
        // PMT advertises no scopes — access control is at the Keycard resource
        // level (Cedar policy), not via bearer scopes.
        scopes_supported: [],
        resource_name: "Plan My Today MCP",
      });
    });
  });

  describe("MCP endpoint", () => {
    it("should return 401 for unauthenticated requests to /mcp", async () => {
      await request(app)
        .post("/mcp")
        .send({ invalid: "request" })
        .expect(401);
    });
  });
});
