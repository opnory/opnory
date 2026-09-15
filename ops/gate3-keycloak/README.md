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

- `keycloak-compose.yml` — `docker compose`-based Keycloak + MariaDB admin-side service.
- `opnory-realm.json` — exported realm template for client + mapper + group config.
- `.env.example` — templates for the gate 3 env vars (`OPNORY_OIDC_*`).

Use these as the canonical pattern for a live/local OIDC proof against the Fastify API.
