# Change-management exception — 2026-09-15

Commit `e9e1afd441636d02b5eef845f9afa63d28250c5d` was applied directly to `main` after PR #10 merged.

## Scope

- `ops/self-hosted-seaweedfs/verify-durability.sh`
- Git mode only: `100644` → `100755`
- File contents unchanged

## Rationale

The canonical Gate 1A verifier is documented as directly executable. The mode
correction restored that intended repository state.

## Evidence impact

No verifier logic, configuration, credentials, infrastructure, or
least-privilege semantics changed. The previously completed controlled Gate 1A
proof was therefore not rerun solely for this mode correction.

## Process classification

This direct commit did not follow the normal ADR 0011 PR path and is recorded
as a change-management exception. Future normal repository changes continue to
use PR-based review/merge flow.

## Compliance

This record is evidence of process transparency only. It does not by itself
establish SOC 2 compliance or certification.
