# Observability backend — operational due-diligence evidence

**Status:** Draft evidence (vendor/documentation only — no hosted runtime proof yet)
**Last updated:** 2026-09-02
**Method:** public vendor documentation + pricing/security pages, retrieved and
cited below. Every item is **documentation evidence**, not runtime proof. Hosted
candidates must still replay the exact Phase 7 corpus and pass the ADR 0007 hard
gates before ADR 0009 (selection) is written.

## Candidate scope

| Candidate | Type | Why in scope |
|---|---|---|
| **Grafana Cloud Traces** | hosted Tempo (TraceQL) | the hosted form of the backend whose local Proof already passed 5/5 |
| **Jaeger (self-host)** | OSS tracing (parity baseline) | characterized locally; corrected capability (see `observability-bakeoff-corrections.md`) |
| **Phoenix** | OSS tracing/evals | hard-gate FAIL on tenant isolation (ADR 0007) — excluded until resolved |

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

## 2. Non-claims (explicit)

- None of the above is runtime proof. It is vendor documentation, dated
  2026-09-02.
- The local Tempo ~7s write→query latency (ADR 0008) is **not** a hosted
  prediction and must not be carried into the selection as one.
- No production-backend selection is made here. ADR 0009 requires hosted runtime
  evidence through the ADR 0007 hard gates.

## 3. Open items blocking ADR 0009

1. Hosted Grafana Cloud Traces account + ingest endpoint + read-scoped
   credentials (secrets; none held in this repo).
2. Replay the exact Phase 7 corpus and run the five hard-gate scenarios against
   the hosted endpoint.
3. Hosted write→query visibility measured independently.
4. Contract review for retention/deletion/export specifics.
5. A second hosted candidate (if a bake-off, not a single-vendor decision, is
   desired).