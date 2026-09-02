# AGENTS.md — Operating Contract for Autonomous Coding Agents

This file is the operating contract for coding agents working in **Opnory**.
It is written for an agent that must make correct, bounded, verifiable changes
without a human in the loop. Read this before touching code. It is deliberately
short: for deeper material, load the document named, don't guess from memory.

Opnory is an AI-powered IT service desk with a governance engine that fulfills
access requests across identity providers (Entra ID, Okta, GitHub, SCIM). It is
a TypeScript monorepo (Bun runtime, strict `tsc`, turbo, oxlint, prettier).

---

## 1. Documentation index (load the doc that matches the task)

| Task                                         | Load                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| Understand the provider fulfillment contract | `docs/architecture/adr/0003-fulfillment-adapter-conformance-contract.md` |
| Understand what is architecturally frozen    | `ARCHITECTURE_FREEZE.md`                                                 |
| Governance domain model / RBAC foundation    | `docs/architecture/adr/0002-rbac-as-governance-foundation.md`            |
| Capability runtime / plugin extension        | `docs/architecture/adr/0004-capability-runtime-spike.md`                 |
| Tenant integration lifecycle semantics       | `docs/architecture/adr/0006-production-tenant-integration-lifecycle.md`  |
| How to contribute / PR rules / DCO           | `CONTRIBUTING.md`                                                        |
| Security reporting + redaction policy        | `SECURITY.md`                                                            |
| Product / edition / legal                    | `README.md`                                                              |

Do not copy these documents into your answer or into code. Load them when the
task needs them.

---

## 2. Critical invariant: the architecture freeze

Two files are **frozen** and must never be changed without explicit human
architectural review and full re-certification:

- `packages/governance-core/src/adapters/fulfillment.ts` — the `FulfillmentAdapter` contract
- `packages/governance-core/src/adapters/conformance.ts` — the certification harness

Also frozen (implementation layer, re-certification required on any change):

- `packages/governance-core/src/adapters/entra-adapter.ts`
- `packages/governance-core/src/adapters/okta-adapter.ts`

Rules (from `ARCHITECTURE_FREEZE.md`):

1. No semantic change to the contract, types, factory behaviors, harness logic,
   fixture structure, or evidence schema.
2. Any change requires architectural review + re-running the conformance harness
   against both providers (5/5 Entra, 3/3 Okta fixtures) + a new certification tag.
3. Static enforcement exists (opnory oxlint rules); a lint error on these files is
   a red line, not a style nit.

If your task touches these files at all, **stop and flag it** before editing.
This is the highest-severity boundary in the repository.

---

## 3. Architecture and ownership boundaries

Opnory is a layered monorepo. Ownership is a real constraint — do not route
responsibilities across a boundary that does not own them.

| Layer / concern                                            | Owns                                                                                                                                     | Packages                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Domain + contract**                                      | Access-request domain model, policy evaluation, fulfillment contract, certification harness. Only dependency is `zod`. Provider-neutral. | `governance-core`, `access-types`, `access-policy`                                                   |
| **Orchestration**                                          | Request lifecycle, escalation, agent reasoning over knowledge. Composes other layers; holds no provider I/O.                             | `agent`, `access-service`, `escalation`                                                              |
| **Persistence**                                            | Durable storage (PostgreSQL), optimistic concurrency, leases. Uses parameterized queries only.                                           | `access-store-pg`, and the PG repos in `integration-runtime`                                         |
| **External I/O (the ONLY place provider APIs are called)** | Entra/Okta/GitHub HTTP + Graph calls, credential-held clients.                                                                           | `governance-core/src/adapters/*`, `access-executor`, `integrations`, `integration-runtime/plugins/*` |
| **Plugin/runtime extension**                               | Tenant-scoped capability registry, plugin lifecycle, secret store. Core owns authority; plugins provide capabilities only.               | `integration-runtime`                                                                                |
| **Cross-cutting**                                          | Logging/redaction, config/secret loading, shared types, knowledge retrieval.                                                             | `observability`, `config`, `types`, `knowledge`                                                      |
| **Entry points**                                           | HTTP API, Slack app.                                                                                                                     | `apps/api`, `apps/slack`                                                                             |

Rules that follow from this:

