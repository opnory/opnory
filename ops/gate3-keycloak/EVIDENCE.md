# Gate 3 Keycloak local proof — evidence

Date: 2026-09-15
Repo state: main = ddc39d78803d8c403be7ba00f4c13722c498983c (PR #12 merged), branch `feat/gate3-keycloak-local-proof`.

## Environment

- Keycloak image: `quay.io/keycloak/keycloak:24.0`
- Immutable digest: `sha256:f8ade94c1d0ad2f2fa7734a455fee5392764f402c43ca35e9af6bf63a2541dc9`
- Realm: `opnory` (enabled)
- Client: `opnory-api` (confidential; directAccessGrantsEnabled=true, serviceAccountsEnabled=true)
- Protocol mappers on `opnory-api`:
  - `groups` (oidc-group-membership-mapper): claim.name=`groups`, multivalued, full.path=false, access.token.claim=true
  - `audience-opnory-api` (oidc-audience-mapper): included.client.audience=`opnory-api`, access.token.claim=true
- Group: `opnory-platform-admins` → mapped to Opnory role `platform-admin`
- Test user: `test-admin` (enabled, emailVerified, requiredActions=[], non-temporary password credential), member of `opnory-platform-admins`
- Scratch client for the expired-token row: `opnory-expired-test` (access.token.lifespan=2s, same mappers)

## Resolved blockers from prior experimental state

1. `invalid_grant: Account is not fully set up` on password grant was NOT stale-credentials:
   Keycloak event log showed `error="resolve_required_actions"` despite
   `requiredActions=[]` on the user. Root cause: the user lacked
   `email`/`firstName`/`lastName` attributes, which Keycloak's default
   "Verify Profile" requirement treated as an incomplete account. Setting
   those three attributes on `test-admin` resolved the grant.
2. Group claim was emitted with full path (`/opnory-platform-admins`) and token
   audience lacked `opnory-api`. Fixed with the two mappers above.

## Token claim sample (user `test-admin`, sanitized)

```
{
  "iss": "http://localhost:8080/realms/opnory",
  "aud": ["opnory-api", "account"],
  "exp": <unix ts>,
  "sub": "09cd3e64-4d95-430b-a3ef-fbcb782b4a2b",
  "groups": ["opnory-platform-admins"]
}
```

Service-account token (`grant_type=client_credentials` on `opnory-api`): same
iss/aud, no `groups` claim — used for the "valid token, no role" row.

## Live HTTP matrix against the real Fastify API (`createApiServer` with OIDC config)

Server: `bun run ops/gate3-keycloak/live-api.ts` on `http://127.0.0.1:3001`,
issuer `http://localhost:8080/realms/opnory`, JWKS
`/realms/opnory/protocol/openid-connect/certs`, audience `opnory-api`,
roleGroupMap `{ "opnory-platform-admins": "platform-admin" }`.
Protected route under test: `GET /v1/access/requests/:id` (requires one of
platform-admin / access-approver / auditor-read-only).

| Case                                            | Status  | Body                                                                                                                                                                                    |
| ----------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /health, no token                           | **200** | `{"status":"ok",...}`                                                                                                                                                                   |
| protected, no token                             | **401** | `{"error":"Not authenticated"}`                                                                                                                                                         |
| protected, malformed token (`Bearer not.a.jwt`) | **401** | `{"error":"Token verification failed"}`                                                                                                                                                 |
| protected, expired token (2s lifespan, waited)  | **401** | `{"error":"Token expired"}`                                                                                                                                                             |
| protected, valid Keycloak token, NO role        | **403** | `{"error":"Required role not present (need one of: platform-admin, access-approver, auditor-read-only)"}`                                                                               |
| protected, valid Keycloak token, platform-admin | **404** | `{"error":"Access request not found"}` — **authorization passed, business handler reached** (the request ID is validly formed but does not exist, so the handler returned its own 404). |

## Crypto / OIDC boundary (Phase 5)

The proof exercises the production-shaped code path in `apps/api/src/auth/oidc.ts`:
Keycloak-issued RS256 JWT → remote JWKS lookup (jose `createRemoteJWKSet`)
against the live realm → signature verification → issuer match → audience match
→ expiration check → `groups` claim → Opnory role mapping → Fastify
authorization hook. The no-token row exercises the authentication boundary before JWT
verification. The malformed-token row exercises jose rejection of invalid
JWT input. The expired-token row uses a genuine Keycloak-issued JWT and
exercises expiration validation. The valid no-role and platform-admin rows
use genuine Keycloak-issued JWTs and reach role mapping only after
signature, issuer, audience, and expiry validation succeed. No locally
hand-signed tokens were used anywhere.

## Non-evidence (never captured)

No bearer tokens, Authorization headers, passwords, client secrets, Keycloak
database dumps, or private keys are present in this repository.
