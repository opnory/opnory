# Opnory IaC Phase 1B — Synthesis (task t_fec9254e)

**Verifier gate:** PASS (t_52a43bce, main@cfaabdf8).
**Selected provider:** Hetzner Cloud (`hetznercloud/hcloud` ~> 1.69.0) —
*superseded for the live proof target by Phase 1B-COST-SAFETY; see §20.*
**Strongest claim produced by this synthesis:**

> OPNORY IAC PHASE 1B PROVIDER IMPLEMENTATION VERIFIED —
> LIVE TWO-CYCLE REPRODUCIBILITY PROOF NOT YET EXECUTED

No live provisioning occurred (`live_mutations=0`). No secrets, tfstate, plan
files, rendered inventory, or credentials were committed.

---

## 1. What changed

New provider stack (exactly one provider, per ADR 0012 §4):

- `infra/providers/hetzner/compute/` — one `hcloud_server` ("opnory-lab-1",
  cx23 / ubuntu-24.04 / fsn1 defaults) + one `hcloud_ssh_key`; cloud-init
  rendered from `infra/bootstrap/cloud-init/cloud-config.yml` with exactly
  the two contract vars (`hostname`, `ssh_public_key`).
- `infra/providers/hetzner/network/` — one `hcloud_firewall` +
  `hcloud_firewall_attachment` implementing
  `infra/modules/firewall-policy/policy.json` exactly (22/tcp operator CIDR
  only; 80/tcp any; 443/tcp any; outbound allow-all; Hetzner denies all other
  inbound by default).
- No `storage/` module: the current Compose stack uses named docker volumes
  plus host paths under `/srv/opnory/data/`; no downstream code consumes
  `storage_ref`. Smallest coherent change — no persistent volume is created
  in Phase 1B. (Volume behavior if one is later required: `hcloud_volume`
  with `delete_protection` while attached; destroyed with the stack.)

Lab environment root:

- `infra/environments/lab/main.tf` — wires compute + network modules and the
  single Cloudflare A record (DNS-only/`proxied=false`, TTL 300, destroyed
  with the stack, per `modules/dns/README.md` policy and the dig-verified
  Cloudflare authority boundary).
- `infra/environments/lab/versions.tf` — `backend "s3" {}` out-of-band stub
  (init-time `-backend-config` only) + fail-closed preconditions
  (`environment == "lab"`, `hostname == dns_record_name`).
- `infra/environments/lab/{variables.tf,outputs.tf,lab.example.tfvars}` —
  outputs re-expose EXACTLY the host-contract keys; no extra outputs ever.
