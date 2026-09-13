# Gate 3 — SSO/OIDC/MFA Design & Readiness Assessment

## 1. Purpose & Non-Claims

This document captures the current-state evidence, architectural gap analysis, and **explicit user decisions required** before any implementation of SSO, OIDC, MFA, or admin access controls for Opnory.

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

## 4. Decision Matrix — USER INPUT REQUIRED

The following decisions **must be resolved by you** before any implementation. Do not proceed until each is answered.

### D-1: Identity Provider Choice

| Option | Pros | Cons | Operational Cost |
|--------|------|------|------------------|
| **Keycloak self-hosted** | Full control, no vendor lock-in, OIDC/SAML, MFA built-in | **High ops burden** (patching, HA, backups, TLS); solo-maintainer risk | HIGH — separate VM, DB, monitoring, upgrades |
| **Entra ID (Azure AD) OIDC** | Native if tenant exists, Conditional Access, PIM, phishing-resistant MFA | Vendor dependency; licensing for PIM/Conditional Access | LOW — managed SaaS |
| **Okta OIDC** | Mature OIDC, MFA, lifecycle mgmt | Vendor cost; separate from Entra fulfillment | MEDIUM — subscription cost |
| **Dual: Entra + Okta** | Matches existing dual-provider fulfillment model | Two IdPs to manage, sync, audit | HIGH |

**Recommendation**: **Entra ID OIDC** if Opnory tenant exists; aligns with existing Entra fulfillment adapter, single vendor for identity + fulfillment. **Keycloak only if air-gapped/on-prem requirement**.

### D-2: Enforcement Surface

| Option | Scope | Notes |
|--------|-------|-------|
| **apps/api only** | All `/v1/*` routes | Minimal surface; Grafana (Gate 2) stays separate |
| **apps/api + Grafana** | API + observability UI | Grafana OIDC config overlaps Gate 2 — requires **separate Gate 2 branch/PR** (not mutation of `6077f30a`) |
| **All public endpoints** | API + Grafana + future UI | Future-proof but wider blast radius |

**Recommendation**: **apps/api only** for Gate 3. Grafana OIDC is a Gate 2 enhancement on a *new* branch.

### D-3: Token Strategy

| Option | Mechanism | Revocation | Best For |
|--------|-----------|------------|----------|
| **OIDC ID Token passthrough** | Bearer token from IdP, validated via JWKS | IdP-controlled (short TTL) | Stateless API, microservices |
| **Session cookies + backend store** | HttpOnly cookie, server-side session | Immediate (delete session) | Traditional web apps, CSRF protection needed |
| **Opaque access tokens + introspection** | Token issued by IdP, validated via introspection endpoint | IdP-controlled | High-security, audit trail |

**Recommendation**: **OIDC ID Token passthrough (JWT Bearer)** — stateless, aligns with API-first architecture, `trustProxy: true` allowlist fix (SEC-14) ensures header integrity.

### D-4: MFA Enforcement Model

| Option | Enforcement Point | Phishing Resistance |
|--------|-------------------|---------------------|
| **IdP-enforced (recommended)** | Entra Conditional Access / Okta Adaptive MFA | WebAuthn/passkeys (phishing-resistant) |
| **Application-enforced** | App checks MFA claim in token | Requires app logic, less reliable |
| **TOTP only** | App or IdP | **Not phishing-resistant** |

**Recommendation**: **IdP-enforced WebAuthn/passkeys** — zero app code, highest assurance, meets SEC-02 "phishing-resistant MFA" intent.

### D-5: Break-Glass / Emergency Admin (SEC-03)

| Requirement | Proposed Design |
|-------------|-----------------|
| Sealed credential | Time-limited emergency admin token, stored in sealed envelope (Shamir split or physical safe) |
| Access path | Direct DB/API bypass via documented CLI, no OIDC dependency |
| Audit | Every break-glass use triggers alert + immutable audit log |
| Testing | Quarterly drill, evidence retained |

**Required for SOC 2**: Documented, tested, auditable break-glass — even for solo maintainer.

### D-6: Admin Role Model

| Question | Decision Needed |
|----------|-----------------|
| Single admin or multi-role? | `admin` vs `super-admin` vs `read-only-admin` |
| Role assignment | IdP group membership → role mapping |
| Lifecycle | JML via IdP (D-1) or manual? |

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

### 5.2 Fastify Middleware Sketch (Implementation Phase)

```typescript
// apps/api/src/auth/oauth2.ts — ONLY after user approves D-1 through D-6
import { fastify } from "fastify";
import fastifyOAuth2 from "@fastify/oauth2";

await server.register(fastifyOAuth2, {
  name: "entra",
  credentials: {
    client: { id: config.entra.clientId, secret: config.entra.clientSecret },
    auth: fastifyOAuth2.ENTRA_CONFIGURATION,
  },
  scope: ["openid", "profile", "email"],
  callbackUri: "https://api.opnory.com/auth/callback",
});

// Route guard
server.addHook("preHandler", async (request, reply) => {
  if (isPublicRoute(request.routeOptions.url)) return;
  const token = request.headers.authorization?.replace("Bearer ", "");
  if (!token) return reply.code(401).send({ error: "Unauthorized" });
  // Validate JWT via JWKS, check claims, extract roles
});
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
| `fastify({ trustProxy: true })` | `fastify({ trustProxy: ["127.0.0.1/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] })` — Caddy upstream (local compose network) |

This fix is independent of IdP choice and **must land before or with** any auth middleware.

---

## 10. Open Questions for User Decision

| ID | Question | Options | Your Decision |
|----|----------|---------|---------------|
| **D-1** | Identity Provider | Keycloak / Entra / Okta / Dual | |
| **D-2** | Enforcement Surface | API only / API+Grafana / All | |
| **D-3** | Token Strategy | JWT Bearer / Session cookies / Opaque introspection | |
| **D-4** | MFA Model | IdP WebAuthn / App-enforced / TOTP | |
| **D-5** | Break-Glass Design | Shamir split / Physical safe / HSM-sealed / Other | |
| **D-6** | Admin Role Model | Single admin / Multi-role / Read-only split | |

**Gate 3 implementation does not start until D-1 through D-6 are resolved.**

---

## 11. Next Actions (Post-Decision)

1. **Resolve D-1 through D-6** (user)
2. **Create implementation branch** (e.g., `feat/gate3-sso-impl`) from `main`
3. **Implement OIDC middleware** in `apps/api` per chosen strategy
4. **Add `trustProxy` allowlist** (SEC-14 remediation)
5. **Update Caddy** for `/auth/*` routes (new Gate 3 branch, not Gate 2)
6. **Run full gate suite** (`typecheck`, `lint`, `build`, `test`)
7. **Open PR** with live OIDC proof against `api.opnory.com` (requires Gate 2 TLS unblocked)
8. **SOC 2 matrix update** — upgrade SEC-01/02/03 with live evidence only

---

*Generated by autonomous design agent — no implementation performed. All decisions deferred to human. Gate 2 SHA verified unchanged at commit time.*