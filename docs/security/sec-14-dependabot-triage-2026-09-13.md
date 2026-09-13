# SEC-14 Dependabot Triage — 2026-09-13

**Branch**: `feat/security-soc2-readiness-control-matrix`
**Related PR**: #5 (SOC 2 Readiness Control Matrix — open, not merged)
**Gate 2 status**: FROZEN @ `6077f30a` (untouched by this work)

---

## Executive Summary

6 open Dependabot alerts analyzed. **3 actionable vulnerabilities** confirmed (all `fastify` in `apps/api` production HTTP ingress). **3 alerts are false positives** — patched floor already satisfied by current lockfile (`fastify@5.7.2`, `uuid@11.1.1`).

Remediation: single `fastify` bump to **≥5.12.1** in `apps/api` resolves all 3 actionable alerts.

---

## Alert Inventory (from `gh api /repos/opnory/opnory/dependabot/alerts?state=open`)

| # | GHSA | Package | Sev | Manifest | Scope | Vuln Range | Patched | Installed | Verdict |
|---|------|---------|-----|----------|-------|------------|---------|-----------|---------|
| 1 | GHSA-jx2c-rxcm-jvmq | fastify | **HIGH** | apps/api/package.json | runtime | `< 5.7.2` | 5.7.2 | **5.7.2** | **FALSE POSITIVE** (fixed floor) |
| 2 | GHSA-mrq3-vjjr-p77c | fastify | LOW | apps/api/package.json | runtime | `≤ 5.7.2` | 5.7.3 | **5.7.2** | **VULNERABLE** |
| 3 | GHSA-444r-cwp2-x5xf | fastify | MEDIUM | apps/api/package.json | runtime | `≤ 5.8.2` | 5.8.3 | **5.7.2** | **VULNERABLE** |
| 6 | GHSA-w2qp-rph6-63g4 | fastify | MEDIUM | apps/api/package.json | runtime | `< 5.12.1` | 5.12.1 | **5.7.2** | **VULNERABLE** |
| 4 | GHSA-w5hq-g745-h8pq | uuid | MEDIUM | packages/escalation/package.json | runtime | `< 11.1.1` | 11.1.1 | **11.1.1** | **FALSE POSITIVE** (fixed floor) |
| 5 | GHSA-w5hq-g745-h8pq | uuid | MEDIUM | packages/agent/package.json | runtime | `< 11.1.1` | 11.1.1 | **11.1.1** | **FALSE POSITIVE** (fixed floor) |

---

## Reachability & Exploitability Analysis

### Fastify Alerts (apps/api — production HTTP ingress)

| Alert | CVE-class | Reachability | Notes |
|-------|-----------|--------------|-------|
| **#2 (LOW)** | DoS via unbounded memory in `sendWebStream` | **REACHABLE** if `apps/api` uses `sendWebStream` / `reply.send(stream)` patterns. Fastify web streams are used for streaming responses; confirm via `grep -r "sendWebStream\|reply.send.*stream" apps/api/src`. |
| **#3 (MED)** | `request.protocol` / `request.host` spoofing via `X-Forwarded-Proto` / `X-Forwarded-Host` from untrusted connections | **REACHABLE** unless `apps/api` configures `trustProxy: true` **and** a trusted proxy list (e.g., Cloudflare IP ranges). Current Caddy → Fastify path (Gate 2) terminates TLS at Caddy, forwards to Fastify. If Caddy does not set trusted headers or Fastify does not validate proxy trust chain, spoofing is viable. |
| **#6 (MED)** | Schema validation bypass via root primitive coercion mismatch | **REACHABLE** — affects request body validation when root-level primitive coercion occurs. `apps/api` uses Fastify schemas for request validation; this bypass could allow malformed input to reach route handlers. |

> **Alert #1 (HIGH)** — Content-Type tab character body validation bypass: **NOT VULNERABLE**. Patched floor is `5.7.2` (exact version installed). The advisory range is `< 5.7.2` (strict).

### UUID Alerts (packages/agent, packages/escalation)

