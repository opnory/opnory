#!/usr/bin/env bun
/**
 * Gate 3 local live-proof API instance.
 *
 * Starts the real Fastify API (apps/api createApiServer) wired to the local
 * Keycloak realm via OIDC config — remote JWKS lookup, signature/issuer/
 * audience/expiration validation, groups->role mapping — exactly the Gate 3
 * production-shaped code path. No handler changes, no locally-signed tokens.
 *
 * Credentials are supplied via env vars (never hardcoded):
 *   GATE3_KC_REALM_BASE  e.g. http://localhost:8080/realms/opnory
 *   GATE3_API_PORT       default 3001
 *
 * Usage:
 *   GATE3_KC_REALM_BASE=http://localhost:8080/realms/opnory bun run ops/gate3-keycloak/live-api.ts &
 */
import { createApiServer } from "../../apps/api/src/index.js";

const realmBase =
  process.env.GATE3_KC_REALM_BASE ?? "http://localhost:8080/realms/opnory";
const port = Number(process.env.GATE3_API_PORT ?? 3001);

const server = await createApiServer({
  oidcConfig: {
    issuer: realmBase,
    audience: "opnory-api",
    jwksUri: `${realmBase}/protocol/openid-connect/certs`,
    roleGroupMap: {
      "opnory-platform-admins": "platform-admin",
    },
  },
});

await server.listen({ port, host: "127.0.0.1" });
console.log(
  `gate3 live-proof API listening on http://127.0.0.1:${port} (issuer=${realmBase})`,
);
