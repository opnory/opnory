# Gate 1A — SeaweedFS local object-store durability proof

This directory holds the compose stack for Gate 1A of the observability
production-hardening criteria: `docs/observability-production-hardening-criteria.md`.

## Stack

- **SeaweedFS** (`chrislusf/seaweedfs:latest`, `server -s3`) — single-node S3 API on
  the private compose network (port 8333). Replaces MinIO per ADR 0010.
- **Tempo OSS** (`grafana/tempo:2.5.0`) — ingest + query private on the network; S3
  backend `seaweedfs:8333`, `forcepathstyle: true`.

## Credentials (never committed)

Credentials are ephemeral and generated locally. Two files are gitignored:

- `.env` — `SEAWEEDFS_ACCESS_KEY`, `SEAWEEDFS_SECRET_KEY`,
  `SEAWEEDFS_SIGNING_KEY`.
- `s3.json` — SeaweedFS S3 identity config (access/secret pair). Copy
  `s3.json.example` and substitute the same values, or generate at startup.

## SeaweedFS S3 authentication (the working recipe)

SeaweedFS validates client SigV4 signatures against identities in `s3.json`, and
requires an STS fallback signing key. The composition that works:

1. Mount `s3.json` via `-s3.config=/etc/seaweedfs/s3.json` with an `identities`
   entry whose `accessKey`/`secretKey` match what Tempo signs with.
2. Set `WEED_JWT_FILER_SIGNING_KEY` (and `WEED_JWT_FILER_SIGNING_READ_KEY`) to a
   shared secret — SeaweedFS uses this as the STS fallback signing key.
3. Create the `tempo-traces` bucket with a real SigV4 client (e.g. `aws s3 mb
   --endpoint-url http://seaweedfs:8333`). Plain curl's `Authorization: AWS a:s`
   header is NOT a valid SigV4 signature and is rejected (403).

## Least-privilege status

The committed example uses `actions: ["Admin"]` for the bootstrap identity. Narrowing
this to Tempo's minimum S3 operations (`PutObject`, `GetObject`, `ListBucket`,
`DeleteObject`, `GetObjectTagging`, `PutObjectTagging`) is a **follow-up hardening
item — UNPROVEN**, not silently treated as production-ready.

## Operational finding: TraceQL search needs an explicit time window

Tempo's TraceQL search (`/api/search`) defaults to a short time window; old spans (~3.7 h)
fall outside it and an unwindowed query returns 0 even though the traces are durable and
queryable by ID. Always bracket TraceQL with an explicit `start`/`end` around the span
timestamp. Trace-by-ID retrieval (`GET /api/traces/{id}`) has no default-window behavior.

## Evidence

See `docs/observability-gate1a-seaweedfs-proof.md` and the raw
`gate1a-evidence.json` (kept outside Git in `~/.config/opnory/`).