| Alert | CVE-class | Reachability | Notes |
|-------|-----------|--------------|-------|
| **#4, #5 (MED)** | Buffer bounds check in `v3/v5/v6` when `buf` parameter provided | **LATENT / DEV-ONLY** — both packages declare `uuid@^11.1.1` and lockfile resolves to `11.1.1` (patched floor). Exploitability requires calling `uuid.v3()`, `uuid.v5()`, or `uuid.v6()` **with a pre-allocated `buf`** argument. Code search (`grep -rn "uuid.v[356]" packages/agent/src packages/escalation/src`) returns **zero call sites**. Risk is latent (future misuse) not active. |

---

## Lockfile Impact

| File | Current | Target | Impact |
|------|---------|--------|--------|
| `apps/api/package.json` | `fastify: "^5.7.2"` | `fastify: "^5.12.1"` | Minor bump (semver ^ permits); `bun install` regenerates `bun.lock` |
| `packages/escalation/package.json` | `uuid: "^11.1.1"` | (no change) | Already at patched floor |
| `packages/agent/package.json` | `uuid: "^11.1.1"` | (no change) | Already at patched floor |

**No breaking changes expected** — Fastify 5.x minor releases are backward-compatible per their release notes. UUID bump already satisfied.

---

## Test & Gate Impact

| Gate | Command | Expected |
|------|---------|----------|
| Typecheck | `bun run typecheck` | PASS (no TS API surface change in fastify 5.7→5.12) |
| Lint | `bun run lint` | PASS (0 errors) |
| Build | `bun run build` | PASS |
| Tests | `bun test` | 343 tests PASS |
| Full CI | GitHub Actions `build-test` | SUCCESS |

---

## SOC 2 Control Matrix Linkage

| Control | Current State | This Triage Updates |
|---------|---------------|---------------------|
| **SEC-14** (Vuln & patch mgmt) | PARTIAL (pinned digests proven; automated scanning not configured; no remediation SLA) | **Confirms PARTIAL** — automated scanning (Dependabot) detected 6 alerts; 3 actionable; remediation path defined; no SLA yet |
| **SEC-32** (Risk register) | PLANNED | **First concrete entries** — 3 tracked risks with GHSA IDs, severity, reachability verdicts, remediation targets |

---

## Remediation Plan (User Decision Required)

| Option | Action | Rationale |
|--------|--------|-----------|
| **A (Recommended)** | Bump `fastify` to `^5.12.1` in `apps/api/package.json`; `bun install`; full gate suite; commit on `chore/security-s14-fastify-bump` | Single bump resolves all 3 actionable alerts; minor semver; no uuid change needed |
| **B** | Defer; document compensating controls (WAF rules, input validation hardening in `apps/api`) | Only if Gate 2 TLS proof / Gate 3 SSO work has absolute priority and fastify upgrade risks regression |

> **No PR opened in this session** — triage is the deliverable. Remediation branch/PR is a separate, user-directed step.

---

## Gate 2 Isolation Confirmation

- **Gate 2 branch**: `feat/observability-hardening-gate2-tls` @ `6077f30a3f89826230fea5a19b2a35efb8017a5a`
- **Gate 2 files**: `ops/observability-gate2/*` — **UNTOUCHED**
- **Gate 2 TLS proof**: **UNPROVEN** (forwards disabled, Caddy not deployed)
- This triage **does not modify** any Gate 2 artifact, config, or branch state.

---

## Next Actions (Per User-Declared Priority Order)

1. **SEC-14 remediation** → `fastify` bump on dedicated branch (if Option A chosen)
2. **Gate 3** — SSO/OIDC/MFA / admin controls (unblocks SEC-01/02/03)
3. **Gate 2** — TLS proof (re-enable 80/443 → Caddy ACME → `verify-tls.sh` from external)
4. **Gate 4** — Production KMS custody + backup/restore automation
5. **Gate 5** — HA / failover design & proof
6. **Gate 9** — Operational monitoring / alerting

---

## Artifacts

- Triage doc: `docs/security/sec-14-dependabot-triage-2026-09-13.md` (this file)
- SOC 2 matrix: `docs/security-soc2-readiness-control-matrix.md` (PR #5, open)
- Lockfile: `bun.lock` (regenerated on remediation)

---

*Generated by autonomous triage agent — no human review of findings performed. All verdicts based on lockfile-resolved versions and static reachability heuristics. Confirm reachability via code search before production deployment.*