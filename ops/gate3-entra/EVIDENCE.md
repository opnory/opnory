# Gate 3 Entra live local-API OIDC proof — sanitized evidence

Date: 2026-09-16 (UTC)

Base: `main` @ b2498d0030ad0e9e11c2fe0f794ec0d2b20399de (post PR #12 provider-neutral
OIDC implementation, post PR #13 Keycloak live-local evidence).

This document is the **intentionally redacted durable proof record**. Raw tenant
identifiers, object IDs, user identifiers, correlation IDs, and all token material
are deliberately omitted or replaced with SHA-256 references. No secrets are present.

## Evidence classification

| Item                                                | Classification                          |
| --------------------------------------------------- | --------------------------------------- |
| Gate 3 provider-neutral OIDC implementation         | IMPLEMENTED (merged, PR #12)            |
| Route-boundary automated tests                      | PROVEN (CI)                             |
| Keycloak live-local OIDC                            | PROVEN (ops/gate3-keycloak/EVIDENCE.md) |
| Entra live-local OIDC (real Entra token, local API) | PROVEN                                  |
| Entra groups -> Opnory role path                    | PROVEN                                  |
| Entra MFA enforcement                               | UNPROVEN                                |
| Self-contained Entra repro from repo assets         | NOT CLAIMED                             |
| Gate 2 TLS ingress                                  | CLOSED / untouched                      |
| Production Gate 3 / public ingress                  | NOT CLAIMED                             |

## Flow exercised

Microsoft Entra -> authorization-code + PKCE (S256) -> real Entra-issued user
access token -> Entra JWKS -> RS256 signature validation -> issuer validation ->
audience validation -> expiry validation -> direct `groups` claim -> existing
Opnory `roleGroupMap` -> Fastify authorization hook -> business handler.

No locally-signed tokens were used. No code changes to `apps/api` were required:
the same provider-neutral `OidcAuthConfig` seam used by the Keycloak harness
accepts the Entra issuer / audience / JWKS URI / role map without modification.

## Security Defaults result (recorded, preserved)

Device-code flow was attempted first and failed with:

    AADSTS530035 — "Access has been blocked by security defaults."

Observed facts:

- Password authentication itself succeeded (per the Entra sign-in log).
- The block targeted `originalTransferMethod=deviceCodeFlow` specifically.
- Conditional Access status: notApplied; no CA policies present in the tenant.
- Security Defaults were **preserved** — not disabled, weakened, or bypassed.
- The proof was moved to authorization-code + PKCE (a flow Security Defaults
  permits) rather than changing any tenant policy.

## Redirect correction (configuration step, not a security event)

The first PKCE attempt used redirect URI `http://127.0.0.1:8400/callback`, which
was not yet registered on the public-client application, producing AADSTS50011
redirect_uri mismatch. The loopback redirect `http://localhost:8400/callback`
was registered on the same public-client application and a fresh authorize
request succeeded. This is recorded as a configuration correction, not an
authentication or authorization failure.

## Sanitized token claim shape

Identifiers below are deterministic SHA-256 digests of the raw values, recorded
so the proof is reproducible against the same tenant without exposing tenant
identifiers in the repository.

```json
{
  "iss": "https://login.microsoftonline.com/sha256:18df94da…/v2.0",
  "aud": "sha256:2da528be95ef3f50ab100d9c6ce7af5ea2c022c2944acfe29dbe90dda2d13f62",
  "exp": "<valid during proof lifetime>",
  "sub": "sha256:<redacted>",
  "groups": [
    "sha256:b668422df4facfbb833b2bb130ef2fc017e7811053dc1504b4e862a89b15bd88"
  ]
}
```

- `tenant_id_sha256`: 18df94da1f07c5fbd00af09ae0ebba8d81060a3d73e1e51ce74b988e5e04623d
- `client_id_sha256` (audience): 2da528be95ef3f50ab100d9c6ce7af5ea2c022c2944acfe29dbe90dda2d13f62
- `groups[0]_sha256` (mapped test group): b668422df4facfbb833b2bb130ef2fc017e7811053dc1504b4e862a89b15bd88
- `sub_sha256` and `oid_sha256`: retained in duplicate-keys-differ form locally; both hashed

Explicit statements:

- `groups` was emitted as a **direct JSON array of group object IDs** in the
  access token.
- **No groups-overage representation** (`_claim_names` / `_claim_sources`) occurred.
- The mapped group resolved to the intended Opnory role `platform-admin` through
  the existing `roleGroupMap` configuration (Entra group object ID ->
  platform-admin at the auth boundary only; provider IDs never entered domain logic).
- Token signature verified against the tenant's real Entra JWKS
  (`/discovery/v2.0/keys`); alg RS256; kid matched.
- Issuer matched exactly; audience matched exactly; expiry in the future at use time.

Full token never persisted outside an ephemeral mode-0600 file, deleted after
the proof. No refresh token was returned for this confidentiality class.

## Live local API matrix

Route under test: `GET /v1/access/requests/:id` (requires one of
platform-admin / access-approver / auditor-read-only). API bound loopback-only
(127.0.0.1, ephemeral port). Ports 80/443 remained closed throughout.

| Case                                             | Result                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /health, no token                            | 200                                                                                                                                                                                               |
| protected, no token                              | 401 `{"error":"Not authenticated"}`                                                                                                                                                               |
| protected, malformed token (`Bearer not.a.jwt`)  | 401 `{"error":"Token verification failed"}` (server log recorded a genuine jose `ERR_JWS_INVALID` failure at the validator)                                                                       |
| protected, valid Entra user token + mapped group | 404 `{"error":"Access request not found"}` — AUTHENTICATION PASSED, AUTHORIZATION PASSED, business handler reached and returned its own not-found for a validly-formed but nonexistent request ID |

For the 404 row: authentication passed, authorization passed, the business
handler produced the 404.

A real Entra **403 no-role row was NOT executed**: producing one safely would
have required additional identity/tenant configuration. That behavior is covered
by deterministic automated route-boundary tests and by the Keycloak live proof;
those are **not** misrepresented as Entra evidence. The absence of an Entra-403
row does not diminish the positive result: a real Entra token traversed
signature / issuer / audience / expiry / groups-mapping / authorization into
the business handler.

No expired-token row: not manufactured. Existing automated tests cover expiry
rejection deterministically.

## MFA boundary

Entra MFA: **UNPROVEN**.

The device-code sign-in log showed single-factor (password) authentication;
Security Defaults blocked the device-code grant before any MFA challenge could
occur; the successful PKCE sign-in did not produce retained evidence sufficient
to upgrade MFA to PROVEN (the tenant has no premium-tier audit endpoint access
for per-event authentication-detail queries, and no MFA challenge was observed
in the flow). No MFA claim is made.

## Boundaries preserved

- Gate 2 untouched; no public 80/443 exposure.
- No Conditional Access creation/modification; Security Defaults intact.
- No new admin-consent application permissions; only user-delegated
  `access_as_user` scope on the dedicated proof application.
- No groups or memberships changed for the proof; test user was already in the
  mapped group.
- No secrets (tokens, codes, verifiers, passwords, client secrets, keys) in
  this document.
- This document is the durable proof record; the only copy containing raw
  identifiers remains on the originator's machine and is not part of the
  repository evidence trail.

## Reproduction note

Realm/tenant provisioning is not reproducible from committed repo assets — the
same limitation honestly documented for the Keycloak proof. The durable claims
here are (a) the provider-neutral boundary interoperates with a real Entra
access token end-to-end into the business handler, and (b) the Entra Direct
`groups` claim shape (array of security-group object IDs, no overage) is
compatible with the existing `groups: string[]` consumer without code change.
