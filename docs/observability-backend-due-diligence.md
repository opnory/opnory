# Observability backend — operational due-diligence evidence

**Status:** Draft evidence (vendor/documentation only — no hosted runtime proof yet)
**Last updated:** 2026-09-02
**Method:** public vendor documentation + pricing/security pages, retrieved and
cited below. Every item is **documentation evidence**, not runtime proof. Hosted
candidates must still replay the exact Phase 7 corpus and pass the ADR 0007 hard
gates before ADR 0009 (selection) is written.

## Evidence-state vocabulary

Every claim in this document carries exactly one of four evidence states, to
prevent vendor documentation from acquiring the epistemic weight of runtime proof:

| State | Meaning |
|---|---|
| `DOCS` | vendor documentation / pricing page / marketing — not independently exercised |
| `LOCAL LIVE` | proven against the local compose stack (Jaeger/Tempo runtime evidence) |
| `HOSTED LIVE` | proven against the hosted endpoint via the unchanged Phase 7 corpus + hard gates |
| `UNPROVEN` | not yet exercised at all (blocked on credentials) |

## Candidate scope

| Candidate | Type | Evidence state | Why in scope |
|---|---|---|---|
| **Jaeger (self-host)** | OSS tracing (parity baseline) | `LOCAL LIVE` | characterized locally; corrected capability (see `observability-bakeoff-corrections.md`) |
| **Grafana OSS + Tempo OSS (self-host)** | self-hosted OSS stack (separate candidate from Grafana Cloud) | `LOCAL LIVE` (single-binary) → `SELF-HOSTED LIVE` pending | TEMPO is the trace storage/query backend; Grafana OSS is the UI. Distinct from Grafana Cloud (hosted) and from the local single-binary Tempo baseline: the production dimensions (object storage, auth, restart/retention, TLS, backups) are UNPROVEN |
| **Grafana Cloud Traces** | managed Tempo (TraceQL) | `HOSTED LIVE` | the hosted form of the backend whose local proof already passed 5/5 |
| **Honeycomb** | independent SaaS tracing (columnar, event-based) | `HOSTED LIVE — WRITE ONLY` (read `BLOCKED BY PLAN`) | a genuinely different SaaS architecture, not another Tempo |
| **Phoenix** | OSS tracing/evals | `LOCAL LIVE` | hard-gate FAIL on tenant isolation (ADR 0007) — excluded until resolved |

## Candidate-admission rule

A hosted backend reaches ADR 0009 **only if** it can (a) ingest the unchanged
Phase 7 OTLP corpus and (b) expose enough native read capability to answer the
five operator questions **without client-side reconstruction masquerading as a
server capability**. Documentation claims to that effect do not satisfy the
rule; the hosted run through the ADR 0007 hard gates does.

## Decision set

This is a four-way comparison:

```text
Jaeger                 independent OSS baseline     LOCAL LIVE
Grafana OSS + Tempo    self-hosted OSS stack        LOCAL LIVE → SELF-HOSTED LIVE pending
Grafana Cloud Traces   managed Tempo candidate      HOSTED LIVE
Honeycomb              independent SaaS architecture HOSTED LIVE — WRITE ONLY (read BLOCKED BY PLAN)
```

This document records the **operational** criteria the local benchmark could not
establish. Benchmark fidelity (corpus parity, tenant isolation, redaction,
structural reproducibility, failure-taxonomy fidelity) is measured *separately*
and is **never collapsed into a single score** with these suitability facts.

## 1. Grafana Cloud Traces — operational facts

All items are vendor-documented. Figures are point-in-time (2026-09-02) and must
be re-confirmed against current vendor pages before a production decision.

### Pricing / cost structure

| Item | Value | Evidence |
|---|---|---|
| Process | $0.05 / GB (pre-Adaptive-Telemetry optimization) | grafana.com/cloud traces pricing page |
| Write | $0.40 / GB (after 50 GB free allotment) | same |
| Retain | $0.10 / GB per additional 30-day increment beyond included retention | same + invoice doc |
| Platform fee | $19 / mo (Pro self-serve) | pricing page |
| Free tier | 50 GB ingested / month, 14-day retention | pricing page |
| Pro retention | 30 days (included) | pricing page |
| Enterprise | custom, minimum $25k/year commit; BYOC / Federal Cloud option | pricing page |
| Fair-use query | query up to 100× written GB/month included; overage billed (`max(written, queried/fairUseRatio)`) | traces invoice doc |