- **Provider identifiers never enter policy/domain objects.** Entra group IDs,
  Okta group IDs, GitHub team slugs live only in `Permission.mappings[].value`
  and adapter internal state. Policy decisions use Opnory identifiers only.
- **Only adapters talk to external services.** Do not add an HTTP call to a
  provider from `agent`, `access-policy`, or `access-service`.
- **Persistence is parameterized.** No raw SQL string concatenation. External
  input is parsed by `zod` schemas at the boundary before entering domain code.
- **State that is canonical**: PostgreSQL rows (access requests, tenant
  integrations). Runtime state is reconstructible, not canonical. See
  `docs/architecture/adr/0006-production-tenant-integration-lifecycle.md` for
  the desired-vs-actual split.
- **Idempotency is a contract, not an optimization.** `grant`/`revoke` must be
  idempotent (second call returns `mutated: false`, never throws on already-exists).
- **Mutations are distinguished from success.** `FulfillmentResult.mutated` is
  explicit; `mutated: false` on a DELETE-404 is success, not failure.
- **Fail closed.** Unknown provider errors are `failed`, never guessed `success`.

Do not infer an ownership rule from a directory name. Confirm it from the actual
imports and the ADRs before recording a new boundary.

---

## 4. Mutation discipline

### Read-only work

Research, inspection, analysis, code review, comparison, planning, and
documentation do not require any bookkeeping. Read anything; change nothing.

### Repository-changing work

Before any broad implementation:

1. Identify the **smallest coherent change** and its ownership boundary.
2. Read the relevant contract/ADR first (the freeze + conformance contract above).
3. Do **not** bundle unrelated cleanup, refactoring, or "while I'm here" edits.
4. Preserve unrelated user changes in the working tree.
5. Add or update tests for changed behavior.
6. Validate the narrowest relevant scope first, then the broader gate (section 7).

If a change would cross a frozen boundary or alter a documented contract, stop
and escalate instead of proceeding.

---

## 5. Proof hierarchy (state the level you actually reached)

Lower evidence must not be described as proving a higher behavior. Choose the
level your validation actually exercised, and say so in the handoff.

| Level                      | What it proves                            | How                                          |
| -------------------------- | ----------------------------------------- | -------------------------------------------- |
| 1. Source inspection       | Code looks right                          | reading                                      |
| 2. Unit / contract test    | Isolated behavior                         | `bun test` (specific file)                   |
| 3. Integration test        | Multiple modules together                 | `bun test` (package test)                    |
| 4. Full local gate         | Whole repo builds/tests/typechecks/lints  | section 7 commands                           |
| 5. Real-PostgreSQL proof   | Durable behavior against a real DB        | `OPNORY_RUN_PG_INTEGRATION_TESTS=1 bun test` |
| 6. Provider sandbox (live) | Real Entra/Okta/GitHub behavior           | `bun run live:entra` / `live:okta` (opt-in)  |
| 7. Human verification      | Subjective/security-sensitive correctness | named human sign-off                         |

If an acceptance criterion requires an environment you cannot reach (e.g. a live
provider), report that proof as **missing**, do not silently downgrade the
criterion. Never claim a live result from a unit test.

---

## 6. Dependency adoption

Before adding or substantially upgrading a dependency, review and record at least:

- license compatibility (BSD-2-Clause repo); maintenance health; security record
- TS/ES runtime compatibility with **Bun 1.4.0** and the repo's `tsc` config
- dependency-tree and size impact; startup/runtime impact; network/data behavior
- existing stdlib or already-present alternative (`zod`, `node:crypto`, `pg`)
- migration cost and rollback path

The install must be reproducible: use `bun install --frozen-lockfile` and commit
the lockfile. Pin runtime-sensitive deps to exact versions (see `apps/api`
Fastify pin as precedent). If the dependency exists for perf/reliability, provide
evidence against the current implementation. External source may be _studied_ as
a reference but never copied without verifying its license.

---

## 7. Validation commands (these are the real ones)

Run in this order — narrowest first, broadest last.