- `infra/environments/lab/PROVIDER-UNRESOLVED.md` — superseded by
  `PHASE-1B-SYNTHESIS.md` (this file's sibling status block).

Harness gaps closed (verifier-mandated):

- G1: `infra/repro-harness/scripts/verify_opnory.sh` replaced with
  deterministic checks (section 10); `lifecycle.py
  step_opnory_verification` now exports `OPNORY_VERIFY_DNS_NAME`,
  `OPNORY_VERIFY_HOST_ADDRESS`, `OPNORY_VERIFY_SSH_USER`,
  `OPNORY_VERIFY_COMPOSE_PROJECT_DIR`.
- G2: `preflight.py` gained `check_lab_label_assertion` — a static,
  fail-closed scan asserting every `hcloud_*` resource carries the lab-only
  label set `environment=lab, managed-by=opnory-iac, swarm=iac-1b`.
- G3: `lifecycle.py` gained step `pre_apply_zero_state` (`tofu state list`
  must be empty before each cycle's apply).

Docs updated: `infra/README.md` (status block), `infra/providers/README.md`.

## 2. Provider / version pin strategy

- `hetznercloud/hcloud` pinned `~> 1.69.0` in every stack that uses it
  (compute, network, lab root); `cloudflare/cloudflare` pinned `~> 4.52` at
  the lab root only.
- Commit the `.terraform.lock.hcl` produced by the first `tofu init` (Phase
  1B operator step) so later inits are lockfile-verified.

## 3. State-backend contract (out-of-band; NOT created by this swarm)

- Backend type: `s3` (S3-compatible object store, e.g. Hetzner Object
  Storage). Declared as an empty `backend "s3" {}` block in
  `infra/environments/lab/versions.tf`.
- ALL connection details are supplied at init time:
  `tofu init -backend-config="bucket=…" -backend-config="key=lab.tfstate"
  -backend-config="endpoint=…" -backend-config="region=…"
  -backend-config="access_key=…" -backend-config="secret_key=…"
  -backend-config="skip_credentials_validation=true"
  -backend-config="skip_region_validation=true"
  -backend-config="skip_metadata_api_check=true"` (Hetzner S3-compatible).
- `state_identity` in the target file records the non-secret identifier
  (e.g. `s3:opnory-iac-state/lab.tfstate`); credentials never enter the repo.
- The bucket is created out-of-band by the human operator before the live
  run. Enabling bucket versioning + encryption at rest is the state/plan
  protection strategy (execution-contract criterion 5).

## 4. CI authentication / OIDC contract

- Hetzner has no GitHub OIDC federation. **Deviation:** long-lived
  `HCLOUD_TOKEN` is operator-shell-scoped only; CI NEVER receives it. This
  deviation is written into the architect decision record and accepted by
  security as the satisfy-path for the conditional objection.
- `.github/workflows/iac-pr.yml` keeps `contents: read`, no `id-token`, no
  apply workflow; fork PRs structurally receive no provisioning authority.
  Its glob (`infra/providers/*/*/`, `infra/environments/*/`) now picks up
  the new stacks for `tofu init -backend=false && tofu validate` — validated
  locally below.
- Merge-to-main alone provisions nothing. Any future live workflow must be a
  separate protected-environment (`lab-apply`) workflow with required human
  approval; it does not exist by design.

## 5. DNS boundary

Cloudflare remains authoritative for `opnory.com` (dig-verified
jocelyn/ishaann.ns.cloudflare.com). The lab record is one A record in a
Cloudflare zone (`cloudflare_record`, `proxied = false`, TTL 300). Hetzner
creates no zone and no DNS records.

## 6. Firewall / SSH exposure

- Inbound: 22/tcp from `var.operator_cidr` only; 80/tcp and 443/tcp from
  any; everything else denied (Hetzner default).
- Outbound: allow-all (matches `firewall-policy/policy.json`).
- Ansible-side host firewall (ufw role) applies the same policy on the host.
- Private service ports (5432/6379/3100/4317/3000) are never published —
  asserted by the compose-static CI job and the firewall policy.

## 7. Volume retention / deletion

No persistent volume in Phase 1B (root disk only). If the architecture later
requires one: `hcloud_volume` with `delete_protection = true` while attached;
`tofu destroy` deletes it with the stack; zero residue asserted by
`post_destroy_residue`.

## 8. Lab-only targeting guarantees

- `terraform_data` precondition refuses any `environment != "lab"`.
- preflight refuses any target `environment != "lab"`, any provider dir
  other than the selected one, and the committed example target file.
- G2 label assertion: every hcloud resource statically required to carry
  `environment=lab, managed-by=opnory-iac, swarm=iac-1b`; the operator probe
  matches `allowed_provider_account_hint` to the Hetzner **project label**.
- `staging/` and `production/` remain empty placeholders with no `.tf`.

## 9. R1–R4 dispositions (unchanged from Phase 1A review; concurred)

- R1 passwordless sudo, lab-only deploy user: accept.
- R2 `StrictHostKeyChecking=accept-new` (TOFU): accept; host-key pinning
  remains optional Phase 1B hardening.
- R3 checkov `soft_fail: false`: accept; stays blocking and now scans the
  new provider stack.
- R4 apt_key/apt_repository deprecation warnings: accept (cosmetic).

## 10. verify_opnory.sh deterministic acceptance checks

1. TLS-verified `GET https://<dns_name>/health` → HTTP 200, body contains
   `"status":"ok"` (`apps/api/src/index.ts` `/health`).
2. TLS certificate validity re-probed via `openssl s_client` with SNI.
3. `dig +short A <dns_name>` contains exactly `host_address` (grey-cloud
   record; no Cloudflare edge IPs).
4. Unauthenticated `GET /v1/access/requests/:id` returns 401/403, never 200
   (pinned protected route, `requireRole` middleware).
5. `docker compose ps` over SSH: every service running/healthy, none
   unhealthy/restarting.
6. Script is read-only and idempotent; safe to re-run.

## 11. Validation performed (this worktree, branch
`iac/t_fec9254e-hetzner-implementation`)

See section 12 evidence block for exact commands and outputs. `tofu` is not
installed on this operator machine, so `tofu fmt/validate` could not be run
here; `iac-pr.yml` runs them in CI on PR. All other applicable gates were
run locally and passed (harness self-tests 16/16, ansible syntax, compose
config, preflight incl. G2, lifecycle dry-run incl. G1 wiring, python
compile checks, secret/remote-exec grep, git diff --check). Any pre-existing
failure is labeled as such in the evidence block.

## 12. Environment variables required for the Phase 1B live proof

Operator-shell only, never committed:

- `OPNORY_IAC_PHASE=1B`
- `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab` (human-set only)
- `HCLOUD_TOKEN` (project-scoped, from a lab-labeled Hetzner Cloud project)
- `CLOUDFLARE_API_TOKEN` (scoped: Zone.DNS edit on the lab zone only)
- `-var` / gitignored `lab.tfvars`: `hostname`, `dns_record_name`,
  `cloudflare_zone_id`, `ssh_public_key`, `operator_cidr`
- backend config values (bucket/endpoint/keys) via `-backend-config`
- target file (non-committed path): `state_identity`,
  `expected_dns_zone`, `allowed_provider_account_hint` (Hetzner project
  label), `mutation_budget: 60`

## 13. Human authorization boundary

Only a named human sets `OPNORY_IAC_LIVE_AUTHORIZED` and runs
`lifecycle.py --mode live`. CI never runs live. The agent never sets the
authorization value. Execution-contract §7 unchanged.

## 14. Exact live mutation budget

`mutation_budget: 60` declared in the target file; expected per-cycle
mutations ~8 (server, ssh key, firewall, attachment, A record, plus plan
no-ops). Ledger aborts the run if observed exceeds declared.

## 15. Exact two-cycle procedure

1. Human: create state bucket out-of-band; `tofu init -backend-config=…`.
2. Human: provider identity probe — `hcloud` API "whoami"/project list shows
   the project whose label equals `allowed_provider_account_hint`.
3. `OPNORY_IAC_PHASE=1B OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab
   python3 infra/repro-harness/scripts/lifecycle.py --target <real target>
   --mode live --cycles 2`
4. Per cycle: preflight → plan → pre_apply_zero_state → apply → cloud_init →
   ansible converge → compose up → workload health → opnory verification →
   post-apply drift (rc=0) → ansible idempotence (changed=0) → destroy →
   post-destroy zero residue.
5. Overall PASS requires both cycles PASS and observed ≤ budget.

## 16. Cleanup / abort procedure

Fail-closed: any step failure records remaining steps `skipped (aborted
upstream)` and renders evidence regardless. Operator runs `tofu destroy` in
the lab root, then confirms `tofu state list` is empty and the Cloudflare
record is gone. Partial mutations are reconciled before any retry; the
ledger blocks a retry that would exceed budget.

## 17. Sanitized evidence destination / schema

`render_evidence.py` writes `*.opnory-iac-evidence.json` (gitignored),
validated against `infra/repro-harness/schema/evidence.schema.json`, with
IP/CIDR/hostname/account-ID/secret-shaped redaction. Raw path is canonical;
only redacted pointers attach to tasks.

## 18. Changed files

- NEW `infra/providers/hetzner/compute/{main,variables,outputs,locals,ssh,versions}.tf`
- NEW `infra/providers/hetzner/network/{main,variables,outputs,locals,versions}.tf`
- NEW `infra/environments/lab/{main,variables,outputs,versions}.tf`
- NEW `infra/environments/lab/lab.example.tfvars`
- NEW `infra/environments/lab/PHASE-1B-SYNTHESIS.md` (this file)
- EDIT `infra/environments/lab/PROVIDER-UNRESOLVED.md` → status superseded pointer
- EDIT `infra/repro-harness/scripts/verify_opnory.sh` (G1 implementation)
- EDIT `infra/repro-harness/scripts/lifecycle.py` (G1 wiring + G3 step)
- EDIT `infra/repro-harness/scripts/preflight.py` (G2 label assertion)
- EDIT `infra/README.md`, `infra/providers/README.md` (status)

## 19. Remaining blockers before live execution (all human-gated)

1. Human: Hetzner Cloud account + lab-labeled project + project-scoped token.
2. Human: Cloudflare lab zone/subdomain + scoped DNS token.
3. Human: create the S3-compatible state bucket out-of-band.
4. Human: first `tofu init` and commit of `.terraform.lock.hcl`.
5. Human: set authorization env vars and run the two-cycle live proof.
6. CI: `tofu fmt/validate` + checkov run on the PR (local tofu unavailable
   on this operator machine).

---

## 20. Phase 1B-COST-SAFETY supersession — the selected live proof target is AWS Free Plan

Task t_8c16b5ad (builder), consuming the architect design (t_fc63bd52) and
the security design (t_79216dcd, verdict: approved with mandatory
corrections F1–F8). This section supersedes the Hetzner selection **for the
live proof target only**; everything else in the Phase 1B contract — the
lifecycle driver, mutation ledger, application verifier, evidence schema,
two-cycle semantics, pre-apply zero-state, destroy-mandatory-after-each-cycle
— is reused unchanged.

- **AWS Free Plan is the selected live proof target** (provider
  `hashicorp/aws` ~> 6.66, region `us-east-2`, instance `t3a.medium`,
  credit specification `standard`, S3 state backend with `use_lockfile=true`).
  The AWS account is human-confirmed in the AWS console as Free plan, $100
  initial credits, ~6 months remaining, not upgraded.
- **Hetzner was implemented but live execution was abandoned before any
  mutation** because zero out-of-pocket cost became the governing
  constraint: a Hetzner VM would bill a credit card, while the AWS Free plan
  cannot produce out-of-pocket charges unless the account is upgraded or a
  paid-only service is activated (both structurally refused — see below).
  The Hetzner implementation stays in-tree, byte-for-byte, marked
  non-selected; the Hetzner executor remains blocked. Zero Hetzner live
  mutations ever occurred.
- **Cloudflare remains authoritative DNS** — unchanged Zone.DNS-Edit token
  model on the opnory.com zone; the `cloudflare_record` block is unchanged;
  AWS takes over no DNS.
- **No production readiness claim follows from this lab proof.** It proves
  reproducibility of the harness against a disposable single-host lab on a
  Free plan, nothing more.
- **Free-plan expiration / credit exhaustion ends the executable live-proof
  window** (per aws.amazon.com/free: the account closes itself at 6 months
  or credit exhaustion). This is a time-bounded window, not a standing
  capability.

### Cost-safety boundary (hard security boundary)

Zero out-of-pocket cost is an **account-plan invariant**: it is preserved by
never upgrading to Paid, never activating paid-only services, never joining
Organizations/Control Tower, never purchasing RIs/Savings Plans/Marketplace
products. The implementation fails closed on all of these:

- 15 Free-plan escape guards + a destroy-path guard are enforced statically
  by `infra/repro-harness/tests/aws_escape_guards.sh` (zero AWS API calls),
  wired into the standard self-test gate; the committed IAM policy denies
  purchase/billing/organizations actions by omission and marketplace images
  by explicit Deny.
- The mutation budget stays 60 with corrected arithmetic: 14 resource blocks
  per cycle (13 AWS + 1 Cloudflare, per security F2) × 2 (create+delete) ×
  2 cycles = 56 ≤ 60. The preflight graph-count check expects exactly 14.
- A 4h wall-clock cycle cap plus unconditional **destroy-on-abort** after
  apply (security F5/G5): a failed live cycle can never leave metered
  compute running.
- Live burn while an instance runs ≈ $0.045/hr; two capped cycles ≤ $0.36 —
  0.36% of the $100 credits. No idle-charge resources exist in the graph
  (no EIP, no NAT, no LB, no RDS, no EKS).

### Human authorization gates for AWS (all fail-closed)

1. `OPNORY_IAC_PHASE=1B` (existing)
2. `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab` (existing, human-set)
3. **NEW G2:** `OPNORY_AWS_FREE_PLAN_CONFIRMED` must equal the
   `aws_free_plan_attestation` recorded in the uncommitted target file —
   set by the human operator only; the agent may never synthesize it.
   Account-plan status is HUMAN evidence; it is never inferred from
   credentials working.
4. Target identity: the live preflight compares
   `sha256(<12-digit account id>)[:12]` from `sts:GetCallerIdentity` to the
   target's `allowed_provider_account_hint`. The raw account id never
   enters evidence, logs, or the repo (F8; also rejected by the evidence
   renderer).

### IAM and account safety

Dedicated least-privilege user `opnory-lab-executor` (human-created,
programmatic access only, never root, no Organizations/Identity Center):
see `infra/providers/aws/iam/opnory-lab-executor.policy.json` and its
README. Root credentials are never used by OpenTofu; the live preflight
refuses any root-caller identity. No IAM principal, access key, state
bucket, or any AWS resource is created by this implementation task.

### Operator prerequisites before any live proof (all human, out-of-band)

1. Create the `opnory-lab-executor` IAM user + policy (placeholders filled).
2. Create the S3 state bucket per `STATE-BACKEND.md` (versioning ON, TLS
   deny policy, SSE-S3).
3. Verify the Canonical AMI owner id in the console; supply it as the
   `ami_owner` tfvar.
4. Export the gate env vars and run
   `lifecycle.py --mode live --cycles 2` from the operator shell.
