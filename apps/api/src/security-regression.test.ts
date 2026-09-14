import { describe, it, expect, beforeAll } from "bun:test";
import { createApiServer } from "./index";

// Set required test env before any config load
beforeAll(() => {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.OPNORY_TRUST_PROXY_CIDRS = "172.20.0.0/16"; // simulate compose subnet
  process.env.OPNORY_CORS_ORIGINS = "http://localhost:3000,https://api.example.com";
});

describe("SEC-14 Regression — Fastify 5 trustProxy + CORS hardening", () => {
  it("trustProxy: Fastify 5 allowlist config is valid (no startup crash)", async () => {
    // This test validates the trustProxy array config is accepted by Fastify 5
    const server = await createApiServer();
    const res = await server.inject({
      method: "GET",
      url: "/health",
    });
    expect(res.statusCode).toBe(200);
  });

  it("trustProxy: non-trusted X-Forwarded-For does not crash server; server processes request", async () => {
    const server = await createApiServer();
    // Inject request with spoofed X-Forwarded-For from non-trusted IP
    // Server should not crash - Fastify 5 ignores non-trusted proxy headers
    const res = await server.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.1" }, // non-trusted
    });
    // Should succeed (health is public) - confirms server accepts request without crash
    expect(res.statusCode).toBe(200);
  });

  it("CORS: non-allowed origin is rejected (no ACAO header)", async () => {
    const server = await createApiServer();
    // Test CORS on a working route (/v1/support/requests)
    const res = await server.inject({
      method: "POST",
      url: "/v1/support/requests",
      headers: { 
        origin: "https://evil.example",
        "content-type": "application/json"
      },
      payload: {
        requestId: "00000000-0000-0000-0000-000000000000",
        workspaceId: "test",
        userId: "test",
        channelId: "test",
        text: "test",
        timestamp: new Date().toISOString(),
        source: "api",
      },
    });
    // Non-allowed origin should NOT get ACAO header
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS: allowed origin (from env) gets ACAO header", async () => {
    const server = await createApiServer();
    const res = await server.inject({
      method: "POST",
      url: "/v1/support/requests",
      headers: { 
        origin: "https://api.example.com",
        "content-type": "application/json"
      },
      payload: {
        requestId: "00000000-0000-0000-0000-000000000000",
        workspaceId: "test",
        userId: "test",
        channelId: "test",
        text: "test",
        timestamp: new Date().toISOString(),
        source: "api",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://api.example.com");
  });

  it("CORS: default origin (localhost:3000) works when env not set", async () => {
    // Test without env var - should default to localhost:3000
    // We need a fresh server without the env var
    delete process.env.OPNORY_CORS_ORIGINS;
    const server = await createApiServer();
    const res = await server.inject({
      method: "POST",
      url: "/v1/support/requests",
      headers: { 
        origin: "http://localhost:3000",
        "content-type": "application/json"
      },
      payload: {
        requestId: "00000000-0000-0000-0000-000000000000",
        workspaceId: "test",
        userId: "test",
        channelId: "test",
        text: "test",
        timestamp: new Date().toISOString(),
        source: "api",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    // Restore for other tests
    process.env.OPNORY_CORS_ORIGINS = "http://localhost:3000,https://api.example.com";
  });
});