### Regions / data residency

Self-serve regions (vendor "availability by region" page): US East (VA), US East
(OH), US West, US Central (Azure/GCP), EU Ireland, EU Germany, EU Sweden, EU
Netherlands (Azure), EU Belgium (GCP), EU Switzerland, UK (AWS+ GCP), Canada,
Australia, Japan, Singapore, India, Indonesia, Brazil, Saudi Arabia, UAE
(temporarily unavailable). Region of an existing stack **cannot be changed**.

### RBAC / auth / tenancy

- Grafana Cloud RBAC: basic roles (Viewer/Editor/Admin) + Enterprise/Cloud fixed
  roles + custom roles with `resource:action` + scopes (e.g. `teams:id:1`).
- Teams + Team Sync (SAML/LDAP/OAuth); service accounts for machine access.
- Data isolated by tenant (organization/stack); secrets encrypted per-tenant.

### Encryption / key management

- AES-256 at rest, HTTPS/TLS in transit, perfect forward secrecy; keys via
  industry-standard KMS (AWS/GCP/Azure), HashiCorp Vault, or self-managed.
- Secrets management uses envelope encryption (AES-GCM data keys wrapped by a
  root key), regular key rotation, full audit trail.

### Compliance

SOC 2 Type II, ISO 27001, FedRAMP, PCI DSS, GDPR, NATSEC100 (vendor-claimed).

### Published limits / throttling

- Ingest quotas by tier (50 GB free; pay-as-you-go above).
- Metrics-generator active-series cap (configurable limit; support ticket to
  raise) — relevant if span-metrics are enabled.
- Fair-use query policy (100× written volume) with explicit overage billing.

### Deletion / export / portability

- Object-storage-backed (Parquet columnar) — open format reduces lock-in;
  vendor markets "OpenTelemetry-native, no lock-in."
- Export/portability and deletion behavior require the **hosted run + contract
  review**; not yet verified operationally.

### Managed-service characteristics

Massively parallel TraceQL query engine ("terabytes/sec"), Adaptive Traces
(tail sampling / high-value retention), Adaptive Metrics aggregation to reduce
series, 8×5 support (Pro) / premium (Enterprise). Write→query visibility on the
**hosted** tier has not been measured locally and must be independently tested.

## 2. Honeycomb — operational facts (documentation-only)

**Evidence state:** `DOCS` / `UNPROVEN`. No hosted run has been performed; none
of the fidelity gates (parity, isolation, redaction, structural reproducibility,
failure-taxonomy) has been exercised against Honeycomb.

| Item | Value |
|---|---|
| Ingest | OTLP directly supported (documented) — accepts the unchanged Phase 7 corpus shape in principle |
| Read/query API | programmatic query API + query-result API (documented); async result retrieval |
| Retention | 60 days documented for standard datasets (point-in-time; re-confirm at decision time) |
| Regions | US and EU data regions; region selected at account creation |
| Pricing | events/month-based (not GB-volume like Grafana Cloud Traces) |
| Runtime parity / isolation / redaction / visibility latency | **UNPROVEN** |

### Honeycomb admission status — write-only proven, read path commercially blocked

```text
Honeycomb
Evidence state: HOSTED LIVE — WRITE ONLY

OTLP ingest:                  HOSTED LIVE (HTTP 200, real emitter)
Native Query Data API:        BLOCKED BY PLAN (Run queries unavailable)
Run Queries permission:       Enterprise-only
Hosted read proof:            BLOCKED BY PLAN
Tenant isolation:             UNPROVEN
Redaction:                    UNPROVEN
Failure taxonomy:             UNPROVEN
Write→queryable latency:      UNPROVEN
ADR 0009 admission:           NOT YET ELIGIBLE

Blocker observed:  2026-09-07
Resolution path:   Enterprise trial / sales enablement
```

This is a **commercial** blocker (`Run queries` is not available on the Free/Pro
self-serve plan), not evidence of backend failure. The ingest path is proven
`HOSTED LIVE — WRITE ONLY` via the real emitter
(`docs/observability-honeycomb-hosted-write-only.md`); no parity/isolation/redaction
result exists yet because the native read API is not reachable. See the trial
checklist in `docs/honeycomb-enterprise-trial-checklist.md`.

