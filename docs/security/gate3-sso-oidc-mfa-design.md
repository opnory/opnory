# Gate 3 — SSO/OIDC/MFA Design & Readiness Assessment

## 1. Purpose & Non-Claims

This document captures the current-state evidence, architectural gap analysis, and the **user decisions locked 2026-09-13** governing SSO, OIDC, MFA, or admin access controls for Opnory.

**Non-claims (mandatory):**
- No SSO/OIDC/MFA implementation exists or is claimed in this document
- No SOC 2 control upgrades (SEC-01/02/03 remain PLANNED/UNPROVEN)
- No Gate 2 modification — `feat/observability-hardening-gate2-tls` @ `6077f30a` untouched
- No production-readiness claim — Gate 3 is a design baseline only

---

## 2. Current-State Inventory (Evidence-Cited)

### 2.1 `apps/api` — Public HTTP Ingress (ZERO Auth Middleware)

| File | Line | Finding |
|------|------|---------|
| `apps/api/src/index.ts` | 22-30 | `fastify({ trustProxy: true })` — **no allowlist**, spoofing viable (SEC-14 alert #3) |
| `apps/api/src/index.ts` | 33 | `cors({ origin: true })` — **wide open**, no origin validation |
| `apps/api/src/index.ts` | 34-37 | Only plugins: `helmet`, `cors`, `rateLimit` — **no `@fastify/auth`, `@fastify/jwt`, `@fastify/session`, `@fastify/oauth2`** |
| `apps/api/src/index.ts` | 40-580 | ~10 routes registered: `/health`, `/v1/support/requests`, `/v1/slack/commands`, `/v1/access/requests*`, `/v1/access/requests/:id/approve`, `/v1/access/requests/:id/deny`, `/v1/access/requests/:id/audit` — **all bare**, no auth guards |

**Routes exposed without any authentication:**
| Method | Path | Mutating | Risk if unauthenticated |
|--------|------|----------|-------------------------|
| GET | `/health` | No | Low (info disclosure) |
| POST | `/v1/support/requests` | Yes | Agent processing, potential data exfil |
| POST | `/v1/slack/commands` | Yes | Slack command injection, agent processing |
| POST | `/v1/access/requests` | Yes | **Create access requests** (entitlement provisioning trigger) |
| GET | `/v1/access/requests/:id` | No | Access request enumeration |
| POST | `/v1/access/requests/:id/approve` | **Yes** | **Approve entitlement grants** (fulfillment trigger) |
| POST | `/v1/access/requests/:id/deny` | **Yes** | Deny/block entitlement requests |
| GET | `/v1/access/requests/:id/audit` | No | Audit trail enumeration |

### 2.2 `packages/agent` — Agent Runtime

| Finding | Evidence |
|---------|----------|
| Zero auth-relevant code | `grep -rn "auth\|oidc\|jwt\|session\|token\|mfa" packages/agent/src --include="*.ts"` → **empty** |
| No identity/session handling | Agent processes `NormalizedRequest` (workspaceId, userId, channelId, text) — no token validation |

### 2.3 `packages/access-service` — Authorization Layer (NOT Authentication)

| File | Line | Finding |
|------|------|---------|
| `packages/access-service/src/index.ts` | 463-464 | `auditUnauthorizedApprovalAttempt()` — logs unauthorized approval attempts |
| `packages/access-service/src/acceptance.test.ts` | Multiple | `GovernanceAuthority = "entra" | "okta"` — **external provider authority for approval**, not admin identity |
| Tests | — | Prove **authority separation**: approval decisions rejected if wrong external authority |

**Critical distinction**: `GovernanceAuthority` = *which IdP fulfills the entitlement* (Entra vs Okta group membership). This is **fulfillment authorization**, not **admin authentication**. Do not conflate.

### 2.4 Dependency Scan — No Auth Libraries Present

| Manifest | Auth-relevant deps |
|----------|-------------------|
| `package.json` (root) | `@octokit/auth-app` (GitHub App auth for fulfillment, not admin) |
| `apps/api/package.json` | None |
| `packages/agent/package.json` | None |
| `packages/access-service/package.json` | None |
| `packages/governance-core/package.json` | None |
| `packages/config/package.json` | None |
| `packages/types/package.json` | None |

---

## 3. Gap Analysis vs. SOC 2 Control Matrix

| Control | Current State | Required for PROVEN |
|---------|---------------|---------------------|
| **SEC-01** Identity & authentication | **UNPROVEN** — no authN anywhere | OIDC RP implemented, session/JWT validation on all mutating routes |
| **SEC-02** MFA for privileged/admin | **UNPROVEN** — no MFA concept | IdP-enforced phishing-resistant MFA (WebAuthn/passkeys) |
| **SEC-03** Privileged access / least privilege | **PLANNED** — no admin model | Break-glass procedure, sealed credential, role-based admin access |
| **SEC-04** Joiner-mover-leaver lifecycle | **PLANNED** — no admin lifecycle | Automated provisioning/deprovisioning via IdP |
| **SEC-05** Periodic access review | **PLANNED** — no review process | Quarterly access certification, evidence retained |

**Already IMPLEMENTED/PARTIAL (not Gate 3 scope):**
- **SEC-07** Authorization decision boundaries — `access-service` + `GovernanceAuthority` model
- **SEC-08** Provider-ID / policy-boundary integrity — fulfillment adapters enforce mapping isolation

---

## 4. Decision Matrix — DECISIONS LOCKED 2026-09-13

The following decisions were **resolved by the user on 2026-09-13** and are now locked. No further input is required before implementation.

### D-1: Identity Provider Choice — RESOLVED

**Decision**: **Entra ID first**, behind a **provider-neutral OIDC configuration boundary**. Do not let Entra-specific identifiers/claims leak into Opnory authorization domain logic. Keycloak remains useful for local/offline proof, not as the production default.

| Option | Pros | Cons | Operational Cost |
|--------|------|------|------------------|
| **Keycloak self-hosted** | Full control, no vendor lock-in, OIDC/SAML, MFA built-in | **High ops burden** (patching, HA, backups, TLS); solo-maintainer risk | HIGH — separate VM, DB, monitoring, upgrades |
| **Entra ID (Azure AD) OIDC** | Native if tenant exists, Conditional Access, PIM, phishing-resistant MFA | Vendor dependency; licensing for PIM/Conditional Access | LOW — managed SaaS |
| **Okta OIDC** | Mature OIDC, MFA, lifecycle mgmt | Vendor cost; separate from Entra fulfillment | MEDIUM — subscription cost |
| **Dual: Entra + Okta** | Matches existing dual-provider fulfillment model | Two IdPs to manage, sync, audit | HIGH |

**Constraint**: All OIDC integration code must use a **provider-neutral configuration layer** (issuer URL, client ID/secret, JWKS endpoint, scope mapping). Entra-specific claims (e.g., `tid`, `oid`, `groups` with Entra object IDs) must be mapped to Opnory-native identifiers at the boundary before entering any authorization logic.

### D-2: Enforcement Surface — RESOLVED

**Decision**: **API first**, with route-specific authentication. `/health` may remain narrowly public; Slack ingress uses Slack signature verification; mutating `/v1/access/*` routes require authenticated identity + role authorization. Grafana OIDC should be a separate Gate 3 hardening change.

| Option | Scope | Notes |
|--------|-------|-------|
| **apps/api only** (SELECTED) | All `/v1/*` routes | Minimal surface; Grafana (Gate 2) stays separate |
| **apps/api + Grafana** | API + observability UI | Grafana OIDC config overlaps Gate 2 — requires **separate Gate 2 branch/PR** (not mutation of `6077f30a`) |
| **All public endpoints** | API + Grafana + future UI | Future-proof but wider blast radius |

**Constraint**: Grafana OIDC is a **separate Gate 3 hardening change** on a new branch (e.g., `feat/gate3-grafana-oidc`), not part of the core API authentication implementation.

### D-3: Token Strategy — RESOLVED

**Decision**: **JWT Bearer access tokens** (NOT OIDC ID tokens), validated locally via issuer/JWKS/audience/signature/expiry.

| Option | Mechanism | Revocation | Best For |
|--------|-----------|------------|----------|
| **JWT Bearer access tokens** (SELECTED) | Access token from IdP, validated via JWKS (issuer, audience, signature, expiry) | IdP-controlled (short TTL) | Stateless API, microservices; explicit audience scoping |
| Session cookies + backend store | HttpOnly cookie, server-side session | Immediate (delete session) | Traditional web apps, CSRF protection needed |
| Opaque access tokens + introspection | Token issued by IdP, validated via introspection endpoint | IdP-controlled | High-security, audit trail |

**Rationale**: OIDC ID tokens are for authentication context, not API authorization. Access tokens carry scopes/audiences; validation is local (no introspection round-trip); JWT structure allows stateless verification with rotating JWKS.

### D-4: MFA Enforcement Model — RESOLVED

**Decision**: **IdP-enforced WebAuthn/passkeys**, with phishing-resistant MFA required for privileged/admin identities. Do not build TOTP MFA into Opnory.

| Option | Enforcement Point | Phishing Resistance |
|--------|-------------------|---------------------|
| **IdP-enforced WebAuthn/passkeys** (SELECTED) | Entra Conditional Access | WebAuthn/passkeys (phishing-resistant) |
| Application-enforced | App checks MFA claim in token | Requires app logic, less reliable |
| TOTP only | App or IdP | **Not phishing-resistant** |

**Rationale**: WebAuthn/passkeys provide cryptographic phishing resistance. Entra Conditional Access can enforce WebAuthn for all privileged/admin identities. Zero application code required; IdP handles credential registration, attestation, and policy.

### D-5: Break-Glass / Emergency Admin (SEC-03) — RESOLVED

**Decision**: **Physical-safe model initially**, evolving to HSM/sealed custody in Gate 4. **Do not** implement "direct DB/API bypass" as the normal break-glass design. Use **dedicated emergency identities/credentials** that flow through normal Opnory authorization (audited, time-limited), not bypassing it.

| Requirement | Locked Design |
|-------------|---------------|
| Credential custody | Physical-safe initially (Shamir split or sealed envelope) → HSM/sealed in Gate 4 |
| Access path | **Dedicated emergency identities/credentials** — normal Opnory authorization flow, tightly monitored, time-limited, NOT DB/API bypass |
| Audit | Every break-glass use triggers alert + immutable audit log |
| Testing | Quarterly drill, evidence retained |

**Required for SOC 2**: Documented, tested, auditable break-glass — even for solo maintainer.

### D-6: Admin Role Model — RESOLVED

**Decision**: **Multi-role with explicit read-only split**. Minimum model: `platform-admin`, `access-approver`, and `auditor/read-only`. One human may hold multiple roles while Opnory is solo-maintained, but the permissions must remain structurally separated.

| Role | Scope | Typical IdP Group |
|------|-------|-------------------|
| **platform-admin** | Full Opnory control: manage tenants, integrations, config, break-glass | `opnory-platform-admins` |
| **access-approver** | Approve/deny access requests; read audit trails | `opnory-access-approvers` |
| **auditor/read-only** | Read-only access to requests, audit, config; no mutations | `opnory-auditors` |

**Constraint**: Role assignment via IdP group membership → Opnory role mapping. No wildcard/admin-by-default. Token validation extracts groups, maps to Opnory roles, enforces per-route.

---

## 5. Proposed Architecture (Conditional on Decisions Above)

### 5.1 Recommended Stack (if Entra ID chosen)

```
Internet
   │
   ▼
Cloudflare DNS (DNS-only A record: api.opnory.com)
   │
   ▼
Router/NAT → Dedicated Linux VM (same as Gate 2)
   │
   ▼
Caddy (TLS termination, HTTPS only)
   │
   ▼
apps/api (Fastify) ← OIDC middleware validates JWT from Entra
   │
   ├── /health                    → public (no auth)
   ├── /v1/support/requests       → auth required (agent user)
   ├── /v1/slack/commands         → Slack signature verification (separate)
   └── /v1/access/requests*       → auth required + admin role (approval)
```

### 5.2 Fastify Middleware Sketch (Implementation Phase — Conditional on D-3: JWT Bearer Access Tokens)

```typescript
// apps/api/src/auth/jwt-bearer.ts — ONLY after decisions locked (2026-09-13)
// Validates JWT Bearer ACCESS TOKENS (not OIDC ID tokens) via local JWKS verification
import { fastify } from "fastify";
import fastifyJwt from "@fastify/jwt";
import jwksClient from "jwks-rsa";

const client = jwksClient({
  jwksUri: config.entra.jwksUri, // e.g., https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys
  cache: true,
  rateLimit: true,
});

function getKey(header: any, callback: any) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

await server.register(fastifyJwt, {
  secret: getKey, // dynamic key lookup via JWKS
  verify: {
    issuer: config.entra.issuer,       // required: validate iss
    audience: config.entra.audience,   // required: validate aud
    maxAge: "15m",                     // required: validate exp
  },
});

// Route guard — applies to all routes except explicitly public ones
server.addHook("preHandler", async (request, reply) => {
  if (isPublicRoute(request.routeOptions.url)) return;
  try {
    const payload = await request.jwtVerify();
    // Map Entra groups claim → Opnory roles (platform-admin, access-approver, auditor/read-only)
    request.user = mapEntraGroupsToOpnoryRoles(payload);
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// Public routes (explicit allowlist, not implicit deny)
function isPublicRoute(url: string): boolean {
  return url === "/health" ||
         url === "/v1/slack/commands"; // Slack signature verified separately
}

// Slack ingress uses Slack signature verification (separate middleware)
```

---

## 6. Prerequisites & Dependencies

| Prereq | Status | Notes |
|--------|--------|-------|
| **Gate 2 TLS proof (UNPROVEN)** | **BLOCKER for live OIDC** | OIDC redirect_uri needs valid TLS hostname (`api.opnory.com`). Gate 2 forwards still disabled. |
| **SEC-14 `trustProxy` allowlist** | **PREREQ regardless of D-1** | Fastify `trustProxy: true` must have explicit Caddy upstream allowlist (local compose network, no Cloudflare proxy) before any auth header trust |
| **Entra tenant / Okta org** | Not confirmed | Must exist before implementation |
| **Domain `api.opnory.com`** | Not created | Cloudflare DNS-only A record needed |

---

## 7. SOC 2 Linkage — Status Preservation

| Control | Current | After Design Doc | After Implementation + Live Proof |
|---------|---------|------------------|-----------------------------------|
| SEC-01 | PLANNED | PLANNED | PROVEN (with retained evidence) |
| SEC-02 | UNPROVEN | PLANNED | PROVEN (IdP MFA config + test) |
| SEC-03 | PLANNED | PLANNED | PROVEN (break-glass tested + documented) |
| SEC-04 | PLANNED | PLANNED | IMPLEMENTED (if IdP JML) |
| SEC-05 | PLANNED | PLANNED | IMPLEMENTED (if quarterly review runs) |

**No status upgrades from this document alone.**

---

## 8. Gate 2 Isolation Statement

- **Gate 2 branch**: `feat/observability-hardening-gate2-tls` @ `6077f30a3f89826230fea5a19b2a35efb8017a5a`
- **Gate 2 files**: `ops/observability-gate2/*` — **UNTOUCHED**
- **Grafana OIDC** — If desired, lands on a **new branch** (e.g., `feat/gate3-grafana-oidc`) with PR against `main`, **not** a mutation of the frozen `6077f30a`
- **Caddy config** — Any new routes (`/auth/*`, `/callback`) added on Gate 3 branch, tested against Gate 2 stack locally

---

## 9. Cross-Link: SEC-14 Residual (Alert #3)

The `trustProxy: true` **without allowlist** (SEC-14 alert #3, GHSA-444r-cwp2-x5xf) is a **prerequisite** for any OIDC/JWT strategy that trusts `X-Forwarded-*` headers.

| Current | Required Before Gate 3 Implementation |
|---------|----------------------------------------|
| `fastify({ trustProxy: true })` | `fastify({ trustProxy: ["127.0.0.1", "172.16.0.0/12"] })` — exact Caddy upstream (container network) only |

**Rationale**: The Fastify advisory specifically recommends an IP/CIDR/custom trust predicate that validates the connecting address and ensures the origin cannot be reached around the proxy. Trusting all RFC1918 space (`10/8`, `172.16/12`, `192.168/16`) is **too broad** for a hardened deployment. Only the **actual Caddy source IP/subnet** (Docker compose network) should be trusted. This is the minimal trust boundary that satisfies the advisory while maintaining security.

This fix is independent of IdP choice and **must land before or with** any auth middleware.

---

## 10. Decisions Locked (2026-09-13)

| ID | Decision | Final Selection |
|----|----------|-----------------|
| **D-1** | Identity Provider | **Entra ID first**, provider-neutral OIDC boundary; Keycloak for local/offline proof only |
| **D-2** | Enforcement Surface | **API first** (`apps/api` only); `/health` narrowly public; Slack signature verification; `/v1/access/*` auth + role; Grafana OIDC on separate branch |
| **D-3** | Token Strategy | **JWT Bearer access tokens** validated locally (issuer/JWKS/audience/signature/expiry); **NO OIDC ID token passthrough** |
| **D-4** | MFA Model | **IdP-enforced WebAuthn/passkeys** (phishing-resistant); no app-built TOTP |
| **D-5** | Break-Glass Design | **Physical-safe model initially** → HSM/sealed in Gate 4; **dedicated emergency identities**, NOT DB/API bypass |
| **D-6** | Admin Role Model | **Multi-role with read-only split**: `platform-admin`, `access-approver`, `auditor/read-only`; solo maintainer may hold multiple, permissions structurally separated |

**Implementation is now unblocked** per the agreed sequencing: UUID PR → Fastify v5 staged migration + `@fastify/*` plugins → exact Caddy `trustProxy` + restrictive CORS → Gate 3 Entra/JWT/WebAuthn/multi-role implementation → local negative/authz proof → only then deliberately reopen Gate 2 ingress for TLS/OIDC live proof.

---

## 11. Next Actions (Post-Decision)

1. **Decisions locked 2026-09-13** (see §10)
2. **Create implementation branch** (e.g., `feat/gate3-sso-impl`) from `main`
3. **Implement JWT Bearer access-token validation** in `apps/api` per locked D-3 strategy
4. **Add `trustProxy` allowlist** (SEC-14 remediation)
5. **Update Caddy** for `/auth/*` routes (new Gate 3 branch, not Gate 2)
6. **Run full gate suite** (`typecheck`, `lint`, `build`, `test`)
7. **Open PR** with live OIDC proof against `api.opnory.com` (requires Gate 2 TLS unblocked)
8. **SOC 2 matrix update** — upgrade SEC-01/02/03 with live evidence only

---

*Generated by autonomous design agent — no implementation performed. All decisions deferred to human. Gate 2 SHA verified unchanged at commit time.*