# ADR 0011 — Solo-maintainer branch protection model

## Status
Accepted

## Context

Opnory is currently a solo-maintainer project. GitHub's branch protection rule
`required_approving_review_count: 1` is structurally unsatisfiable for a
single maintainer because GitHub does not count the PR author as an
approving reviewer.

This created a permanent block: every PR required an approval from a
non-existent second maintainer. The only workaround was an admin bypass
(`gh pr merge --admin`), which defeats the review gate's purpose and leaves
no audit trail.

## Decision

Change `main` branch protection to:

- **Require PR**: yes
- **Required approving reviews**: 0
- **Require conversation resolution**: yes
- **Force pushes**: prohibited
- **Branch deletions**: prohibited
- **Status checks**: none configured (no CI pipeline exists yet)

This models "PR required, independent approval not required" — the PR
provides review surface, diff, evidence record, rollback point, and history,
while acknowledging the solo-maintainer reality.

## Restore condition

When a second maintainer joins the project, re-enable
`required_approving_review_count: 1` (and later add required CI status
checks when a pipeline exists).

## Evidence

- PR #3 (SeaweedFS least-privilege + Gate 1A durability verifier) was
  merged at `76918cb8` without an independent approval by design.
- Technical review occurred out-of-band via the blocker-resolution cycle
  (`e2901c6`) and Option A evidence ratification (explicit-window
  TraceQL controls pre-recreate, trace-by-ID durability post-recreate,
  control-bucket AccessDenied cross-bucket isolation).
- The branch-protection change was applied via GitHub REST API and is
  recorded in this ADR for versioned auditability.

## Consequences

- Future PRs can self-merge via the normal path once all conversations
  are resolved.
- The review gate is not "weakened" — it is correctly matched to the
  actual team structure.
- A future collaborator will find the rationale in this ADR rather than
  inferring an accidental weakening from branch settings.