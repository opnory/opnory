# Opnory Security & SOC 2 Readiness Control Matrix

## 1. Purpose

This document maps Opnory's existing engineering security evidence into a coherent control matrix aligned with the AICPA Trust Services Criteria (TSC). It is a **readiness and control mapping artifact**, not a SOC 2 examination report. A SOC 2 report requires an independent CPA examination performed under AT-C 205/SSAE 18. This document organizes evidence so that a future CPA can efficiently trace controls to artifacts; it does **not** assert compliance, certification, Type I, or Type II status.

## 2. Scope and Non‑Claims

| In Scope | Out of Scope / Explicit Non‑Claims |
|----------|------------------------------------|
| Security Trust Services Category (baseline) | SOC 2 compliant / certified / Type I / Type II completed |
| Availability (evaluated selectively where justified) | Production readiness claimed |
| Confidentiality (evaluated selectively where justified) | Controls proven where only implementation/planning exists |
| Opnory monorepo: governance-core, integration-runtime, observability stacks, fulfillment adapters, static governance, secrets, ADRs | General IAM compliance certification beyond exercised evidence |
| Engineering evidence: frozen gates, verifiers, static governance, secret backend, ADRs | HA / production-class durability claims |
| Frozen Gate 2 branch `feat/observability-hardening-gate2-tls` at commit `6077f30a` | Global static-governance enforcement |
| Bridged LAN networking proof (`192.168.1.179/24` lease, distinct MAC, Fios gateway, outbound connectivity, Mac↔VM reachability) | KMS/HSM key custody for production |
| Gate 2 TLS evidence: **UNPROVEN** (temporary listeners removed, WAN forwards disabled) | SOC 2 report / examination opinion |

**Production hardening gates** referenced in the matrix correspond to the named sequence:
1. Object storage (SeaweedFS)
2. TLS (Caddy → Grafana)
3. SSO/auth/authz (Keycloak/OIDC)
4. Backup + restore
5. HA
6. Capacity/load
7. Upgrade/rollback
8. Failure recovery
9. Production monitoring

Gates beyond #2 remain **UNPROVEN** or **PLANNED** unless otherwise stated.

## 3. Evidence / Status Vocabulary

| Status | Definition |
|--------|------------|
| **PROVEN** | Exercised with retained evidence artifacts (logs, verifier output, attested digests, immutable commit references). The exercised scenario is documented and reproducible. |
| **IMPLEMENTED** | Implementation exists in code/config; required operating evidence (logs, automated test runs, retained output) is incomplete or not yet retained. |
| **PARTIAL** | Control exists with known gaps (e.g., scope limited to subset, dependency on manual step, missing automation). |
| **PLANNED** | Approved/intended but not implemented. Design may exist; no code or config deployed. |
| **UNPROVEN** | Implementation or required proof has not been established. No retained evidence. |
| **N/A** | Deliberately out of scope for this control with documented rationale. |

Only these six terms appear in the **Current Status** column of the matrix.

## 4. Trust Services Category Scoping

| TSC Category | Inclusion | Rationale |
|--------------|-----------|-----------|
| **Security** | Baseline (all applicable controls) | Authorization/governance control plane handles sensitive identity and entitlement data; Security is the load-bearing category. |
| **Availability** | Evaluated selectively | Gates 4–9 (backup, HA, capacity, upgrade/rollback, failure recovery, monitoring) are largely UNPROVEN/PARTIAL. Only SEC‑21/22/26 have partial evidence. |
| **Confidentiality** | Evaluated selectively | Tenant isolation (SEC‑06), secrets (SEC‑09/10), encryption (SEC‑11/12), redaction/hashing vocabulary are relevant and partially evidenced. |
| **Processing Integrity** | N/A | Not applicable to the current control plane scope; no transaction processing or data transformation claims. |
| **Privacy** | N/A | No personal data processing scope defined; Opnory processes identity/entitlement metadata, not PII per GDPR/CCPA definitions. |

TSC associations in the matrix are **proposed/evaluated relevance**, not satisfied criteria assertions.

## 5. Control Ownership Model

