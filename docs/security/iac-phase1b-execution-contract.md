# Opnory IaC — Phase 1B Live Execution Contract

**Status:** issued by synthesizer t_f50d530a after verifier t_f7a3c40a GATE=PASS.
**Supersedes:** none. First live gate for the Opnory-IaC swarm.
**Maximum permitted Phase 1A claim (unchanged):**
`IAC PHASE 1A IMPLEMENTATION VERIFIED — LIVE REPRODUCIBILITY PROOF PENDING`.

This document is the contract for the next mutation-bearing run. It stays
dormant inside the repo until a human explicitly invokes it.

---

## 1. Prerequisites that must hold BEFORE any live run

The harness will refuse to start unless every one of these is true. Do not
edit the harness around them.

1. **Provider selection resolved.** Exactly one provider implementation lives
   under `infra/providers/<name>/` with root modules and outputs matching the
   host-contract in `infra/modules/host-contract/`. The current tree has
   `infra/providers/` intentionally empty — see
   `infra/environments/lab/PROVIDER-UNRESOLVED.md`. Until one real provider
   module exists, `preflight.py` exits non-zero.
2. **Real target file.** The operator composes a lab target at a
   non-committed path (not the shipped
   `infra/repro-harness/config/lab.target.example.json`). `preflight.py`
   refuses the example file; the real file must include concrete
   `state_identity`, `expected_dns_zone`, and `allowed_provider_account_hint`.
3. **Environment gate.**
   `OPNORY_IAC_PHASE=1B`
   `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab`
   Both must be set in the invoking shell. The lifecycle driver hard-blocks
   `apply`/`destroy` without `OPNORY_IAC_LIVE_AUTHORIZED` equal to that exact
   string, and `1A` is the default.
4. **Human authorization recorded.** A named human operator signs the run
   (see §7) before `lifecycle.py` is invoked for any mode other than
   `dry-run` / `static`. That signature is the only mechanism by which
   *live* is permitted; the harness never asks interactively.

## 2. Provider/environment identity checks the harness will do

Before any mutation, `lifecycle.py` runs `preflight.py`, which enforces:

- `environment == 'lab'`; other environments (staging/production) refuse.
- The named provider module exists (resolves the unresolved-provider FAIL).
- The operator-supplied `allowed_provider_account_hint` is parsed and
  matched by the provider probe the operator wires in (see §3). The probe
  confirms the credentials in context target the intended account and no
  other.
- The target file is not the committed example file.
- No `.tfstate` / `.tfplan` files exist under `infra/` from a previous run.
- `mutation_budget` is present and > 0; each cycle must stay at or under the
  budget.

## 3. Provider-side identity probe (operator responsibility)

The harness deliberately does not embed one. Before invoking `lifecycle.py
--mode live`, the operator executes the provider-native identity check that
is appropriate for the selected provider (for example subscription /
project / account lookup) and asserts its output matches
`allowed_provider_account_hint`. Evidence of this probe (redacted per
§5) is captured into the evidence JSON.

## 4. Mutation budget

- Budget lives in the target file: `mutation_budget: 60` (placeholder from
  the example; the operator may lower it, never raise it without an explicit
  architecture sign-off alongside the run).
- `infra/repro-harness/scripts/mutation_ledger.py` is the sole ledger. It is
  append-only. Every `apply` and `destroy` step appends one record:
  `{cycle, step, action, count, timestamp}`.
- If a cycle exceeds the budget the ledger write itself exits non-zero and
  the lifecycle driver stops; partial mutations are reconciled by the
  operator before any retry.

## 5. Evidence

- Output: `infra/repro-harness/scripts/render_evidence.py` writes an
  `*.opnory-iac-evidence.json` (gitignored). The file passes
  `infra/repro-harness/schema/evidence.schema.json` and goes through the
  sanitizer, which redacts IP/CIDR, hostname, account ID, and any string
  matching the secret-shaped patterns before persistence.
- Redacted evidence may be attached to a task comment as a pointer only;
  the raw file path is the canonical artifact.
- `.live-results/` and any equivalent directory are never committed, per
  `AGENTS.md §8`.

## 6. Teardown requirements

- Phase 1B success means **two full cycles** from zero:
  `apply → configure → verify → destroy → verify-absent`, repeated, both
  passing.
- `verify_opnory.sh` is the only health verdict; compose smoke and Host
  HTTP are both required signals. A green `apply` with a failing verify
  blocks the verdict.
- After the second cycle, no cloud resources may remain. The final
  `verify-absent` step runs after the last destroy; absence is the exit
  criterion, not the destroy return code.
- Zero residue matches ADR 0003 invariant #7: every grant is verified,
  revoked, re-verified absent.

## 7. Human authorization boundary

- Only a named human may set `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab`.
- The agent must never set it. The agent must never prompt for it in a way
  that would execute apply/destroy without the human typing it themselves.
- CI must not run `lifecycle.py --mode live`. `iac-pr.yml` runs
  static/lint/smoke only; there is no apply workflow by design.

## 8. What this contract explicitly does NOT authorize

- Real provider credentials on this machine beyond a single operator's
  scope.
- Mutation of DNS outside the lab zone named in the target file.
- Production or staging environment flips.
- Bypass of `preflight.py`, the mutation ledger, or the sanitizer.

## 9. Where the boundary lives in code

- `infra/repro-harness/scripts/preflight.py` — fail-closed checks.
- `infra/repro-harness/scripts/lifecycle.py` — two-cycle driver, Plan/Apply/
  Verify/Destroy/VerifyAbsent steps.
- `infra/repro-harness/scripts/mutation_ledger.py` — append-only ledger.
- `infra/repro-harness/scripts/render_evidence.py` — redacted evidence.
- `infra/modules/host-contract/validate_contract.py` — stable output schema
  and secret-shape rejection.
- `infra/providers/` — empty. Block until one provider is implemented.
