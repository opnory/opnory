# Gate 3 local proof — Keycloak OIDC -> Fastify JWT validation

This directory holds a minimal idiomatic Keycloak proof stack. The pattern:
Keycloak issues JWT access tokens by RS256 with the realm's public keys at a well-known JWKS endpoint,
and the gate-3 wired API does not know or need more than that. The compose stack
is lightweight: it emits one access token, sign it, then wire the API with the
manifests against that JWKS (either literally by introducing a stub JWKS server
in the docker compose network, or by pointing `OPNORY_OIDC_JWKS_URI` at the realm
when Keycloak ops itself).

pattern: no-OPA handles, MCP-managed contexts, or anything but a Keycloak + curl + bun back-and-forth.

## Contents

- `live-api.ts` — starts the real Fastify API wired to the local Keycloak realm
  via `createApiServer({ oidcConfig })` (env: `GATE3_KC_REALM_BASE`,
  `GATE3_API_PORT`).
- `EVIDENCE.md` — 2026-09-15 local proof evidence and sanitized results.
- `keycloak-compose.yml` — `docker compose`-based Keycloak + MariaDB admin-side service.
- `opnory-realm.json` — exported realm template for client + mapper + group config.
- `.env.example` — templates for the gate 3 env vars (`OPNORY_OIDC_*`).

## Prerequisites proven against an already-running realm

Realm `opnory` with client `opnory-api` (directAccessGrants enabled), a
`groups` membership mapper (claim `groups`, full.path=false, access token),
an `opnory-api` audience mapper, group `opnory-platform-admins`, and user
`test-admin` with email/firstName/lastName set and a non-temporary password.

## Reproduce

    docker start keycloak  # quay.io/keycloak/keycloak:24.0 on :8080
    DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/opnory \
      GATE3_API_PORT=3001 bun run ops/gate3-keycloak/live-api.ts &
    # mint a real user token via the password grant (credentials via env, never in files)
    curl -s -X POST http://localhost:8080/realms/opnory/protocol/openid-connect/token \
      -d grant_type=password -d client_id=opnory-api -d client_secret="$OPNORY_API_CLIENT_SECRET" \
      -d username=test-admin -d password="$TEST_ADMIN_PASSWORD"
    # use the token against http://127.0.0.1:3001/v1/access/requests/:id

See `EVIDENCE.md` for the full status matrix and the "Account is not fully set
up" diagnosis.

Use these as the canonical pattern for a live/local OIDC proof against the Fastify API.
