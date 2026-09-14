# SEC-14 Dependabot Triage — 2026-09-13 (CORRECTED)

**Branch**: `feat/sec14-dependabot-triage`
**Related PR**: #6 (this PR — open, not merged)
**Correction**: This document **replaces** the prior version which contained fabricated version claims.
**Gate 2 status**: FROZEN @ `6077f30a` (untouched by this work)

---

## ⚠️ CORRECTION NOTICE

The original triage (committed `0d2f101d`) claimed `fastify@5.7.2` and `uuid@11.1.1` were installed. **This was factually incorrect.**

**Actual installed versions (verified via `bun pm ls --all`):**
| Package | Actual Version | Manifest Spec |
|---------|----------------|---------------|
| `fastify` | **4.28.1** (v4) | `^4.28.1` in `apps/api/package.json` |
| `uuid` (packages/agent) | **10.0.0** (transitive) | `^10.0.0` in `packages/agent/package.json` |
| `uuid` (packages/escalation) | **10.0.0** (transitive) | `^10.0.0` in `packages/escalation/package.json` |
| `uuid` (root) | **14.0.2** | resolved elsewhere in tree |

**Impact**: Every verdict in the original triage was inverted. This correction restores evidence integrity.

---

## Executive Summary (Corrected)

6 open Dependabot alerts analyzed. **6 VULNERABLE** (all alerts affect installed versions):

| Alert | Package | Severity | Installed | Advisory Range | Verdict |
|-------|---------|----------|-----------|----------------|---------|
| #1 | fastify | **HIGH** | 4.28.1 | `< 5.7.2` | **VULNERABLE** (Content-Type tab bypass) |
| #2 | fastify | LOW | 4.28.1 | `≤ 5.7.2` | **VULNERABLE** (sendWebStream DoS) |
| #3 | fastify | MEDIUM | 4.28.1 | `≤ 5.8.2` | **VULNERABLE** (request.protocol/host spoofing) |
| #6 | fastify | MEDIUM | 4.28.1 | `< 5.12.1` | **VULNERABLE** (schema validation bypass) |
| #4 | uuid | MEDIUM | 10.0.0 | `< 11.1.1` | **VULNERABLE** (buffer bounds check) |
| #5 | uuid | MEDIUM | 10.0.0 | `< 11.1.1` | **VULNERABLE** (buffer bounds check) |

