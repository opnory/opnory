# ADR 0010: AWS Compatibility Through Floci

**Status:** Accepted
**Date:** 2026-09-07
**Authors:** Opnory Platform

## Context

Opnory's observability hardening plan initially targeted a real AWS S3 bucket for the
destructive object-store durability gate. That would require an AWS account, a
least-privilege IAM user, and long-lived access keys in the normal development or proof
path — all of which couple Opnory core to a specific cloud provider's control plane.

The principle held across Opnory's evidence discipline — *preference must not become a
conclusion, and infrastructure must remain provider-neutral unless a decision establishes
otherwise* — argues against making AWS the architectural authority for development, test,
certification, or integration behavior.

Floci (free, open-source, MIT-licensed local AWS emulator, S3 among its supported
services) provides a canonical, no-account boundary for the AWS-compatible behaviors that
do legitimately arise in tests. It is an **emulator**, and is used as one — never as
evidence of production durability.

## Decision

> **AWS compatibility is mediated through Floci.**
>
> Opnory does not require a live AWS account for its normal development, test,
> certification, or integration paths. Where AWS-compatible behavior is required, Floci is
> the canonical emulator boundary. Production infrastructure must remain provider-neutral
> and self-hostable unless a separate architecture decision establishes otherwise.

Layering:

```text
Opnory code
    ↓
provider-neutral interfaces
    ↓
S3-compatible / identity / integration adapters
    ↓
Floci when AWS compatibility is required

Never:
Opnory core → AWS SDK/service as architectural authority
```

## Consequences

### Enforcement rules

1. No direct AWS-specific dependency in Opnory core without architecture review.
2. No AWS account or AWS credential may become required for the standard
   development / test / CI path.
3. AWS-compatible tests use Floci.
4. Floci evidence proves AWS API compatibility only. It does **not** prove production
   cloud durability or availability.
5. Production persistence integrates through provider-neutral interfaces, such as
   S3-compatible object storage, rather than AWS being architectural authority.

### Impact on the observability hardening plan

The "real AWS S3" Gate 1 target is removed. The object-store durability gate is split:

- **Gate 1A** (local, now): SeaweedFS — a self-hostable OSS S3-compatible store — in a
  single-node mode, proving Tempo-to-object-store durability,
  classified `SELF-HOSTED LIVE — SINGLE NODE`. It explicitly does **not** prove
  production storage HA/durability. See
  `docs/observability-production-hardening-criteria.md`.
- **Gate 1B** (later, multi-node): production object-store durability against a
  not-yet-selected candidate (SeaweedFS distributed, Ceph RGW, or another qualifying OSS
  backend). This ADR does not preselect that winner.

## Numbering

ADR 0009 is reserved for the production observability backend selection (several existing
evidence documents already reference it). This decision is therefore ADR 0010 and does not
renumber the observability trail.