```bash
bun install --frozen-lockfile      # reproducible install (CI parity)

# Narrow
bun test <path/to/test>            # specific test file first

# Normal agent loop (must all be green before handoff)
bun run typecheck                  # tsc across all packages (turbo)
bun run build                      # tsc emit across all packages (turbo)
bun test                           # full unit/contract suite
bun run lint                       # oxlint (0 errors; see warning policy below)

# Optional, environment-gated
bun run format                     # prettier (run before committing, not as a "check")
OPNORY_RUN_PG_INTEGRATION_TESTS=1 OPNORY_TEST_DATABASE_URL=postgresql://... bun test  # real-PG durable proof
bun run live:entra                 # live Entra sandbox (see section 8)
bun run live:okta                  # live Okta sandbox
```

Notes:

- **Lint warnings vs errors.** `bun run lint` passes when there are no _errors_.
  Warnings are pre-existing across the repo and are NOT a license to add more.
  Do not silence a warning with `eslint-disable`/`oxlint-disable` merely to make
  a number go down; fix the underlying issue or leave the honest warning.
- **No fake commands.** Do not invent a `make` target or script that does not
  exist. If a validation gap matters, report it, don't paper over it.

---

## 8. Security, secrets, and live tests

Hard prohibitions (also in `CONTRIBUTING.md` and `SECURITY.md`):

- Never commit, log, or emit `.env` values, tokens, client secrets, private keys,
  tenant IDs, object IDs, sandbox resource IDs, or `.live-results/` evidence.
- Never bypass an authorization check, weaken TLS/cert validation, or silently
  broaden a permission scope for convenience.
- Never pass untrusted input to a provider or a shell without zod validation and
  appropriate isolation.
- `opnory.*` attributes and structured logging carry automatic redaction; do not
  add a parallel secret channel.

Configuration is loaded via `@opnory/config` (`packages/config`); secrets flow
through the `SecretStore`/`CredentialProvider` boundary in `integration-runtime`
and are referenced by opaque `credentialRef` only — never persisted raw.

**Live governance tests are opt-in and gated.** They require
`OPNORY_LIVE_GOVERNANCE_TESTS=true` plus a provider-specific confirmation env var
(e.g. `OPNORY_ENTRA_SANDBOX_CONFIRM=true`). **Never run live tests in CI on a
public fork.** Live certification must leave zero residue: every grant is
verified, revoked, re-verified absent (ADR 0003 invariant #7).

---

## 9. Git and multi-agent hygiene

- Inspect the working tree (`git status`, `git diff`) before mutating anything.
- Never overwrite unrelated user work. No destructive `git reset --hard` /
  `git checkout --` against changes you did not author.
- No force-push without explicit human permission.
- Before a final push when other agents may be active: `git fetch` + reconcile.
- `git pull --rebase` for linear history; make logical, atomic commits (DCO
  `-s` sign-off is required — see `CONTRIBUTING.md`).
- Distinguish, in every handoff, between **modified**, **committed**, and
  **pushed** state. They are different things.

Files most likely to be touched by multiple agents concurrently: none are
formally locked, but treat `oxlint.config.ts`, `package.json` (root), and the
frozen adapters as high-coordination — touch them only when your task requires
it, and re-sync immediately before pushing.

---

## 10. Clean-stop contract

At the end of every task, classify your Git state into exactly one of:

**FULLY CLEAN** — all task changes committed as appropriate, upstream
synchronization done, no unexpected dirty paths remain.

**PROTECTED-DIRTY STOP** — only clearly-identified pre-existing or user-owned
dirty paths remain untouched; your work has reached its valid Git stop.

**DIRTY / FAILED STOP** — your uncommitted work remains; unexpected dirty state
exists; you changed a protected/frozen file without approval; a required push
failed; or branch/upstream state is unresolved.

Passing tests does NOT imply a clean stop. State the classification explicitly.

---

## 11. Final handoff contract

Every implementation handoff must state, concisely:

1. **What changed** (files, behavior).
2. **What was deliberately preserved** (contracts, existing behavior, unrelated code).
3. **What validation was performed** (exact commands and results).
4. **Proof level reached** (section 5 level, e.g. "Level 4 — full local gate").
5. **Proof still missing** (what you could not verify and why).
6. **Remaining risks/blocks.**
7. **Git/clean-stop state** (section 10 classification).

Keep it short enough that an agent will actually produce it. A handoff without
items 4–7 is incomplete.
