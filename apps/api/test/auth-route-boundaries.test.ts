import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Config layer expects NODE_ENV to be one of development|staging|production —
// set it before anything imports @opnory/config.
process.env.NODE_ENV = "development";
process.env.DATABASE_URL = "postgresql://opnory:opnory@localhost:5432/opnory";

import { createApiServer } from "../src/index.js";

// ---- JWKS test fixture ----
let keyPair: { privateKey: CryptoKey; publicKey: CryptoKey };
let server: ReturnType<typeof createServer>;
let issuer: string;
let port: number;

const ROLE_GROUP_MAP = {
  "opnory-access-approvers": "access-approver",
  "opnory-platform-admins": "platform-admin",
  "opnory-auditors": "auditor-read-only",
} as const;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  keyPair = { privateKey: kp.privateKey, publicKey: kp.publicKey };
  const jwk = await exportJWK(keyPair.publicKey);
  jwk.kid = "k1";

  server = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  port = addr.port;
  issuer = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server?.close();
});

async function sign(payload: Record<string, unknown>, header: Record<string, string> = {}): Promise<string> {
  const b = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "k1", ...header })
    .setIssuedAt()
    .setExpirationTime("5m");
  if (!payload.iss) b.setIssuer(issuer);
  if (!payload.aud) b.setAudience("opnory-api");
  return b.sign(keyPair.privateKey);
}

function oidcCfg() {
  return {
    issuer,
    audience: "opnory-api",
    jwksUri: `${issuer}/.well-known/jwks.json`,
    roleGroupMap: { ...ROLE_GROUP_MAP },
  };
}

describe("Gate 3 route-level auth boundary", () => {
  it("GET /health requires no auth", async () => {
    const app = await createApiServer({ oidcConfig: oidcCfg() });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
    await app.close();
  });

  it("POST /v1/access/requests without token → 401 missing_token", async () => {
    const app = await createApiServer({ oidcConfig: oidcCfg() });
    const res = await app.inject({
      method: "POST",
      url: "/v1/access/requests",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/Not authenticated/);
    await app.close();
  });

  it("POST /v1/access/requests with expired token → 401 token_expired", async () => {
    const app = await createApiServer({ oidcConfig: oidcCfg() });
    const stale = await new SignJWT({
      iss: issuer,
      aud: "opnory-api",
      groups: ["opnory-platform-admins"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keyPair.privateKey);
    const res = await app.inject({
      method: "POST",
      url: "/v1/access/requests",
      headers: { authorization: "Bearer " + stale },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/expired/);
    await app.close();
  });

  it("GET /v1/access/requests/:id with wrong-role token → 403 no_role", async () => {
    const app = await createApiServer({ oidcConfig: oidcCfg() });
    const wrongRole = await sign({ groups: ["opnory-unrelated"] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/access/requests/11111111-1111-1111-1111-111111111111",
      headers: { authorization: "Bearer " + wrongRole },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("GET /v1/access/requests/:id with auditor-read-only role → reaches handler (404 = service layer, not auth)", async () => {
    const app = await createApiServer({ oidcConfig: oidcCfg() });
    const ok = await sign({ groups: ["opnory-auditors"] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/access/requests/11111111-1111-1111-1111-111111111111",
      headers: { authorization: "Bearer " + ok },
    });
    // Auth passed — the 404 meaning "no such request in store" comes from the handler,
    // i.e. the route executed. If we hook-auth'd this by mistake we'd get 401/403.
    expect([200, 404]).toContain(res.statusCode);
    await app.close();
  });

  it("Server still boots when no OIDC config provided (local dev default)", async () => {
    const app = await createApiServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