**Remediation paths:**
- **Fastify**: 4→5 major migration (stale PR #1 proves breaking changes) OR verify Fastify 4.x backport exists
- **UUID**: Bump `packages/agent` + `packages/escalation` to `^11.1.1` (or align to `14.0.2` root resolution)

---

## Alert Inventory (from `gh api /repos/opnory/opnory/dependabot/alerts?state=open`)

| # | GHSA | Package | Sev | Manifest | Scope | Vuln Range | Patched | Installed | Verdict |
|---|------|---------|-----|----------|-------|------------|---------|-----------|---------|
| 1 | GHSA-jx2c-rxcm-jvmq | fastify | **HIGH** | apps/api/package.json | runtime | `< 5.7.2` | 5.7.2 | **4.28.1** | **VULNERABLE** |
| 2 | GHSA-mrq3-vjjr-p77c | fastify | LOW | apps/api/package.json | runtime | `≤ 5.7.2` | 5.7.3 | **4.28.1** | **VULNERABLE** |
| 3 | GHSA-444r-cwp2-x5xf | fastify | MEDIUM | apps/api/package.json | runtime | `≤ 5.8.2` | 5.8.3 | **4.28.1** | **VULNERABLE** |
| 6 | GHSA-w2qp-rph6-63g4 | fastify | MEDIUM | apps/api/package.json | runtime | `< 5.12.1` | 5.12.1 | **4.28.1** | **VULNERABLE** |
| 4 | GHSA-w5hq-g745-h8pq | uuid | MEDIUM | packages/escalation/package.json | runtime | `< 11.1.1` | 11.1.1 | **10.0.0** | **VULNERABLE** |
| 5 | GHSA-w5hq-g745-h8pq | uuid | MEDIUM | packages/agent/package.json | runtime | `< 11.1.1` | 11.1.1 | **10.0.0** | **VULNERABLE** |

---

## Reachability & Exploitability Analysis (Corrected)

### Fastify Alerts (apps/api — production HTTP ingress, v4.28.1)

| Alert | CVE-class | Reachability | Notes |
|-------|-----------|--------------|-------|
| **#1 (HIGH)** | Content-Type header tab character allows body validation bypass | **REACHABLE** — all JSON body parsing routes affected. 7 route handlers use Fastify schemas for validation. |
| **#2 (LOW)** | DoS via unbounded memory in `sendWebStream` | **LATENT** — `grep -r "sendWebStream\|reply.send.*stream" apps/api/src` returns zero call sites. |
| **#3 (MED)** | `request.protocol` / `request.host` spoofing via `X-Forwarded-Proto` / `X-Forwarded-Host` from untrusted connections | **REACHABLE** — `trustProxy: true` set in `apps/api/src/index.ts:30` **without allowlist**. Caddy → Fastify path (Gate 2) terminates TLS at Caddy, forwards to Fastify. Without explicit allowlist, spoofing is viable. |
| **#6 (MED)** | Schema validation bypass via root primitive coercion mismatch | **REACHABLE** — affects request body validation when root-level primitive coercion occurs. `apps/api` uses Fastify schemas at 7 route handlers. |

### UUID Alerts (packages/agent, packages/escalation — v10.0.0)

| Alert | CVE-class | Reachability | Notes |
|-------|-----------|--------------|-------|
| **#4, #5 (MED)** | Buffer bounds check in `v3/v5/v6` when `buf` parameter provided | **LATENT / DEV-ONLY** — both packages declare `uuid@^10.0.0` and resolve to `10.0.0` (vulnerable range `<11.1.1`). Exploitability requires calling `uuid.v3()`, `uuid.v5()`, or `uuid.v6()` **with a pre-allocated `buf`** argument. Code search (`grep -rn "uuid.v[356]" packages/agent/src packages/escalation/src`) returns **zero call sites**. Risk is latent (future misuse) not active. |

---

## Remediation Strategy — Two Independent Tracks

### Track A: Fastify (apps/api) — Major Migration Required

| Option | Assessment |
|--------|------------|
| **Minor bump within v4** | Check if Fastify released `4.29.x` with backported security fixes. If yes, lowest-risk path. |
| **Major migration 4→5** | **Stale PR #1 (`dependabot/npm_and_yarn/apps/api/fastify-5.12.1`) has CI FAILURE** — proves breaking changes. Fastify 5 breaking changes include: dropped Node <20 (Bun OK), `onSend`/`onResponse` payload mutation semantics, schema compiler changes, all `@fastify/*` plugins need compatible versions (`cors` 9→11+, `helmet` 11→13+, `rate-limit` 9→10+). Requires staged migration PR with full gate suite. |

**Evidence from stale PR #1 CI failure**: Must be read to catalog exact breaking changes before migration.

### Track B: UUID (packages/agent, packages/escalation) — Minor Bump

| Action | Impact |
|--------|--------|
| Bump `uuid` to `^11.1.1` in both package.json | Aligns with root `14.0.2` resolution; semver-minor within v11+; no breaking changes expected for typical `uuid.v4()` usage. |
| **Alternative**: align both to `^14.0.0` | If project policy prefers latest. |

---

## Lockfile Impact (Corrected)

| File | Current | Target | Impact |
|------|---------|--------|--------|
| `apps/api/package.json` | `fastify: "^4.28.1"` | `^5.12.1` (or patched 4.x) | **Major migration** — plugin alignment required |
| `packages/agent/package.json` | `uuid: "^10.0.0"` | `^11.1.1` | Minor bump (semver ^ permits) |
| `packages/escalation/package.json` | `uuid: "^10.0.0"` | `^11.1.1` | Minor bump (semver ^ permits) |

---

## SOC 2 Control Matrix Linkage (Corrected)

| Control | Current State | This Triage Updates |
|---------|---------------|---------------------|
| **SEC-14** (Vuln & patch mgmt) | PARTIAL (pinned digests proven; automated scanning not configured; no remediation SLA) | **Confirms PARTIAL with higher severity** — Dependabot detected 6 alerts; **all 6 VULNERABLE** (incl. 1 HIGH); remediation path = major migration for fastify; no SLA yet |
| **SEC-32** (Risk register) | PLANNED | **6 concrete entries** — all alerts with GHSA IDs, severity, reachability verdicts, remediation tracks |

---

## Stale Dependabot PR #1 Analysis Required

**PR #1**: `dependabot/npm_and_yarn/apps/api/fastify-5.12.1` — CI **FAILURE**

**Required action**: Extract failed CI logs to catalog fastify 4→5 breaking changes before any remediation attempt.

---

## Gate 2 Isolation Confirmation

- **Gate 2 branch**: `feat/observability-hardening-gate2-tls` @ `6077f30a3f89826230fea5a19b2a35efb8017a5a`
- **Gate 2 files**: `ops/observability-gate2/*` — **UNTOUCHED**
- **Gate 2 TLS proof**: **UNPROVEN** (forwards disabled, Caddy not deployed)
- This triage **does not modify** any Gate 2 artifact, config, or branch state.

---

## Cross-Link: SEC-14 Residual (Alert #3 Prerequisite)

The `trustProxy: true` **without allowlist** (SEC-14 alert #3, GHSA-444r-cwp2-x5xf) is a **prerequisite** for any OIDC/JWT strategy that trusts `X-Forwarded-*` headers.

| Current | Required Before Gate 3 Implementation |
|---------|----------------------------------------|
| `fastify({ trustProxy: true })` | `fastify({ trustProxy: ["127.0.0.1/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] })` — Caddy upstream (local compose network) |

This fix is independent of IdP choice and **must land before or with** any auth middleware. (Corrected in PR #7.)

---

## Next Actions (Per User-Declared Priority Order)

1. **Correct PR #6** ✅ (this commit)
2. **Analyze stale PR #1 CI failure** — catalog fastify 4→5 breaking changes
3. **Determine fastify remediation path** — patched 4.x exists? If not, plan staged 4→5 migration
4. **UUID bump** — `^11.1.1` in both packages (low risk, separate PR)
5. **SEC-14 remediation PR** — actual code changes with full gate suite
6. **Gate 3** — SSO/OIDC/MFA / admin controls (D-1 through D-6 still unanswered)
7. **Gate 2** — TLS proof (router port forwards disabled by user action)
8. **Gate 4** — Production KMS custody + backup/restore
9. **Gate 5** — HA / failover
10. **Gate 9** — Operational monitoring

---

## Artifacts

- Triage doc: `docs/security/sec-14-dependabot-triage-2026-09-13.md` (this file, corrected)
- SOC 2 matrix: `docs/security-soc2-readiness-control-matrix.md` (PR #5, open)
- Gate 3 design: `docs/security/gate3-sso-oidc-mfa-design.md` (PR #7, open, corrected)
- Lockfile: `bun.lock` (regenerated on remediation)

---

*Corrected by autonomous agent — prior version contained fabricated version claims (`fastify@5.7.2`, `uuid@11.1.1`). Actual versions verified via `bun pm ls --all`: `fastify@4.28.1`, `uuid@10.0.0` (agent/escalation). All 6 alerts VULNERABLE. Remediation is major migration for fastify, minor bump for uuid.*