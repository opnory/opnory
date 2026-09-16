# Gate 3 local proof — Keycloak OIDC -> Fastify JWT validation

This directory holds a live-local proof harness for the Gate 3 OIDC boundary
**against a preconfigured Keycloak realm**. The pattern: Keycloak issues JWT
access tokens signed RS256 with the realm's keys published at the well-known
JWKS endpoint, and the Gate 3 wired API needs nothing more than that — remote
JWKS fetch, signature verification, issuer/audience/expiration checks, and
`groups` -> role mapping.

No OPA handles, no MCP-managed contexts — just Keycloak + curl + bun.

## Contents (only what actually exists in this repo)

- `live-api.ts` — starts the real Fastify API wired to a local Keycloak realm
  via `createApiServer({ oidcConfig })` (env: `GATE3_KC_REALM_BASE`,
  `GATE3_API_PORT`). This reproduces **only the API side**, and only once a
  compatible realm already exists.
- `EVIDENCE.md` — sanitized record of the previously executed 2026-09-15
  local proof: image digest, realm/client/mapper/user metadata, token claim
  sample, and the full HTTP status matrix.

## Reproducibility status (explicit)

- **Realm provisioning is NOT currently reproducible from committed repo
  assets.** There is no committed compose file, realm export, or env
  template. The `opnory` realm was configured interactively in a local
  Keycloak container; its state exists only in that container's storage.
- `EVIDENCE.md` is the historical record of the completed 2026-09-15 proof
  (image `quay.io/keycloak/keycloak:24.0`, digest
  `sha256:f8ade94c1d0ad2f2fa7734a455fee5392764f402c43ca35e9af6bf63a2541dc9`).
- `live-api.ts` reproduces the API-side wiring only; it requires an already
  provisioned compatible realm to point at.

## Prerequisite realm shape (as executed on 2026-09-15)

Realm `opnory` with client `opnory-api` (confidential, directAccessGrants
enabled), a `groups` membership mapper (claim `groups`, full.path=false,
access token), an `opnory-api` audience mapper, group
`opnory-platform-admins`, and user `test-admin` with email/firstName/lastName
set and a non-temporary password. See `EVIDENCE.md` for the full metadata and
the "Account is not fully set up" diagnosis.

## Run the API side against an existing realm

    docker start keycloak  # quay.io/keycloak/keycloak:24.0 on :8080
    DATABASE_URL=postgresql://unused:***@127.0.0.1:1/opnory \
      GATE3_API_PORT=3001 bun run ops/gate3-keycloak/live-api.ts &
    # mint a real user token via the password grant (credentials via env, never in files)
    curl -s -X POST http://localhost:8080/realms/opnory/protocol/openid-connect/token \
      -d grant_type=password -d client_id=opnory-api -d client_secret="$OPNORY_API_CLIENT_SECRET" \
      -d username=test-admin -d password="$TEST_ADMIN_PASSWORD"
    # use the token against http://127.0.0.1:3001/v1/access/requests/:id

This is a live-local proof harness, not a self-contained reproduction of the
Keycloak stack.
