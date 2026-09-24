# Opnory Infrastructure as Code

Authority model per `docs/architecture/adr/0012-infrastructure-as-code.md`:

| Layer | Owns |
|---|---|
| OpenTofu | Resource lifecycle (compute, network, disks, DNS, infra identity) |
| cloud-init | First-boot bootstrap only (`bootstrap/cloud-init/`) |
| Ansible | Repeatable host state (`ansible/`) |
| Docker Compose | Application workload topology (`ansible/roles/opnory/templates/` renders `/srv/opnory/compose.yml`) |
| Shell/Python | Rendering, probes, evidence, destructive-test tooling (`repro-harness/`) |
| GitHub Actions | Orchestration and policy gates (`.github/workflows/iac-*.yml`) |

## Layout

- `modules/` — provider-agnostic building blocks.
  - `host-contract/` — the stable output contract every provider must expose.
  - `dns/` — minimal DNS record wiring (delegates records to the environment).
  - `firewall-policy/` — policy *definition* (allowed ports description, see README inside).
- `providers/` — provider implementations. **Exactly one** initial provider
  exists: `hetzner/` (Hetzner Cloud, selected by the Phase 1B verifier gate
  t_52a43bce). See `environments/lab/PHASE-1B-SYNTHESIS.md`.
- `environments/` — per-environment roots. Only `lab/` will ever create
  resources in Phase 1A; `staging/` and `production/` are placeholders only.
- `bootstrap/cloud-init/` — first-boot cloud-config (deployment user, SSH key,
  Python for Ansible). Nothing else.
- `ansible/` — inventory generation, roles, and `site.yml`. Run from the
  operator machine against the lab host rendered by OpenTofu outputs.
- `repro-harness/` — deterministic Phase 1 lifecycle destruct-test harness and
  evidence schema (owned by opnory-executor; live mutation is policy-blocked
  in Phase 1A).

## Phase 1B status

**OPNORY IAC PHASE 1B PROVIDER IMPLEMENTATION VERIFIED — LIVE TWO-CYCLE
REPRODUCIBILITY PROOF NOT YET EXECUTED.**

The Hetzner provider stack is implemented and statically wired; the harness
applies the fail-closed gates (preflight environment/label assertions,
pre-apply zero-state, mutation budget, human authorization env). Live
apply/destroy still requires a human per
`docs/security/iac-phase1b-execution-contract.md`. `tofu apply` without that
gate cannot run.

## Repository / security boundaries

- No `.tfstate`, plans, generated inventory, runtime `.env`, rendered storage
  credentials, SSH private keys, or provider credentials are committed
  (`.gitignore` enforcement + secret scanning in CI).
- State backend is out-of-band (configured per-environment at apply time, not
  committed).
- Fork PRs never receive provider credentials or OIDC trust (see
  `.github/workflows/iac-pr.yml`).
