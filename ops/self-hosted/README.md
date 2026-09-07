# Grafana OSS + Tempo OSS (self-hosted) — SELF-HOSTED LIVE evidence

**Evidence state:** `SELF-HOSTED LIVE` (local single-node; **not production-ready**)
**Date:** 2026-09-07
**Method:** unchanged Phase 7 lifecycle corpus replayed through the real committed
`f34209a` emitter → auth reverse proxy → self-hosted Tempo OSS → MinIO (S3-compatible).
Reads performed against Tempo's **native API through the proxy**, never the Grafana UI.
No self-host-specific corpus change. No credential value is reproduced here.

```
Grafana OSS + Tempo OSS
Evidence state: SELF-HOSTED LIVE

Lifecycle corpus parity:            PASS (run 1) / PASS (run 2)
Lifecycle reconstruction:           PASS (run 1) / PASS (run 2)
Tenant isolation:                   PASS (run 1) / PASS (run 2)
Redaction:                          PASS (run 1) / PASS (run 2)
Failure taxonomy:                   PASS (run 1) / PASS (run 2)
Structural reproducibility:         PASS
Auth enforcement:                   PASS
Object-store recovery:              PASS
Grafana→Tempo datasource:           PASS

Still UNPROVEN:
- production TLS
- HA / multi-replica operation
- real cloud object storage
- backup / restore procedure
- SSO / enterprise IAM integration
- capacity sizing
- upgrades / rollback
- disaster recovery
- production monitoring
```

## Hard gates (unchanged, two passes)

All six gates — corpus parity, lifecycle reconstruction, tenant isolation,
redaction, failure taxonomy, structural reproducibility — passed in **both** runs
through the auth proxy. Isolation showed tenant-A = 7 spans, zero cross-tenant
leak, negative control (nonexistent hash) = 0. Failure taxonomy preserved
`credential_backend_unavailable` and rejected `provider_unreachable`.

## Auth enforcement (real, not assumed)

Tempo has no built-in auth; the Caddy reverse proxy is the only host-facing
surface. Tempo itself is private on the compose network (no host port).

| Request | Correct credential | Wrong credential | Missing credential |
|---|---|---|---|
| read `/api/search` | 200 | 401 | 401 |
| ingest `/v1/traces` | 200 | 401 | 401 |

## Object-store recovery (the durable-truth test)

A `docker restart` was deliberately **not** used; it can succeed from local WAL
and prove nothing about MinIO. Instead:

1. Traces written and flushed to MinIO (verified: `single-tenant/` block object in
   the `tempo-traces` bucket).
2. Tempo container **destroyed** (container + local WAL state removed); MinIO
   volume preserved.
3. Fresh Tempo instance started against the same bucket.
4. Historical trace retrieved through the read API → **200**, span attributes
   intact (name `integration.install`, `opnory.operation=durability.probe`,
   `opnory.provider=entra`).

Same result after a **full compose down/up** (all containers removed, MinIO
volume preserved): probe trace retrievable (200), auth still enforced (401 on
no-credential), Grafana datasource still registered (200).

### Finding: WAL→object-store flush is latency-gated

Traces are queryable from the ingester WAL immediately, but become durably
retrievable from MinIO only after the ingester block-flush cycle
(~5–8 minutes with Tempo 2.5 defaults and a 5m blocklist poll). The destructive
test correctly failed when run against a not-yet-flushed trace, which is the
point of the test: it distinguishes "queryable now" from "durably recoverable".

## Grafana → Tempo datasource

Grafana OSS provisioned a Tempo datasource at `http://tempo:3200` (private
network) and registered it (Grafana API `/api/datasources` = 200). This is a
connectivity/configuration proof only; lifecycle reconstruction used Tempo's
native read API, not the Grafana UI.

## Scope / non-claims

- Single-node MinIO is a **test vehicle for S3 semantics**, not evidence that
  MinIO is the production storage choice. The MinIO OSS repository is
  archived/source-only; SeaweedFS or a real cloud S3-compatible store would be
  the production evaluation path.
- A local authenticated reverse proxy proves the boundary *can exist*; it does
  not prove production SSO/TLS architecture.
- Not production-ready: the nine dimensions above remain UNPROVEN and require a
  separate, expensive production leg.
- No ADR 0009, no backend ranking, no credentials committed.

## Stack files

`ops/self-hosted/` — `compose.yml` (MinIO + Tempo + Grafana + auth proxy + bucket
init), `tempo.yaml` (S3-backed, `-config.expand-env=true`), `Caddyfile`
(basicauth + reverse proxy). Ephemeral credentials live only in `.env` /
`.env.test` (gitignored).