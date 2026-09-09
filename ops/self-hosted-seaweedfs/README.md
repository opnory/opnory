# Gate 1A — SeaweedFS local object-store durability proof

This directory holds the compose stack for Gate 1A of the observability
production-hardening criteria: `docs/observability-production-hardening-criteria.md`.

## Stack

- **SeaweedFS** — pinned to the exact image digest that produced the Gate 1A evidence:
  `chrislusf/seaweedfs@sha256:fc9f76fa993ad69966ffeb2f65d0318fcae39c6f8e20cf68ef7b3a5cb97769e5`
  (single-node `server -s3`, S3 API on private port 8333). Structural reproducibility: a
  rerun of this commit executes the identical build, not whatever `:latest` points at.
- **Tempo OSS** (`grafana/tempo:2.5.0`) — ingest + query private on the network; S3
  backend `seaweedfs:8333`, `forcepathstyle: true`.

## Credentials (never committed)

Credentials are ephemeral and generated locally. Two files are gitignored:

- `.env` —
  - `SEAWEEDFS_ACCESS_KEY` / `SEAWEEDFS_SECRET_KEY` — **bootstrap admin** identity, used
    only by the `bootstrap-bucket` init container to create `tempo-traces`, then never
    handed to Tempo.
  - `SEAWEEDFS_TEMPO_ACCESS_KEY` / `SEAWEEDFS_TEMPO_SECRET_KEY` — the bucket-scoped
    **tempo** identity that Tempo actually authenticates with.
  - `SEAWEEDFS_SIGNING_KEY` — the STS/JWT fallback signing key.
- `s3.json` — SeaweedFS S3 identity config listing **only** the `tempo` identity with
  bucket-scoped `Read`/`Write`/`List`/`Tagging` actions (no `Admin`). Copy
  `s3.json.example` and substitute the `SEAWEEDFS_TEMPO_*` values.

## SeaweedFS S3 authentication (the working recipe)

SeaweedFS validates client SigV4 signatures against identities in `s3.json`, and
requires an STS fallback signing key. The composition that works:

1. Mount `s3.json` via `-s3.config=/etc/seaweedfs/s3.json` with an `identities` entry
   whose `accessKey`/`secretKey` match what Tempo signs with (`SEAWEEDFS_TEMPO_*`).
2. Set `WEED_JWT_FILER_SIGNING_KEY` (and `_READ_KEY`) to a shared secret — the STS
   fallback signing key.
3. Create the `tempo-traces` bucket with a real SigV4 client. The `bootstrap-bucket`
   init container does this once with the admin credential. Plain curl's
   `Authorization: AWS a:s` header is NOT a valid SigV4 signature (403).

## Least-privilege status

SeaweedFS uses a **static identity vocabulary** — `Read`, `Write`, `List`, `Tagging`,
`Admin` — optionally bucket-scoped (e.g. `Read:tempo-traces`). It does **not** use AWS
IAM operation names. `Admin` is for bucket create/list/delete; `Write` covers object
upload and deletion.

The running S3 identity set visible to Tempo contains only the bucket-scoped `tempo`
identity (`Read`/`Write`/`List`/`Tagging` on `tempo-traces`). The bootstrap `Admin`
credential is used solely for one-time bucket creation and is not exposed to Tempo.

## Operational finding: TraceQL search needs an explicit time window

Tempo's TraceQL search (`/api/search`) defaults to a short time window; old spans (~3.7 h)
fall outside it and an unwindowed query returns 0 even though the traces are durable and
queryable by ID. Always bracket TraceQL with an explicit `start`/`end` around the span
timestamp. Trace-by-ID retrieval (`GET /api/traces/{id}`) has no default-window behavior.

## Evidence

See `docs/observability-gate1a-seaweedfs-proof.md` and the raw `gate1a-evidence.json`
(kept outside Git in `~/.config/opnory/`).