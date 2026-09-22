# IaC Phase 1A security review — swarm t_30fa71ec, worker t_5b2e13e4

Scope: adversarial review of state, secrets, OIDC/CI trust, public-fork
exposure, firewall/DNS exposure, generated artifacts, .gitignore coverage,
IaC scanning, secret scanning, and evidence sanitization across the builder
(t_e32e70d2) and executor (t_2b149086) Phase 1A outputs. Concrete fixes applied
within the security-worker ownership boundary; nothing here weakens Gate 2 /
Gate 3 controls and no live provider mutation was performed or is possible
from this change set.

## Verdict

- No committed secret material (gitleaks 9.57 scan over full tree: 0 leaks;
  forbidden-pattern scan confirms only deliberate negative fixtures inside
  `infra/repro-harness/tests/run_tests.sh`).
- Plan/state/ledger/evidence/inventory artifacts are all excluded by
  `.gitignore`; preflight.py additionally scans for committed state/plan
  artifacts at runtime (fail-closed).
- CI (`iac-pr.yml`) runs with `permissions: contents: read`, no OIDC
  (`id-token`) permission anywhere, no environment, no secrets beyond
  `GITHUB_TOKEN`; fork PRs are structurally unable to reach credentials.
  No apply workflow exists — Phase 1B must introduce one behind a protected
  GitHub Environment plus environment/provider identity assertions.
- apply/destroy are hard-blocked in two independent places (preflight phase
  check + per-step harness checks) and cannot fire while
  `OPNORY_IAC_PHASE=1A` (the default).
- Evidence validator rejects credential-shaped content and rejects a PASS
  claim without exactly two PASS cycles at/inside budget.

## Findings and fixes applied in this workspace

F1 (fixed) — `compose.yml.j2` `DATABASE_URL` contained a literal `***`
placeholder: the rendered stack would have been non-functional, and the
placeholder masked how the secret actually flows. Now `${POSTGRES_PASSWORD}`,
resolved by compose from the operator-provided project env file
(`/srv/opnory/.env`, asserted mode 0600); never from OpenTofu outputs.

F2 (fixed) — The rendered compose smoke test in CI passed the Jinja
`{{ opnory_http_port }}` placeholder into a published port and the
`{{ opnory_env_file }}` placeholder into `env_file`, so
`docker compose config` could never succeed; the previous "port check" was
also a negated-pipeline no-op. CI now substitutes a numeric port and an empty
env file, and negatively asserts that no private service port
(5432/6379/3100/4317/3000) is published.

F3 (fixed) — grafana consumed the FULL application env file (all app secrets)
via `env_file`. Now uses a dedicated `opnory_grafana_env_file`
(`/srv/opnory/.env.grafana`, asserted mode 0600) — least privilege inside the
compose network.

F4 (fixed) — lifecycle.py wrote the tofu plan to a predictable
world-readable `/tmp/opnory-lab.tfplan` (plan content can embed sensitive
attribute values). Now uses a private mkdtemp (`opnory-iac-XXXXXX`, 0700).

F5 (fixed) — harness default `ssh_user` was `opnory-deploy` while
cloud-init creates only `opnory`; first live run would have failed to
connect. Default corrected to `opnory` in lifecycle.py and the example
target config.

F6 (fixed) — Ansible inventory path in lifecycle.py pointed at
`infra/ansible/inventories/lab` (a directory that will not exist); the
rendered inventory is `lab.generated.yml`. Path corrected and made
configurable via `ansible_inventory`.

F7 (fixed) — `.gitignore` had no coverage for `*.tfvars` (operator CIDRs,
identity, sizing). Added `infra/**/*.tfvars` with an `*.example.tfvars`
exception.

F8 (fixed) — docker role assumed `/etc/apt/keyrings` exists; added an
explicit directory task so first-run on a minimal image cannot fail.

## Residual observations (accepted / deferred; not Phase 1A blockers)

R1 — cloud-init grants the deploy user passwordless sudo. Standard for a
single-user disposable lab whose only access path is SSH public key; sshd
password auth is disabled by the base role and SSH is rate-limited. Revisit
if a non-lab environment is ever defined.

R2 — `StrictHostKeyChecking=accept-new` in the lifecycle SSH steps is
trust-on-first-use; acceptable for a freshly created disposable lab whose
DNS is created by the same plan, and strictly better than `no`. A Phase 1B
hardening option is pinning the host key from cloud-init console output.

R3 — checkov runs `soft_fail: false` — with zero `.tf` files in Phase 1A it
validates nothing real today; its value begins when the provider stack
lands. Keep it blocking so Phase 1B findings surface immediately.

R4 — `apt_key` is deprecated upstream but functional and not a security
boundary here; acceptable for Phase 1A.

## Evidence

- gitleaks 9.57 dir scan of the merged tree: 0 leaks.
- harness self-tests: 16/16 pass after all fixes
  (`bash infra/repro-harness/tests/run_tests.sh`).
- rendered compose stack validates with `docker compose config` (rc=0) and
  publishes no private service port.
- No file under `packages/governance-core/src/adapters/` was touched; frozen
  contracts untouched. Historical `ops/self-hosted*` evidence stacks
  untouched.
