# IaC Phase 1B — independent provider + CI security gate (OPNORY-SECURITY)

Before / alongside verifier gate. Swarm root: `t_9a463238`; worker: `t_9d849d82`.
Scope per task body: independent review of provider candidate authentication
models, GitHub OIDC feasibility and trust scoping, public-fork behavior,
state/backend separation and encryption, firewall/SSH/DNS exposure, lab-only
scoping, evidence sanitization, and R1–R4 disposition. **No live mutation
performed or authorized by this document.** Live cloud mutation budget: ZERO.

## 1. Repository state verified independently (not taken from sibling handoffs)

- `git ls-files ops/ | grep -i 'cloudflare|cname|dns'` → no committed DNS
  tooling under `ops/`. `dig +short opnory.com NS` →
  `jocelyn.ns.cloudflare.com`, `ishaanns.cloudflare.com` —
  **Cloudflare is authoritative for opnory.com** (verified at execution time).
  Consequence: the provider-selection gate MUST NOT require the compute
  provider to own DNS; Cloudflare remains the DNS plane per ADR 0012 §5 and
  the selection evidence.
- `infra/providers/` is intentionally empty; `environments/lab/` contains only
  `PROVIDER-UNRESOLVED.md`. Phase 1A fail-closed state re-confirmed.
- `.gitignore` covers `*.tfstate*`, `*.tfplan`, `infra/**/*.tfvars` (with
  `*.example.tfvars` exception), `.live-results/`, `.env`, and generated
  inventory. F7 from Phase 1A holds.
- `bash infra/repro-harness/tests/run_tests.sh` → ALL 16/16 self-tests pass on
  main (4a2233f + 051510f fits). Pre-existing Phase 1A controls intact.
- `.github/workflows/iac-pr.yml`: `permissions: contents: read`, no
  `id-token:` grant anywhere, no environment, no secrets beyond GITHUB_TOKEN,
  checkov `soft_fail: false`, gitleaks on every PR, forbidden-pattern greps.
  There is intentionally NO apply workflow.

## 2. Baseline security invariants that any selected provider must inherit

These are non-negotiable and already true on main; a selection that weakens
any of them fails this gate:

