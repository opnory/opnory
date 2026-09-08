# Observability Production-Hardening Criteria

**Status:** Provisional criteria (not an ADR — backend selection remains deferred)
**Date:** 2026-09-07

This document defines the acceptance criteria a **self-hosted** observability
candidate must satisfy before it is considered production-operable. It is
evidence criteria only:

- It does **not** rank candidates.
- It does **not** express a "preferred OSS" conclusion.
- It does **not** select a production backend. Backend selection is a separate
  decision (ADR 0009, deferred) that weighs operational burden, cost,
  sovereignty, portability, and managed-vs-self-hosted tradeoffs on top of this
  evidence.

Each gate has a **binary** pass condition. A gate is either met (with evidence)
or not met; there is no partial credit.

## References

The self-hosted stack proven `SELF-HOSTED LIVE` (single-node) is
`ops/self-hosted/`. That leg established *functional* behavior — corpus parity,
lifecycle reconstruction, tenant isolation, redaction, failure taxonomy,
structural reproducibility, basic-auth enforcement, object-store recovery, and
restart determinism. It did **not** establish production operability. These
criteria are the next, separate leg.

---

## The nine evidence gates

### 1A. Local OSS object-store durability

**Target:** SeaweedFS (self-hostable OSS, native S3 API).

**PASS when:** Tempo writes through the SeaweedFS S3 API; historical traces become
durable in SeaweedFS; **all** Tempo-local WAL/cache/state is destroyed; a fresh Tempo
deployment is created against the preserved SeaweedFS state; and historical traces remain
retrievable through Tempo's native read API, with tenant isolation and redaction intact.

**Evidence classification:** `SELF-HOSTED LIVE — SINGLE NODE`.

**Explicit non-claim:** this does **not** prove production storage HA/durability.

### 1B. Production object-store durability

**Target:** not yet selected (deferred). Candidate backend must be OSS, self-hostable,
S3-compatible, multi-node, replicated and/or erasure-coded, and capable of surviving a
real storage-node loss.

**PASS when:** a multi-node deployment runs on distinct failure domains; an actual node
loss occurs while writes/reads continue or recover within budget; no loss of
already-durable traces; rebuild/rebalance is demonstrated; and destructive
Tempo-local-state recovery still succeeds.

**Candidates (undecided):** SeaweedFS distributed, Ceph RGW, or another qualifying OSS
backend. This gate does **not** preselect a winner.

### 2. TLS

**PASS when:** ingest and read endpoints reject plaintext external access; valid
TLS succeeds; invalid/untrusted certificates fail closed; and there is no TLS
bypass in the production configuration.

### 3. SSO / authentication / authorization

**PASS when:** human access goes through the selected identity provider;
unauthenticated users are denied; unauthorized users are denied;
service-to-service credentials are separately scoped; and Tempo itself remains
non-public.

### 4. Backup + restore

**PASS when:** a documented backup is created; primary trace storage and config
state are deliberately removed; restore into a fresh environment succeeds; and
known historical traces are retrievable afterward.

### 5. High availability

**PASS when:** the production topology has no required single Tempo / Grafana /
proxy instance; loss of one replica does not prevent accepted ingest or read
operations; and recovery does not lose already-durable traces.

### 6. Capacity / load

**PASS when:** the target Opnory ingestion and query workload is defined;
sustained load meets explicit latency / error / resource budgets; and overload
behavior is measured and fails predictably rather than silently losing data.

### 7. Upgrade / rollback

**PASS when:** upgrade from version N → N+1 completes with persisted data;
existing traces remain queryable; a rollback procedure is exercised or proven
safe for the chosen storage/schema boundary; and configuration migration is
documented.

### 8. Failure recovery

**PASS when:** at least object-store outage, Tempo failure, proxy failure,
Grafana failure, and network interruption are exercised; the system recovers
deterministically; no cross-tenant leakage or silent corruption occurs; and
operational recovery steps are documented.

### 9. Production monitoring

**PASS when:** the observability stack itself exposes health / metrics / logs
sufficient to detect ingest failures, query failures, object-storage errors,
compaction/WAL problems, auth failures, resource saturation, and unavailable
components; and at least one alert path is exercised end-to-end.

---

## Cross-cutting rules

1. **Hard-gate absolutism.** A candidate failing a security, tenant-isolation,
   redaction, **or** durability gate is not production-admissible — regardless of
   any other passing gate.

2. **Evidence is not selection.** Passing these criteria establishes
   production-operability evidence. It does **not** by itself select the
   backend. ADR 0009 remains a separate decision incorporating operational
   burden, cost, sovereignty, portability, and managed-vs-self-hosted tradeoffs.

---

## How evidence is recorded

Each gate's proof follows ADR 0007 rule 6: raw JSON evidence, Markdown rendered
from it, no vendor-documentation substitution, and no client-side reconstruction
presented as a server capability. A gate recorded as PASS cites the specific
command/run and its observed result; a gate not yet exercised is recorded
**UNPROVEN**, not FAIL.