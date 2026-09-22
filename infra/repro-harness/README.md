# IaC Reproducibility Harness (Phase 1A)

Deterministic lifecycle and destructive-test harness for the Opnory disposable
one-host lab, plus the evidence schema the Phase 1B live run must satisfy.

Owns (swarm task opnory-executor):

- the lifecycle orchestrator for the two-cycle acceptance sequence
- fail-closed preflight checks (environment/provider/state identity)
- the append-only mutation ledger and budget accounting
- the evidence schema and validator
- the live-execution authorization boundary

Does NOT own: provider implementations, Ansible roles, the Compose runtime,
the ADR. Those belong to opnory-builder / opnory-architect.

## Hard rules (fail-closed by construction)

1. **No provider mutation in Phase 1A.** `apply` / `destroy` are refused by
   policy while `OPNORY_IAC_PHASE` is unset or `1A`, regardless of any other
   authorization. Live mutation requires `OPNORY_IAC_PHASE=1B` *and* the
   human-set env var `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab`.
2. **Lab only.** Target configs whose `environment` is not `lab` fail
   preflight. There is no flag to override this.
3. **Provider must be real.** Preflight fails unless
   `infra/providers/<provider>/` exists. Since the initial provider is
   currently UNRESOLVED (see ADR 0012 §5), live execution is blocked until the
   builder lands exactly one provider.
4. **Preflight is not skippable.** `lifecycle.py` runs `preflight.py` for real
   in every mode, including dry-run.
5. **Evidence is sanitized by contract** (`schema/evidence.schema.json`) and
   additionally scanned for private-key/credential shapes at validation time.

## Layout

```
infra/repro-harness/
├── README.md
├── schema/
│   └── evidence.schema.json    # machine-readable evidence contract
├── config/
│   └── lab.target.example.json # example target; never usable for a real run
├── scripts/
│   ├── preflight.py            # fail-closed checks; exit 0 or 3
│   ├── lifecycle.py            # orchestrator; default mode is dry-run
│   ├── mutation_ledger.py      # append-only mutation accounting + budget
│   ├── render_evidence.py      # schema + secret-shape validator for evidence
│   └── verify_opnory.sh        # Phase 1B placeholder; fails closed today
└── tests/
    └── run_tests.sh            # self-tests (non-mutating)
```

## The acceptance sequence (Phase 1B, run twice from zero)

```
empty environment
  → preflight (always executed)
  → tofu plan
  → tofu apply
  → cloud-init completes
  → ansible-playbook site.yml (converge)
  → docker compose up
  → workload health probe
  → Opnory verification
  → tofu plan (post-apply drift: must be empty)
  → ansible-playbook site.yml (idempotence: 0 changes)
  → tofu destroy
  → post-destroy residue check (zero resources remain)
  → repeat entire sequence from zero → PASS
```

## Usage

Dry-run (default; safe; CI-appropriate):

```bash
python3 infra/repro-harness/scripts/lifecycle.py \
  --target /path/to/lab.target.json --mode dry-run
```

Static checks (tofu validate with backend disabled, no mutation):

```bash
python3 infra/repro-harness/scripts/lifecycle.py \
  --target /path/to/lab.target.json --mode static
```

Live (Phase 1B only, requires phase + human authorization):

```bash
OPNORY_IAC_PHASE=1B \
OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab \
python3 infra/repro-harness/scripts/lifecycle.py \
  --target /path/to/lab.target.json --mode live --cycles 2
```

Validate an evidence document:

```bash
python3 infra/repro-harness/scripts/render_evidence.py /path/to/evidence.json
```

Run the harness self-tests:

```bash
bash infra/repro-harness/tests/run_tests.sh
```

## Target config

Copy `config/lab.target.example.json` to a path outside the repository (or a
gitignored location) and fill it in. The committed example is rejected by
preflight by design. The harness reads only non-secret data from the target
config: environment, provider key, tofu working directory, state identity,
SSH username, compose project dir, and the mutation budget.

## Mutation accounting

Every mutating lifecycle step appends to the ledger (`--ledger`, default
`/tmp/opnory-iac-mutations.jsonl`). After each run, observed mutations are
compared against `mutation_budget` in the target config; overflow fails the
run. Ledger entries are sanitized facts only: step, action, count, timestamp.

## Evidence

`lifecycle.py` writes one evidence JSON document per run covering both cycles.
`render_evidence.py` validates it against `schema/evidence.schema.json` and
rejects documents containing credential-shaped strings. Evidence that claims
`overall_result=PASS` without two PASS cycles — or over budget — is rejected.

## What Phase 1A does NOT prove

This harness being implemented and self-tested does not prove live
reproducibility. The strongest honest claim remains:

> IAC PHASE 1A IMPLEMENTATION VERIFIED — LIVE REPRODUCIBILITY PROOF PENDING

(ADR 0012, "Phase 1B gate".)