1. `environment == 'lab'` is the only value preflight permits
   (`infra/repro-harness/scripts/preflight.py:95` — "Refusing anything but
   the disposable lab"). Provider module resolution happens only after this.
2. apply/destroy hard-blocked unless `OPNORY_IAC_PHASE=1B` AND
   `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab`, set by a named human
   operator. The agent never sets it.
3. No tofu remote-exec provisioners (ADR 0012 §6); enforced by CI grep.
4. host-contract forbids secrets in outputs (`validate_contract.py` rejects
   `postgres://`, keys, tokens — CI has a negative test asserting this).
5. Mutation ledger is append-only; budget breach aborts the run.
6. Evidence sanitizer redacts IP/CIDR/hostname/account ID before persistence.
7. State backend is out-of-band; backend config passed via `-backend-config`
   at init time, never committed (`PROVIDER-UNRESOLVED.md` unblock item 3).

## 3. Candidate-provider security analysis (independent of the architect lane)

Evaluation criterion from the task: **can the provider satisfy the existing
fail-closed contract *and* avoid long-lived unrestricted CI credentials?**

### AWS (hashicorp/aws, ~>6.x)
- Auth: full GitHub OIDC via IAM OIDC identity provider +
  `sts:AssumeRoleWithWebIdentity` — trust policy can scope `sub` to
  `repo:OWNER/REPO:environment:lab-apply`; audience fixed. No long-lived
  keys. Terraform provider documents web-identity federation natively
  (env vars or `assume_role_with_web_identity`).
- State: S3 backend (SSE + bucket-level access logging) or Terraform Cloud;
  well-trodden. State lives outside the disposable target trivially.
- Account isolation: dedicated lab account via Organizations is achievable;
  `allowed_provider_account_hint` maps cleanly to `sts:GetCallerIdentity`
  (documented in the provider's "Getting the Account ID" section).
- Residual risks: enormous blast radius if trust policy is mis-scoped;
  IAM complexity invites over-broad roles; cost-bleed from forgotten
  resources; non-deterministic destroy on rare edge cases (ENI detach lag).
- Verdict: **supported**, conditional on a dedicated account and a tightly
  scoped OIDC trust on `environment:lab-apply` only.

### Azure (hashicorp/azurerm)
- Auth: OIDC via workload identity federation on an Entra app
  (`azure/login`); `audience: api://AzureADTokenExchange`. Equivalent
  scoping to AWS.
- State: azurerm backend (Azure Blob) with SSE; fine.
- Residual risks: Entra app + service principal object model is more
  moving parts; subscription-level RBAC scoping is coarser than IAM
  conditions; provider churn historically high.
- Verdict: **supported**, no security objection; slightly more complex
  identity setup than AWS for an equivalent posture.

### GCP (hashicorp/google)
- Auth: OIDC via Workload Identity Federation (`google-github-actions/auth`);
  mature. Equivalent.
- State: GCS backend.
- Residual: project-level IAM bindings; WIF setup is scripted and auditable.
- Verdict: **supported**.

### Hetzner Cloud (hetznercloud/hcloud)
- Auth: **long-lived API token only.** Hetzner Cloud has no OIDC federation
  and no IAM — one token per project, full project scope. This directly
  conflicts with ADR 0012 §8 ("GitHub OIDC federation is the preferred
  provider authentication where supported; long-lived cloud keys in repo
  secrets are a fallback requiring explicit justification").
- Consequence if chosen: the Phase 1B live run could not be run from CI
  without committing to a long-lived repo/org secret, and a public-fork
  repository must never host such a secret. The harness permits
  operator-machine execution only, which removes fork exposure but forfeits
  the GitHub Environment + OIDC protection the CI boundary section requires.
- State: s3-compatible remote backend still available (out-of-band), so
  state isolation is fine.
- Other positives: deterministic destroy semantics, cheap, single-VM lab fit,
  firewall model is simple and auditable, six locations.
- Verdict: **supported only for operator-local live runs with an explicit
  written justification for the OIDC deviation.** If the Phase 1B goal
  includes a CI-driven apply path behind a protected environment (task
  asserts "GitHub OIDC or equivalent short-lived CI authentication"),
  Hetzner fails criterion 3 of the verifier gate as written.

### Cloudflare-as-compute — not applicable
Cloudflare owns DNS here; Workers are not a single-Linux-VM substrate.
Rejected as compute provider; remains DNS layer regardless of choice.

## 4. Security position for the verifier gate

- No security objection to AWS, Azure, or GCP, provided:
  (a) OIDC trust is scoped to `environment:lab-apply` (+ repo), never
      `ref:*` alone; (b) a dedicated lab account/subscription/project is
      used, asserted by the identity probe against
      `allowed_provider_account_hint`; (c) the apply workflow lives in a
      protected GitHub Environment and does not exist for fork PRs;
      (d) state backend has SSE + versioning and lives outside the lab.
- Conditional objection to any provider without GitHub OIDC or an
  equivalent short-lived credential exchange when a CI apply path is
  required. Hetzner is acceptable *only* with an explicit recorded
  deviation and operator-local execution as the sole apply path.
- Security independently agrees with the architect only if the single
  selected provider lands in the OIDC-capable set {AWS, Azure, GCP}, or
  the deviation above is written into the decision record.

## 5. R1–R4 dispositions (from Phase 1A review, carried into 1B)

- **R1 (passwordless sudo on lab deploy user)** — ACCEPT for lab. Bounded by
  SSH-key-only access, disabled password auth, rate-limited sshd. Must be
  re-opened if any non-lab environment is ever defined; preflight already
  refuses non-lab.
- **R2 (SSH StrictHostKeyChecking=accept-new / TOFU)** — ACCEPT for Phase 1B
  with a hardening note: pin host key from cloud-init console output in the
  evidence record. Not a blocker for two disposable cycles.
- **R3 (checkov soft_fail:false with zero .tf files)** — ACCEPT. Its value
  begins exactly when the Phase 1B provider stack lands; must stay blocking.
  Verifier should confirm checkov runs against the new provider module with
  `soft_fail: false` unchanged.
- **R4 (apt_key deprecated)** — ACCEPT. Functional, not a security boundary.

## 6. Public-fork / CI boundary verification (checked in repo, not assumed)

- `iac-pr.yml` has no apply job; no `id-token: write`; no environment.
  Adding an apply workflow in Phase 1B requires: new workflow file,
  `environment: lab-apply`, `permissions: id-token: write` on that job only,
  and a subject claim condition on the trust side. Fork PRs inherit
  `contents: read` and cannot reach environments or secrets; this is
  structural, not policy.
- merge-to-main does not provision: no such trigger exists today and the
  contract (execution-contract §7) forbids it. Verifier must confirm the new
  workflow (if any) is `workflow_dispatch` or `environment`-gated only.

## 7. State, DNS, volume, teardown boundary verdicts

- State: out-of-band remote backend with SSE + access logging; operator
  supplies via `-backend-config`; never committed. Consistent with all
  OIDC-capable candidates. PASS-able.
- DNS: Cloudflare remains authoritative (dig-verified). Provider module
  must NOT create a competing zone; use `modules/dns/` to reference the
  Cloudflare provider for the lab record only, scoped to the zone named in
  the target file (`expected_dns_zone`).
- Volume: `storage_ref` stays opaque; volume deletion/retention must be
  explicit in the decision record (destroy = delete for disposable lab,
  no retain flags).
- Teardown: all candidates support deterministic `tofu destroy` for a
  single VM + volume + network + firewall set; evidence validator already
  requires verify-absent as the exit criterion, not the destroy return code.

## 8. Evidence provenance

- Independent commands run from this worker: `git ls-files`, `dig` (NS/A),
  `run_tests.sh` (16/16 PASS), reads of ADR 0012, Phase 1A security review,
  Phase 1B execution contract, iac-pr.yml, PROVIDER-UNRESOLVED.md,
  preflight.py.
- Docs consulted (primary): GitHub OIDC overview; AWS IAM OIDC provider;
  AWS provider auth docs (v6); Azure OIDC workflow; Hetzner locations/
  products. No sibling handoff was read for provider choice; the architect
  lane had not posted a decision at analysis time.
- Live mutations: 0. No credentials on disk were created, read, or used.
