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
- `providers/` — provider implementations. **Exactly one** initial provider may
  exist in Phase 1A. Currently **none**: the provider choice is unresolved from
  repository evidence (no compute credentials/configuration exist in this
  repo). See `environments/lab/PROVIDER-UNRESOLVED.md`.
- `environments/` — per-environment roots. Only `lab/` will ever create
  resources in Phase 1A; `staging/` and `production/` are placeholders only.
- `bootstrap/cloud-init/` — first-boot cloud-config (deployment user, SSH key,
  Python for Ansible). Nothing else.
- `ansible/` — inventory generation, roles, and `site.yml`. Run from the
  operator machine against the lab host rendered by OpenTofu outputs.
- `repro-harness/` — deterministic Phase 1 lifecycle destruct-test harness and
  evidence schema (owned by opnory-executor; live mutation is policy-blocked
  in Phase 1A).

## Phase 1A status

**IAC PHASE 1A IMPLEMENTATION VERIFIED — LIVE REPRODUCIBILITY PROOF PENDING.**

Provider implementation is intentionally absent; the preflight gate in
`repro-harness/scripts/preflight.py` fails closed until an initial provider is
chosen and implemented under `infra/providers/<name>/`.

## Repository / security boundaries

- No `.tfstate`, plans, generated inventory, runtime `.env`, rendered storage
  credentials, SSH private keys, or provider credentials are committed
  (`.gitignore` enforcement + secret scanning in CI).
- State backend is out-of-band (configured per-environment at apply time, not
  committed).
- Fork PRs never receive provider credentials or OIDC trust (see
  `.github/workflows/iac-pr.yml`).
