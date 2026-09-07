# Honeycomb Enterprise Trial — Request Checklist

**Purpose:** obtain the minimum enablement required to run the *unchanged* Phase 7
lifecycle proof against Honeycomb's native read API, so the hosted leg can reach
`HOSTED LIVE` the same way Grafana Cloud Traces did.

**Status:** BLOCKED on Enterprise trial / sales enablement (observed 2026-09-07).

## What to request from Honeycomb

- [ ] **Enterprise trial access** (self-serve Free/Pro does not include `Run Queries`).
- [ ] **`Run Queries` permission enabled** on a Configuration Key.
- [ ] **`Manage Queries and Columns` + `Run Queries` permissions** on the same key
      (both are needed for programmatic query submission and result retrieval).
- [ ] **Query Data API access** (the native programmatic read surface).
- [ ] **Region confirmation** — name the US/EU region the trial environment will use
      (region is fixed at account creation).
- [ ] **Permission to create a dedicated test environment** (dataset + API key scoped
      to that environment only, so the proof is isolated and cleanable).
- [ ] **Confirmation that no additional paid product feature is required** for
      programmatic trace querying beyond the two permissions above.

## The key question to ask (verbatim)

> “I need programmatic Query Data API access with a Configuration Key that has
> `Manage Queries and Columns` and `Run Queries`. Can you enable that in an
> Enterprise trial?”

## What we will do once enabled

1. Replay the **unchanged Phase 7 lifecycle corpus** (frozen span set + attribute
   contract) through the real `f34209a` emitter into Honeycomb's OTLP ingest.
2. Answer the operator questions **exclusively** through the native Query Data API
   (no Honeycomb UI as proof).
3. Run the six hard gates (parity, reconstruction, tenant isolation, redaction,
   failure taxonomy, structural reproducibility) **twice**.
4. Measure **write→queryable visibility** and **query execution completion**
   **separately** — Honeycomb's query-result API is asynchronous (submit → poll),
   so the two numbers must not be conflated (ADR 0007 freshness vs latency
   separation).

## Boundary (do not cross)

- This checklist is a **sales/trial enablement** artifact only. It does **not**
  admit Honeycomb to ADR 0009; admission requires a passing `HOSTED LIVE` leg.
- If the trial window closes without enablement, the next decision is whether to
  substitute another hosted candidate — never to weaken the admission rule.
- No credentials are recorded here and none should be added to this file or the repo.

## Follow-up window

Reasonable trial window requested; if no response within a couple of days, follow up
with Honeycomb before considering candidate-set expansion.