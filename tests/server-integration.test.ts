import request from "supertest";
import { createApp } from "../src/server";

describe("Plan My Today MCP Integration Tests", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  describe("OAuth metadata", () => {
    it("should provide OAuth discovery endpoint", async () => {
      const response = await request(app)
        .get("/.well-known/oauth-authorization-server")
        .expect(200);

      expect(response.body).toMatchObject({
        issuer: expect.any(String),
      });
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
