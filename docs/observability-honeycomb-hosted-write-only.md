# Honeycomb — HOSTED LIVE (WRITE ONLY) evidence

**Evidence state:** `HOSTED LIVE — WRITE ONLY`
**Date:** 2026-09-07
**Method:** real committed Opnory emitter (`f34209a` `emitSpan`) driving the OTLP
ingest path against the Honeycomb hosted endpoint, using the configured
`x-honeycomb-team` auth header. One non-sensitive connection-test span. No key
values, headers, or secret material are reproduced in this artifact.

## Result

```
Honeycomb ingest            HOSTED LIVE — WRITE ONLY
Honeycomb native read API   BLOCKED BY PLAN
Tenant isolation            UNPROVEN
Lifecycle reconstruction    UNPROVEN
Failure taxonomy            UNPROVEN
Read/query latency          UNPROVEN
ADR 0009 admission          NOT YET ELIGIBLE
```

## Key validation (via `https://api.honeycomb.io/1/auth`, HTTP 200)

| Key | Type | Environment | Permissions |
|---|---|---|---|
| ingest | `ingest` | `opnory-observability-bakeoff` | `createDatasets: true` |
| configuration | `configuration` | `opnory-observability-bakeoff` | `columns: true`, `queries: false`, all others false |

Team slug: `opnory`. Region: `us` (from env; not present in auth response).

## Configuration key → native read decision

The configuration key has `columns: true` but **`queries: false`**. `Run queries`
(the `queries` permission required for the native Query Data API) is **absent**,
therefore:

```
Native Query Data API read proof: UNPROVEN
Reason: Run queries permission unavailable on current plan
Classification: BLOCKED BY PLAN, not FAIL
```

No Honeycomb UI queries, screenshots, client-side filtering, or alternate API were
substituted for the native read proof.

## Ingest proof

- Emitter: `packages/observability/dist/otel.js` (`emitSpan`, commit `f34209a`).
- One span emitted: `integration.install` with `opnory.operation = connectivity.test`,
  `opnory.provider = honeycomb`, synthetic tenant hash `0000000000000000`.
- No raw tenant id, no credential ref, no secret material in the span.
- **Result: HTTP 200** — emitter completed successfully.

## Redaction sweep

Scanned all local output and artifacts (emit script, auth-response JSON) for the
ingest key value, configuration key value, and the OTLP auth header value, plus the
sentinel and raw tenant ids. **Result: CLEAN** — no key value, auth header, sentinel,
or raw tenant id appears in any artifact.

## Boundary

This is **write-only** evidence. It does **not** establish tenant isolation,
reconstruction, failure taxonomy, redaction-at-rest, or read/query latency, and it
does **not** admit Honeycomb to ADR 0009. Full lifecycle observability proof requires
`Run queries` (Enterprise), pending the trial request in
`docs/honeycomb-enterprise-trial-checklist.md`.