### Honeycomb-specific measurement caveat

Honeycomb's query-result API is **asynchronous** (submit → poll for result).
Therefore, for the later Honeycomb leg, `write→queryable visibility` and `query
execution completion` MUST be measured **separately** — mirroring ADR 0007's
existing separation of freshness (write→readable) from query latency (execution),
rather than conflating the two into one number.

## 2b. Grafana OSS + Tempo OSS (self-host) — operational facts

**Evidence state:** `LOCAL LIVE` (single-binary Tempo) → `SELF-HOSTED LIVE` pending.

The existing local Tempo baseline (`packages/observability-bench/docker/tempo.yaml`)
is a **single-binary, `local` filesystem-backed, no-auth** deployment (no TLS, no
object storage, `block_retention: 1h`). That proves *functional trace behavior*
only. It does **not** prove the production dimensions a self-hosted deployment
must satisfy:

```text
Self-hosted promotion criteria (all UNPROVEN today):

o durable object storage (S3-compatible)          UNPROVEN
o restart / data-retention behavior               UNPROVEN
o authenticated access (auth reverse-proxy/SSO)   UNPROVEN (Tempo has NO built-in auth)
o backups / restoration                           UNPROVEN
o production TLS                                  UNPROVEN
o multi-instance / HA operation                   UNPROVEN
o resource sizing                                 UNPROVEN
o upgrade procedure                               UNPROVEN
o failure recovery                                UNPROVEN
```

**Licensing:** Grafana OSS and Tempo OSS are both released under **AGPLv3**. This
does **not** automatically make Opnory (BSD-2-Clause) AGPL when the components are
operated as separate services, but the components must be kept cleanly separated,
and any distribution of modified builds or tight incorporation of their source
requires AGPL review before release.

### Note on the candidate split

"Grafana OSS + Tempo OSS" is a **distinct candidate** from Grafana Cloud Traces and
from the local single-binary Tempo baseline. Tempo is the trace storage/query
backend; Grafana OSS is the visualization/query UI with native Tempo datasource
support. The same frozen Phase 7 corpus and hard gates apply, but the proof
question is different: *can Opnory operate its own production-grade OSS
observability backend without Grafana Cloud?*

## 3. Non-claims (explicit)

- Vendor documentation (pricing/compliance/region facts) is dated 2026-09-02 and is
  **not** runtime proof.
- The local Tempo ~7s write→query latency (ADR 0008) is **not** a hosted
  prediction and must not be carried into the selection as one.
- No production-backend selection is made here. ADR 0009 requires hosted (or
  self-hosted-production) runtime evidence through the ADR 0007 hard gates.
- The self-hosted Grafana OSS + Tempo OSS candidate is `LOCAL LIVE` only; its
  `SELF-HOSTED LIVE` promotion is pending the production dimensions in §2b.

## 4. Open items blocking ADR 0009

1. ~~Hosted **Grafana Cloud Traces** account + ingest endpoint + read-scoped
   credentials~~ **RESOLVED** — `HOSTED LIVE`, six hard gates passed twice
   (`docs/observability-grafana-cloud-hosted-proof.md`).
2. Hosted **Honeycomb** account + API key/team/dataset scope + ingest endpoint
   (secrets; none held in this repo) — **commercially blocked** (`Run Queries`
   is Enterprise-only; see trial checklist
   `docs/honeycomb-enterprise-trial-checklist.md`).
3. ~~Replay the exact Phase 7 corpus and run the five hard-gate scenarios against
   each hosted endpoint~~ **DONE for Grafana Cloud**; still pending for Honeycomb.
4. For Honeycomb specifically: measure write→queryable visibility and query
   execution completion **separately** (async query API).
5. ~~Hosted write→query visibility measured independently for Grafana Cloud~~
   **DONE** (~32s visibility, query latency measured separately; see the hosted
   proof artifact).
6. Contract review for retention/deletion/export specifics (both hosted
   candidates).
7. **Self-hosted Grafana OSS + Tempo OSS**: begin the `SELF-HOSTED LIVE` proof —
   deploy with S3-compatible object storage + auth reverse-proxy, replay the
   corpus twice, test restart persistence and restoration (see §2b promotion
   criteria). Scope (MinIO vs real bucket, depth of production dimensions)
   to be confirmed.