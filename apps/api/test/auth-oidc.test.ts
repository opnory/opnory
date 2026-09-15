import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createServer } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createOidcValidator,
  requireRole,
  AuthError,
  type TokenPrincipal,
} from "../src/auth/oidc.js";

let keyPair: { privateKey: CryptoKey; publicKey: CryptoKey };
let kid: string;
let issuer: string;
let audience: string;
let server: ReturnType<typeof createServer>;
let port: number;

const VALID_ROLE_GROUP_MAP = {
  "opnory-access-approvers": "access-approver",
  "opnory-platform-admins": "platform-admin",
} as const;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  keyPair = {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  };
  const publicJwk = await exportJWK(keyPair.publicKey);
  kid = "test-key-1";
  publicJwk.kid = kid;

  server = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("cannot bind test JWKS server");
  port = addr.port;
  issuer = `http://127.0.0.1:${port}`;
  audience = "opnory-api";
});

afterAll(async () => {
  server?.close();
});

function makeValidator() {
  return createOidcValidator({
    issuer,
    audience,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    roleGroupMap: { ...VALID_ROLE_GROUP_MAP },
  });
}

async function signToken(
  payload: Record<string, unknown>,
  header: Record<string, string> = {},
): Promise<string> {
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid, ...header })
    .setIssuedAt()
    .setExpirationTime("5m");
  if (!payload.iss) builder.setIssuer(issuer);
  if (!payload.aud) builder.setAudience(audience);
  return builder.sign(keyPair.privateKey);
}

describe("Gate 3 − OIDC access-token validation boundary", () => {
  it("happy path: valid token with matching scope yields roles", async () => {
    const validator = makeValidator();
    const token = await signToken({ groups: ["opnory-platform-admins"] });
    const principal = await validator(`Bearer ${token}`);
    expect(principal.subject).toBeDefined();
    expect([...principal.roles]).toContain("platform-admin");
  });

  it("rejects missing Authorization header", async () => {
    const validator = makeValidator();
    await expect(validator(undefined)).rejects.toMatchObject({ code: "missing_token" });
  });

  it("rejects non-Bearer scheme", async () => {
    const validator = makeValidator();
    await expect(validator("Basic abc123")).rejects.toMatchObject({ code: "malformed_token" });
  });

  it("rejects malformed Bearer value", async () => {
    const validator = makeValidator();
    await expect(validator("Bearer ")).rejects.toMatchObject({ code: "malformed_token" });
  });

  it("rejects wrong issuer", async () => {
    const validator = makeValidator();
    const bad = await signToken({ iss: "https://evil.example.com", aud: audience, groups: ["opnory-platform-admins"] });
    await expect(validator(`Bearer ${bad}`)).rejects.toMatchObject({ code: "wrong_issuer" });
  });

  it("rejects wrong audience", async () => {
    const validator = makeValidator();
    const bad = await signToken({ iss: issuer, aud: "https://other-api.example.com", groups: ["opnory-platform-admins"] });
    await expect(validator(`Bearer ${bad}`)).rejects.toMatchObject({ code: "wrong_audience" });
  });

  it("rejects expired token", async () => {
    const validator = makeValidator();
    const bad = await new SignJWT({ iss: issuer, aud: audience, groups: ["opnory-platform-admins"] })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keyPair.privateKey);
    await expect(validator(`Bearer ${bad}`)).rejects.toMatchObject({ code: "token_expired" });
  });

  it("rejects tampered signature (wrong kid)", async () => {
    const validator = makeValidator();
    const bad = await signToken({ groups: ["opnory-platform-admins"] }, { kid: "unknown-kid" });
    await expect(validator(`Bearer ${bad}`)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps IdP groups to Opnory roles — unmapped group grants no role", async () => {
    const validator = makeValidator();
    const token = await signToken({ groups: ["unmapped-group"] });
    const principal = await validator(`Bearer ${token}`);
    expect(principal.roles.size).toBe(0);
  });

  it("hook: missing principal → 401 missing_token", async () => {
    const hook = requireRole("platform-admin");
    await expect(
      hook({} as Parameters<typeof hook>[0], {} as Parameters<typeof hook>[1]),
    ).rejects.toMatchObject({ code: "missing_token" });
  });

  it("hook: principal present but role missing → 403 no_role", async () => {
    const hook = requireRole("platform-admin");
    await expect(
      hook(
        { principal: { roles: new Set(["auditor-read-only"]), subject: "u-1" } } as Parameters<typeof hook>[0],
        {} as Parameters<typeof hook>[1],
      ),
    ).rejects.toMatchObject({ code: "no_role" });
  });

  it("hook: principal has required role → passes", async () => {
    const hook = requireRole("platform-admin");
    await expect(
      hook(
        { principal: { roles: new Set(["platform-admin"]), subject: "u-1" } } as Parameters<typeof hook>[0],
        {} as Parameters<typeof hook>[1],
      ),
    ).resolves.toBeUndefined();
  });
});