| Role | Responsibility |
|------|----------------|
| **Engineering Lead** | Architecture, implementation, verifier maintenance, ADR authorship |
| **Security Lead** | Risk register, policy governance, vendor review, incident response planning |
| **Platform / Infra** | VM/container hardening, network policy, backup/restore exercises, vulnerability scanning |
| **Product / Governance** | Access review cadence, tenant isolation policy, authorization boundary definitions |
| **Documentation** | Evidence retention, review cadence, ADR indexing, control matrix updates |

Ownership in the matrix is the **primary accountable role**; execution may be shared.

## 6. Security & SOC 2 Readiness Control Matrix

| Control ID | Control Objective / Risk Addressed | Owner | Implementation | Evidence Artifact | Automated / Manual Test | Frequency | Current Status | Gap / Next Action | SOC 2 TSC | Production Gate / ADR Linkage |
|------------|-----------------------------------|-------|----------------|-------------------|-------------------------|-----------|----------------|-------------------|-----------|-------------------------------|
| **SEC‑01** | Identity and authentication: unique identities for all human/admin access; no shared credentials | Engineering Lead | Local user accounts; no SSO/OIDC yet; Gate 3 PLANNED | None (Gate 3) | N/A | Continuous | **PLANNED** | Gate 3: implement OIDC/SSO + MFA for all admin access | Security (CC6.1) | Gate 3 |
| **SEC‑02** | MFA for privileged/admin access: hardware or TOTP required for all admin sessions | Security Lead | None (Gate 3) | None (Gate 3) | N/A | Continuous | **PLANNED** | Gate 3: enforce MFA for all privileged access; CISA recommends MFA for remote/privileged | Security (CC6.1, CC6.2) | Gate 3 |
| **SEC‑03** | Privileged access / least privilege: admin roles scoped, break‑glass documented, no standing root | Engineering Lead | `sudoers` for Lima VM (wheel/admin scoped); StaticTestKeyProvider proof‑only; production KMS UNPROVEN | `docs/architecture/adr/0011-solo-maintainer-branch-protection.md`; `ops/self-hosted-seaweedfs/s3.bootstrap.json.example` (Admin) vs `s3.runtime.json.example` (Tempo) | Manual review of sudoers/key configs | Quarterly | **PARTIAL** | Break‑glass account documentation; production KMS/HSM custody; admin role definitions | Security (CC6.1, CC6.2, CC6.3) | Gate 3, ADR 0011 |
| **SEC‑04** | Joiner‑mover‑leaver lifecycle: automated provisioning/deprovisioning of identities and access | Product / Governance | Governance engine fulfills across Entra/Okta/GitHub/SCIM; provider adapters live‑certified | `packages/governance-core/src/adapters/fulfillment.ts` (frozen); live conformance `bun run live:entra` / `live:okta` | Live conformance harness (Entra 5/5, Okta 3/3 fixtures) | Per change / quarterly | **PROVEN** (dual‑provider live conformance) | Document JML workflow; integrate HR trigger | Security (CC6.1, CC6.2) | Gate 1 (object storage not required) |
| **SEC‑05** | Periodic access review: quarterly certification of privileged/admin access | Security Lead | Not implemented | None | N/A | Quarterly | **PLANNED** | Implement access review workflow with evidence retention | Security (CC6.1, CC6.7) | Gate 3 |
| **SEC‑06** | Tenant isolation: logical and cryptographic separation of tenant data in governance and observability | Engineering Lead | Opnory identifiers only in policy/domain; provider IDs only in `Permission.mappings[]`; tenant hashing in observability attributes | `packages/governance-core/src/adapters/fulfillment.ts` (frozen); `opnory.*` attribute vocabulary; `packages/observability/*` redaction | Unit/contract tests; static governance (Oxlint) | Per change | **IMPLEMENTED** | Prove cross‑tenant negative controls in live tenant integration lifecycle (ADR 0006) | Confidentiality (CC7.1, CC7.2) | Gate 1, ADR 0006 |
| **SEC‑07** | Authorization decision boundaries: policy evaluation uses Opnory IDs only; provider IDs never enter domain objects | Engineering Lead | Frozen `FulfillmentAdapter` contract enforces provider‑neutral domain model | `packages/governance-core/src/adapters/fulfillment.ts`; `packages/governance-core/src/adapters/conformance.ts` (both frozen) | Conformance harness (5/5 Entra, 3/3 Okta fixtures) | Per change | **PROVEN** (dual‑provider live conformance) | Re‑certify on any contract change (ADR 0003 invariant #7) | Security (CC6.1, CC6.3) | Gate 1, ADR 0003 |
| **SEC‑08** | Provider‑ID / policy‑boundary integrity: frozen fulfillment contract and conformance harness cannot be modified without re‑certification | Engineering Lead | Architecture freeze (ARChitecture_FREEZE.md); Oxlint rules enforce no semantic changes | `ARCHITECTURE_FREEZE.md`; `oxlint.config.ts` override for governance-core adapters | Oxlint static check; conformance harness re‑run required for any change | Continuous / per change | **PROVEN** (freeze enforced by static analysis + process) | Maintain freeze; document re‑certification procedure | Security (CC6.1, CC6.8) | ADR 0003, ADR 0007 (if exists) |
| **SEC‑09** | Secrets management: opaque references, encrypted durable backend, no secrets in Git/images/logs | Engineering Lead | AES‑256‑GCM encrypted secret backend; opaque `credentialRef`; `StaticTestKeyProvider` proof‑only | `packages/integration-runtime/src/secret-store.ts` (AES‑256‑GCM); `ops/self-hosted-seaweedfs/s3.*.json.example` templates (no real keys) | Unit tests; secret scanning in CI | Continuous | **IMPLEMENTED** (AES‑256‑GCM backend proven; StaticTestKeyProvider is proof‑only) | Production KMS/HSM custody; rotation automation; revocation testing | Security (CC6.1, CC6.3), Confidentiality (CC7.1) | Gate 1, Gate 4 |
| **SEC‑10** | Key custody / rotation: production keys in KMS/HSM; rotation schedule; revocation tested | Security Lead | StaticTestKeyProvider only; no production KMS/HSM | None for production | N/A | Annual (target) | **UNPROVEN** | Integrate Cloud KMS / HashiCorp Vault / AWS Secrets Manager; automated rotation; revocation test | Security (CC6.1, CC6.3), Confidentiality (CC7.1) | Gate 4 |
| **SEC‑11** | Encryption in transit: TLS 1.2+ for all external and inter‑service paths | Engineering Lead | Gate 2 TLS (Caddy → Grafana) frozen at `6077f30a`; private Compose network for Tempo/SeaweedFS; **public TLS evidence UNPROVEN** | `ops/observability-gate2/verify-tls.sh`; `ops/observability-gate2/Caddyfile`; `ops/observability-gate2/compose.yml` | `verify-tls.sh` (external vantage) — **never executed** | Per deployment | **UNPROVEN** (Gate 2 frozen; public TLS never verified; listeners removed before test) | External ingress test → Cloudflare DNS → Caddy ACME → `verify-tls.sh` pass | Security (CC6.1, CC6.8), Confidentiality (CC7.1) | Gate 2 |
| **SEC‑12** | Encryption at rest: AES‑256‑GCM for durable secrets; SeaweedFS volume encryption not exercised | Engineering Lead | AES‑256‑GCM secret backend proven; SeaweedFS volume encryption not configured/tested | `packages/integration-runtime/src/secret-store.ts` (AES‑256‑GCM); SeaweedFS config no encryption | Unit tests (secret backend); no SeaweedFS encryption test | Per deployment | **PARTIAL** (secret backend AES‑256‑GCM PROVEN; object storage encryption UNPROVEN) | Configure SeaweedFS encryption; prove key custody for volume keys | Security (CC6.1), Confidentiality (CC7.1) | Gate 1, Gate 4 |
| **SEC‑13** | Network exposure / default deny: public only 80/443 to Caddy; all backend ports private; no SSH/Docker API public | Engineering Lead | Bridged LAN networking PROVEN (`192.168.1.179/24`); WAN 80/443 forwards **disabled**; temporary listeners removed; UFW default deny on VM | `ops/observability-gate2/compose.yml` (no host ports except Caddy); `gate2-ubuntu.yaml` UFW rules; router forwards disabled | `nc -zv` external test (not run); local `ss -ltnp` | Per deployment | **IMPLEMENTED** (no public exposure currently; re‑enable gated on Gate 2 hardening branch review) | Gate 2 hardening branch: re‑enable 80/443 only after Caddy deployed + verifier passes | Security (CC6.1, CC6.8) | Gate 2 |
| **SEC‑14** | Vulnerability and patch management: OS, deps, container images scanned; remediation SLAs | Platform / Infra | `bun audit` / `npm audit` in CI; base images pinned by digest (`caddy@sha256:5f5c8640...`, `grafana/grafana@sha256:0dc5a246...`, `grafana/tempo@sha256:f0200a9b...`, `seaweedfs@sha256:fc9f76fa...`) | `ops/observability-gate2/compose.yml` (pinned digests); `bun run lint`/`test`/`typecheck` gates | `bun audit` in CI; Dependabot / Renovate (not configured) | Continuous / per PR | **PARTIAL** (pinned digests proven; automated scanning not configured; no remediation SLA documented) | Configure automated scanning (Trivy/Grype); define SLA; add to CI | Security (CC7.1, CC7.2) | Gate 4, Gate 7 |
| **SEC‑15** | Dependency/container provenance: pinned digests, SBOM where practical, reproducible builds | Engineering Lead | All Compose images pinned by SHA‑256 digest; `bun install --frozen-lockfile` for reproducible deps | `ops/observability-gate2/compose.yml`; `package.json` + `bun.lockb` | `bun install --frozen-lockfile` in CI | Per deployment | **PROVEN** (pinned digests + frozen lockfile) | SBOM generation (Syft); SLSA provenance for images | Security (CC7.1), Confidentiality (CC7.2) | Gate 1, Gate 7 |
| **SEC‑16** | Secure SDLC / static governance: Oxlint anti‑slop rules; targeted trust‑boundary ratchet; frozen governance contracts | Engineering Lead | `oxlint.config.ts` with integration‑runtime override (two rules → error); governance‑core adapters frozen | `oxlint.config.ts`; `tools/oxlint/anti-slop/rules/*`; `packages/governance-core/src/adapters/*` (frozen) | `bun run lint` (0 errors); `bun run typecheck`; `bun run build` | Per PR | **PROVEN** (targeted integration‑runtime ratchet; global enforcement NOT claimed; exception boundaries unchanged; frozen adapters unchanged) | Document exception boundaries; review annually | Security (CC7.1, CC7.2) | ADR 0003, ADR 0011, Gate 1 |
| **SEC‑17** | Change management / PR controls: required reviews, DCO sign‑off, branch protection, frozen gate process | Engineering Lead | ADR 0011: solo maintainer `required_approving_review_count=0`; DCO `-s` sign‑off required; conventional commits | `docs/architecture/adr/0011-solo-maintainer-branch-protection.md`; GitHub branch protection API; `CONTRIBUTING.md` | GitHub branch protection API; `git log --grep=Signed-off-by` | Per PR | **PROVEN** (branch protection, DCO, conventional commits enforced) | Document emergency bypass procedure; periodic review of protection rules | Security (CC8.1) | ADR 0011, Gate 1–9 |
| **SEC‑18** | Logging and auditability: structured logs with redaction; frozen `opnory.*` attribute vocabulary; no raw tenant attributes | Engineering Lead | Structured logging with automatic redaction; `opnory.*` attributes frozen; tenant hashing | `packages/observability/*`; `packages/config/src/index.ts` (redaction); `verify-durability.sh` output (JSON evidence) | `verify-durability.sh` produces JSON evidence; structured log tests | Continuous | **IMPLEMENTED** (redaction + frozen vocabulary implemented; audit log retention not yet defined) | Define log retention policy; centralize logs (Loki/ELK); prove tamper‑evidence | Security (CC7.2), Availability (CC9.1) | Gate 4, Gate 9 |
| **SEC‑19** | Security monitoring / alerting: alert on high‑risk events (auth failures, privilege escalation, config drift) | Security Lead | None implemented | None | N/A | Continuous | **PLANNED** | Integrate with centralized logging (Loki/Grafana); define alert rules; test | Security (CC7.1, CC7.2) | Gate 9 |
| **SEC‑20** | Incident response: documented procedure, roles, communication plan, post‑mortem template | Security Lead | None documented | None | N/A | Annual | **PLANNED** | Write IR plan; tabletop exercise; evidence retention for post‑mortems | Security (CC7.3, CC7.4) | Gate 8 |
| **SEC‑21** | Backup: encrypted backups of durable state (PostgreSQL, SeaweedFS volumes, secrets) with retention policy | Platform / Infra | PostgreSQL `pg_dump` not automated; SeaweedFS volume backup not tested; secret backend export not automated | None automated | N/A | Daily (target) | **UNPROVEN** | Automate `pg_dump` + SeaweedFS volume backup; encrypt; test restore; retention policy | Availability (CC9.1, CC9.2) | Gate 4 |
| **SEC‑22** | Restore testing: periodic restore exercises with evidence of successful recovery | Platform / Infra | Gate 1A `verify-durability.sh` exercises **single‑node SeaweedFS durability** (emit → flush → destroy Tempo+state → fresh Tempo → retrieve → tenant controls) | `ops/self-hosted-seaweedfs/verify-durability.sh` (EXIT=0 clean‑slate) | `verify-durability.sh` (manual) | Per Gate 1A run | **PARTIAL** (single‑node recovery PROVEN for exercised scenario; not HA, not full‑system, not scheduled) | Schedule periodic restore tests; expand to full stack (PostgreSQL + SeaweedFS + secrets) | Availability (CC9.1, CC9.2) | Gate 4 |
| **SEC‑23** | Availability / HA: multi‑node, failover, load balancing for all production components | Platform / Infra | Single‑node throughout (Lima VM, SeaweedFS, Tempo, Grafana, Caddy) | None for HA | N/A | Continuous | **UNPROVEN** | Design HA topology (multi‑AZ SeaweedFS, Tempo HA, Grafana HA, Caddy HA); prove failover | Availability (CC9.1, CC9.2) | Gate 5 |
| **SEC‑24** | Capacity / load: defined limits, autoscaling where applicable, load testing evidence | Platform / Infra | No capacity planning; single‑node limits unknown | None | N/A | Per release | **UNPROVEN** | Define capacity model; load test Gate 2 stack; autoscaling design | Availability (CC9.1) | Gate 6 |
| **SEC‑25** | Upgrade / rollback: immutable image refs, PR‑based changes, rollback procedure tested | Engineering Lead | Pinned image digests; conventional commits; `bun install --frozen-lockfile`; no automated rollback test | `ops/observability-gate2/compose.yml` (digests); `package.json`/`bun.lockb` | `bun install --frozen-lockfile` | Per deployment | **PARTIAL** (immutable refs + frozen lockfile; rollback not tested) | Document rollback procedure; test in staging | Availability (CC9.1) | Gate 7 |
| **SEC‑26** | Failure recovery: Graceful degradation, circuit breakers, dead‑letter queues, data loss bounds | Engineering Lead | Gate 1A durability proof (SeaweedFS object‑store flush survives Tempo destroy) partially covers data path | `verify-durability.sh` (tenant positive/negative controls) | `verify-durability.sh` | Per Gate 1A run | **PARTIAL** (single‑node object‑store recovery PROVEN; no circuit breakers, no DLQ, no graceful degradation for other components) | Add circuit breakers to fulfillment adapters; DLQ for async ops; define data loss bounds | Availability (CC9.1, CC9.2) | Gate 8 |
| **SEC‑27** | Vendor / third‑party risk: provider API dependencies (Entra, Okta, GitHub, Cloudflare) assessed; contractual SLAs | Security Lead | Live conformance against Entra/Okta sandboxes proves adapter correctness; no vendor risk assessment doc | `bun run live:entra` / `live:okta` (opt‑in); Cloudflare DNS API token scope | Live conformance (opt‑in) | Annual | **PARTIAL** (provider adapters live‑certified; vendor risk register absent; Cloudflare token scope narrow) | Create vendor risk register; assess Cloudflare, Entra, Okta, GitHub SLAs; monitor deprecations | Security (CC9.2) | Gate 1, Gate 2, Gate 3 |
| **SEC‑28** | Data classification: tenant data, secrets, logs, audit events classified with handling rules | Engineering Lead | `opnory.*` attribute vocabulary (frozen); tenant hashing; no raw tenant IDs in logs | `packages/observability/*`; `packages/config/src/index.ts` | Static governance (Oxlint) | Continuous | **IMPLEMENTED** (vocabulary frozen; classification enforced at log emission) | Document data classification matrix; handling rules per class | Confidentiality (CC7.1, CC7.2) | Gate 1, Gate 4 |
| **SEC‑29** | Data retention / deletion: defined retention periods; secure deletion for each class | Security Lead | Not documented | None | N/A | Annual | **PLANNED** | Define retention periods per data class; implement secure deletion (crypto‑shred for encrypted) | Confidentiality (CC7.1, CC7.2) | Gate 4 |
| **SEC‑30** | Security policy governance: policies documented, approved, reviewed, communicated | Security Lead | ADRs for architecture freeze, branch protection; CONTRIBUTING.md; SECURITY.md | `ARCHITECTURE_FREEZE.md`; `ADR 0003`, `ADR 0011`; `CONTRIBUTING.md`; `SECURITY.md` | Manual review | Annual | **PARTIAL** (core policies exist; comprehensive security policy doc absent) | Consolidate into Security Policy document; annual review cadence | Security (CC5.1, CC5.2) | ADR 0003, ADR 0011 |
| **SEC‑31** | Security awareness / training: engineering team trained on secure coding, incident response, secrets handling | Security Lead | Not documented | None | N/A | Annual | **PLANNED** | Define training curriculum; track completion; refresh annually | Security (CC5.3) | Gate 3, Gate 9 |
| **SEC‑32** | Risk assessment / risk register: identified risks scored, mitigated, reviewed | Security Lead | Not documented | None | N/A | Quarterly | **PLANNED** | Create risk register (Likelihood × Impact); link to controls; quarterly review | Security (CC3.1, CC3.2) | Gate 4, Gate 9 |
| **SEC‑33** | Control review / evidence retention: periodic control effectiveness review; evidence retained per schedule | Security Lead | This matrix establishes baseline; retention schedule not defined | This document (`docs/security-soc2-readiness-control-matrix.md`) | Manual review of this matrix | Quarterly | **PLANNED** | Define evidence retention schedule (logs, verifier output, attestations); automate collection | Security (CC7.2, CC7.3) | Gate 4, Gate 9 |

---

## 7. Known Gaps / Remediation Priorities

| Priority | Control(s) | Gap Description | Target Gate / Action |
|----------|------------|-----------------|----------------------|
| **1** | SEC‑01, SEC‑02, SEC‑03 | No SSO/OIDC/MFA; no privileged access documentation; break‑glass undefined | **Gate 3** — highest priority |
| **2** | SEC‑11 | Public TLS evidence UNPROVEN; Gate 2 frozen at `6077f30a`; listeners removed, forwards disabled | Gate 2 hardening branch: re‑enable 80/443 → Caddy ACME → `verify-tls.sh` |
| **3** | SEC‑10 | Production KMS/HSM custody UNPROVEN; StaticTestKeyProvider proof‑only | Gate 4 — integrate Cloud KMS / Vault; rotation + revocation test |
| **4** | SEC‑21, SEC‑22 | Backup/restore not automated; single‑node recovery only | Gate 4 — automate `pg_dump` + SeaweedFS backup; encrypt; scheduled restore test |
| **5** | SEC‑23 | No HA / failover for any component | Gate 5 — multi‑AZ design for SeaweedFS, Tempo, Grafana, Caddy |
| **6** | SEC‑14, SEC‑19 | No automated vulnerability scanning; no security monitoring/alerting | Gate 4 + Gate 9 — Trivy/Grype in CI; Loki + alert rules |
| **7** | SEC‑32 | No risk register; no formal risk assessment | Gate 4 — create risk register, link to controls |
| **8** | SEC‑29, SEC‑31, SEC‑33 | No data retention/deletion policy; no training program; no evidence retention schedule | Gate 4 / Gate 9 |

---

## 8. Evidence Retention Expectations

| Evidence Type | Retention | Storage | Integrity |
|---------------|-----------|---------|-----------|
| Verifier output JSON (`gate1a-evidence.json`, `gate2-evidence.json`) | 7 years | Immutable object storage (SeaweedFS/S3) | SHA‑256 digest recorded in commit |
| Live conformance logs (Entra/Okta) | 7 years | Immutable object storage | SHA‑256 digest recorded in commit |
| Oxlint / typecheck / build CI logs | 2 years | CI artifact store (GitHub Actions) | Immutable |
| Structured application logs (redacted) | 2 years | Centralized log store (Loki/ELK) | Tamper‑evident |
| Audit / access review records | 7 years | Immutable object storage | SHA‑256 + signature |
| Backup / restore test reports | 7 years | Immutable object storage | SHA‑256 + signature |
| Incident response / post‑mortem artifacts | 7 years | Immutable object storage | SHA‑256 + signature |
| Vendor risk assessments / contracts | 7 years | Immutable object storage | SHA‑256 + signature |

All evidence artifacts **must** be referenced by immutable digest (SHA‑256) in the control matrix or ADRs.

## 9. Review Cadence

| Review | Cadence | Participants | Output |
|--------|---------|--------------|--------|
| Control matrix accuracy | Quarterly | Engineering Lead, Security Lead | Updated matrix + PR |
| Evidence artifact integrity | Quarterly | Platform / Infra | Digest verification report |
| Risk register review | Quarterly | Security Lead, Engineering Lead | Updated risk scores |
| Access review (SEC‑05) | Quarterly | Product / Governance, Security Lead | Certification record |
| Vendor risk review | Annual | Security Lead, Engineering Lead | Updated vendor register |
| Policy review (SEC‑30) | Annual | Security Lead, Engineering Lead | Updated policies |
| SOC 2 readiness assessment | Annual | External advisor (optional) | Gap analysis report |

## 10. Production‑Readiness Relationship

This control matrix documents **readiness evidence** for each production hardening gate. A gate is **not** "passed" until:

1. All controls mapped to that gate are **PROVEN** or **IMPLEMENTED** with no open `PARTIAL` gaps that affect the gate's security boundary.
2. The gate's live verifier (where applicable) produces retained evidence artifacts.
3. Evidence artifacts are stored with integrity guarantees per Section 8.
4. An explicit gate review PR is opened, reviewed, and merged (ADR 0011 applies).

| Gate | Controls Required | Current State | Go/No‑Go |
|------|-------------------|---------------|----------|
| 1. Object storage | SEC‑06, SEC‑09, SEC‑12, SEC‑15, SEC‑22 | SeaweedFS single‑node durability PROVEN; encryption at rest PARTIAL | **CONDITIONAL** (single‑node proven; encryption/HA missing) |
| 2. TLS | SEC‑11, SEC‑13 | Frozen implementation; public TLS UNPROVEN; forwards disabled | **NO‑GO** (evidence not collected) |
| 3. SSO/auth/authz | SEC‑01, SEC‑02, SEC‑03, SEC‑04, SEC‑05 | PLANNED only | **NO‑GO** |
| 4. Backup + restore | SEC‑21, SEC‑22, SEC‑09, SEC‑10 | PARTIAL (single‑node SeaweedFS only) | **NO‑GO** |
| 5. HA | SEC‑23 | UNPROVEN | **NO‑GO** |
| 6. Capacity/load | SEC‑24 | UNPROVEN | **NO‑GO** |
| 7. Upgrade/rollback | SEC‑25 | PARTIAL (immutable refs; rollback untested) | **NO‑GO** |
| 8. Failure recovery | SEC‑26 | PARTIAL (single‑node data path only) | **NO‑GO** |
| 9. Production monitoring | SEC‑18, SEC‑19 | IMPLEMENTED (logging); PLANNED (monitoring/alerting) | **NO‑GO** |

**Overall**: Opnory is **not production‑ready**. The frozen Gate 2 implementation (`6077f30a`) and this control matrix are stepping stones toward production readiness; they do not constitute it.

---

*Document version: 1.0*
*Branch: `feat/security-soc2-readiness-control-matrix`*
*Base commit: `4d0b4b40` (main)*
*Gate 2 frozen branch SHA: `6077f30a3f89826230fea5a19b2a35efb8017a5a`*
*Generated: 2026‑09‑13*