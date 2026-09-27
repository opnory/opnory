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
- `providers/` — provider implementations. **Two** exist as of Phase
  1B-COST-SAFETY: `aws/` (selected live-proof target, Free plan,
  t_8c16b5ad) and `hetzner/` (implemented in Phase 1B-A, non-selected —
  its live execution was abandoned before any mutation because zero
  out-of-pocket cost became the governing constraint; its executor stays
  blocked). See `environments/lab/PHASE-1B-SYNTHESIS.md` §20.
- `environments/` — per-environment roots. Only `lab/` will ever create
  resources in Phase 1A; `staging/` and `production/` are placeholders only.
- `bootstrap/cloud-init/` — first-boot cloud-config (deployment user, SSH key,
  Python for Ansible). Nothing else.
- `ansible/` — inventory generation, roles, and `site.yml`. Run from the
  operator machine against the lab host rendered by OpenTofu outputs.
- `repro-harness/` — deterministic Phase 1 lifecycle destruct-test harness and
  evidence schema (owned by opnory-executor; live mutation is policy-blocked
  in Phase 1A).

## Phase 1B-COST-SAFETY status

**AWS FREE-PLAN PROVIDER IMPLEMENTED — LIVE TWO-CYCLE PROOF NOT YET
EXECUTED. ZERO LIVE MUTATIONS.**

The AWS provider stack is implemented and statically wired; the harness
applies the fail-closed gates (preflight environment/label/graph-count
assertions, pre-apply zero-state, mutation budget 60, human authorization
env, the human Free-plan confirmation gate, 4h cycle cap +
destroy-on-abort, 15+1 escape guards). Live apply/destroy still requires a
human per `docs/security/iac-phase1b-execution-contract.md` plus the
operator prerequisites in
`environments/lab/PHASE-1B-SYNTHESIS.md` §20 (IAM principal, state bucket,
AMI owner verification — all created/verified out-of-band by the human).
`tofu apply` without those gates cannot run. Zero out-of-pocket cloud cost
is the governing constraint: the lab burns credits, never a card, and
only within the Free-plan window (expiry/credit exhaustion ends the
executable live-proof window). No production readiness claim follows from
this lab proof.

## Repository / security boundaries

- No `.tfstate`, plans, generated inventory, runtime `.env`, rendered storage
  credentials, SSH private keys, or provider credentials are committed
  (`.gitignore` enforcement + secret scanning in CI).
- State backend is out-of-band (configured per-environment at apply time, not
  committed).
- Fork PRs never receive provider credentials or OIDC trust (see
  `.github/workflows/iac-pr.yml`).
