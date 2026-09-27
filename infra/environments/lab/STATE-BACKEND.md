# Lab state backend contract (out-of-band S3)

Referenced by `versions.tf`. The backend **type** is declared in-tree; every
connection detail is supplied at `tofu init` time via `-backend-config` and
is never committed. This is the Phase 1B execution contract's out-of-band
state rule (ADR 0012 §1) — updated for Phase 1B-COST-SAFETY (AWS S3 with
S3-native locking; the earlier Hetzner-era S3-compatible wording is
superseded).

## Init arguments (exact, minimal set)

```bash
tofu init \
  -backend-config="bucket=<state-bucket>" \
  -backend-config="key=lab.tfstate" \
  -backend-config="region=us-east-2" \
  -backend-config="use_lockfile=true" \
  -backend-config="encrypt=true"
```

- `use_lockfile=true` uses **S3-native state locking** (`.tfstate-lock`
  object). This requires **OpenTofu >= 1.10** (landed in 1.10.0; the repo's
  CI tofu pin is bumped accordingly). No DynamoDB lock table: DynamoDB is an
  extra metered service, an extra out-of-band creation step, and extra IAM
  surface — rejected on Free-plan cost-safety grounds.
- `encrypt=true` applies SSE-S3 default encryption. **No KMS**: a customer
  key is a metered service and unnecessary for lab state.

## Credential rule (F7 — hard rule)

**No `access_key` / `secret_key` may ever appear in `-backend-config`
arguments.** Backend credentials resolve from the standard AWS environment
chain ONLY (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional
`AWS_SESSION_TOKEN`). Putting key material in shell args leaks it into
shell history and process listings.

## Bucket requirements (created by the human operator, out-of-band)

This task and the lab root do NOT create the bucket — the root must not
create its own state dependency, and creating it is a live mutation.

- Versioning **ON** (OpenTofu recommends it; lock objects create versions).
- Bucket policy denying non-TLS writes (`aws:SecureTransport` false → deny).
- Default encryption SSE-S3 (no KMS).
- Optional retention: an S3 lifecycle rule expiring noncurrent versions
  (e.g. after 90 days) — operator-applied, documented here as the retention
  policy. State footprint is one state object plus lock objects, < 100 KB;
  monthly cost < $0.01 even at full S3 Standard price — negligible under
  the Free-plan credits.

## Reproducibility between cycles

The two proof cycles are **not** re-inits: the state persists in the same
bucket/key across cycle 1 and cycle 2 (external to the disposable EC2
resources, which are destroyed each cycle). Cycle 2 begins from
`tofu state list` = empty — the pre-apply zero-state check enforces the
from-zero invariant against this backend.

## Cleanup

After the two-cycle proof completes, deleting the state key
(`s3://<bucket>/lab.tfstate*`) is a **manual, out-of-band, optional**
operator action. The bucket itself may be deleted when the lab is retired.

## IAM surface

The lab executor principal gets exactly the five S3 actions the OpenTofu
backend documents — `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`,
`s3:DeleteObject`, `s3:PutObjectTagging` — scoped to the bucket and the
`lab.tfstate*` prefix. See
`infra/providers/aws/iam/opnory-lab-executor.policy.json`.
