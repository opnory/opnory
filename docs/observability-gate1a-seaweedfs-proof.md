# Gate 1A — SeaweedFS object-store durability proof

**Evidence classification:** `SELF-HOSTED LIVE — SINGLE NODE`
**Explicit non-claim:** this does **not** prove production storage HA/durability (that is Gate 1B, deferred).

## Result

| Check | Result |
|---|---|
| Durable object-store recovery | **PASS** |
| Corpus trace retrieval (trace-by-ID) | **PASS** (7/7 + probe) |
| Attribute integrity | **PASS** |
| Redaction | **PASS** |
| Tenant isolation (TraceQL select) | **PASS** (positive 7, negative 0) |

`SELF-HOSTED LIVE — SINGLE NODE`.

## Durable object-store recovery — PASS

Sequence (all commands executed, results observed):

1. Emitted the unchanged Phase 7 lifecycle corpus (7 spans) + a durability probe
   through the real OTLP/HTTP emitter to Tempo's private ingest port (4318).
2. Confirmed Tempo cut and flushed block `ad146f94` to SeaweedFS S3:
   `data.parquet`, `bloom-0`, `index`, `meta.json`, plus `tempo_cluster_seed.json`.
3. Destroyed the Tempo container and **all** Tempo-local state:
   `docker compose rm -sf tempo`.
4. Recreated a fresh Tempo instance against the **preserved** SeaweedFS volume.
5. Retrieved every trace by ID through Tempo's native read API (`/api/traces/{id}`)
   — all 200, proving the traces were recovered from SeaweedFS, not Tempo-local WAL.

## Corpus retrieval (trace-by-ID, after destroy/recreate)

| Trace ID | Span name | HTTP |
|---|---|---|
| `0abe7b327d8a43db9caa8854ad2e056c` | `integration.install` | 200 |
| `2b2a0fc5f9a440baa3d55379936f8dd3` | `integration.configure` | 200 |
| `f029a185dd8b47a792f286f63528c8a1` | `integration.validate` | 200 |
| `610b578cbaa644468a57338c063c757e` | `credential.resolve` | 200 |
| `13a1d23ce19e48c8b4ded59014087605` | `integration.health_check` | 200 |
| `820df159e8de4c4ab2d7655c91bbde19` | `plugin.activate` | 200 |
| `6870f5027f6749ea9cd27c807254dcb0` | `capability.register` | 200 |

Probe trace `cdf9a830fa2048c49c1c2fbda19f011a` (`integration.install`) → 200.

Retrieved span attributes confirm `opnory.tenant_hash`, `opnory.operation`,
`opnory.provider`, `service.name` integrity (attribute integrity PASS).

## Tenant isolation — PASS

Tenant-scoped query selectivity is demonstrated through TraceQL, using an **explicit
`start`/`end` window** bracketing the recovered spans (epoch ~1788852891). `opnory.tenant_hash`
is a **resource** attribute (confirmed in the payload: resource attr present, span attr empty).

| TraceQL query (explicit window) | Traces returned | Expected |
|---|---|---|
| `{}` (unconditional) | 8 | 7 corpus + 1 probe |
| `{.opnory.tenant_hash="tenant-gate1a-mt"}` | 7 | 7 corpus |
| `{.opnory.tenant_hash="probe-gate1a"}` | 1 | 1 probe |
| `{.opnory.tenant_hash="deadbeefdeadbeef"}` | 0 | 0 (negative control) |

Every returned trace was re-fetched by ID and confirmed to carry the requested
`opnory.tenant_hash` — no cross-tenant leakage.

## Redaction — PASS

A scan of all retrieved span JSON for the rotated credential substrings found zero
leaks (`leakedTokens: []`).

## Operational finding: TraceQL search requires an explicit time window

Tempo's TraceQL search (`/api/search`) defaults to a short time window that **excluded**
the recovered spans (~3.7 h old), so an unwindowed tenant query returned 0 and initially
looked like "search index not built." The traces were always durable and queryable — the
query was the problem, not the backend. Always bracket TraceQL with an explicit
`start`/`end` around the span timestamp. Trace-by-ID retrieval has no such default-window
behavior, which is why it succeeded immediately.

This supersedes the earlier "durability vs. search visibility" note: there was no
separate index lifecycle delay here — only a query-window omission.

## Root-cause diagnosis (corrected)

- **Initial theory (incorrect):** stale MinIO credential-volume artifact.
- **Actual causes:**
  - Tempo required `-config.expand-env=true` for `${S3_ACCESS_KEY}`/`${S3_SECRET_KEY}` interpolation.
  - SeaweedFS S3 identity/IAM config (`s3.json`) had to be loaded correctly via
    `-s3.config`, with an identity whose access/secret match what Tempo signs with.
  - SeaweedFS requires an STS fallback signing key (`WEED_JWT_FILER_SIGNING_KEY`).
  - Bucket creation required a real SigV4 client; curl's `Authorization: AWS a:s`
    header is not a valid SigV4 signature (403).

## Least-privilege status

The bootstrap SeaweedFS identity uses `actions: ["Admin"]`. Narrowing to Tempo's
minimum S3 operations is a **follow-up hardening item — UNPROVEN**, not treated as
production-ready. See `ops/self-hosted-seaweedfs/README.md`.

## Stack

`ops/self-hosted-seaweedfs/` — SeaweedFS (pinned digest
`sha256:fc9f76fa993ad69966ffeb2f65d0318fcae39c6f8e20cf68ef7b3a5cb97769e5`, the exact build
that produced this evidence; single-node `server -s3`) + Tempo OSS 2.5.0. Credentials
are gitignored (`.env`, `s3.json`); only `s3.json.example` is committed as a template.