# lab environment — Phase 1B state (provider resolved, superseded by AWS selection)

> **Superseded twice.** Phase 1B originally selected **Hetzner Cloud**
> (`hetznercloud/hcloud` ~> 1.69.0, verifier gate t_52a43bce); that selection
> was **superseded for the live-proof target by AWS Free Plan** in
> Phase 1B-COST-SAFETY (synthesis §20, swarm t_8c16b5ad / t_b6c59987):
> zero out-of-pocket cost became the governing constraint, and a Hetzner VM
> would bill a credit card while the AWS Free plan cannot produce
> out-of-pocket charges unless the account is upgraded or a paid-only
> service is activated (both structurally refused by the escape guards).
> See `PHASE-1B-SYNTHESIS.md` in this directory for the full record.
>
> Live mutation budget remains ZERO until a human runs the two-cycle proof
> per `docs/security/iac-phase1b-execution-contract.md`. Zero Hetzner live
> mutations ever occurred; the Hetzner tree at `infra/providers/hetzner/`
> is preserved byte-identical, marked non-selected, executor blocked.

## Status

The selected live-proof provider is **AWS Free Plan** (`hashicorp/aws`
~> 6.66, committed lockfile 6.66.0; `us-east-2`; `t3a.medium`; credit
specification `standard`; S3 state backend with `use_lockfile=true`).
`main.tf`, `variables.tf`, `outputs.tf`, and `versions.tf` in this
directory wire:

- `infra/providers/aws/compute/` — one disposable EC2 instance
  (host-contract outputs; `t3a.medium`, Ubuntu Noble 24.04 amd64 AMI with
  operator-supplied owner id, gp3 20 GiB root volume encrypted with
  delete_on_termination, IMDSv2 required, no instance profile);
- `infra/providers/aws/network/` — dedicated VPC/subnet/IGW/route-table/
  security-group implementing `modules/firewall-policy/policy.json`
  (22/operator-CIDR, 80/any, 443/any, egress allow-all; public IPv4 via
  subnet auto-assign, no Elastic IP);
- one Cloudflare A record per `modules/dns/README.md` policy (DNS-only,
  TTL 300, owned by this stack) — Cloudflare remains authoritative DNS;
- `backend "s3" {}` — out-of-band; connection details via init-time
  `-backend-config` only, never committed (see `STATE-BACKEND.md`).

## Historical note (Phase 1A)

Phase 1A deliberately shipped no provider: repository evidence contained no
compute-provider credentials or documented preference, and fabricating one
would have violated the task contract. The preflight gate failed closed on
that state. Phase 1B resolved it through the swarm decision record
(workspace t_d0295ea2: providers considered, evidence, rejection rationale)
and independent security concurrence (commit cfaabdf8), with the OIDC
deviation explicitly written into the decision record.

## What still requires a human

- AWS Free-plan confirmation: the operator exports
  `OPNORY_AWS_FREE_PLAN_CONFIRMED` equal to the target-file
  `aws_free_plan_attestation` (human-typed; the agent may never set it).
- `opnory-lab-executor` IAM user + least-privilege policy
  (`infra/providers/aws/iam/opnory-lab-executor.policy.json`; placeholders
  `<ACCOUNT_ID>`, `<CANONICAL_OWNER_ID>`, `<STATE_BUCKET>` filled
  out-of-band) and one access key in the operator shell env chain.
- Console-verified Canonical AMI owner id, supplied as the `ami_owner`
  tfvar and the IAM policy's owner pin.
- Cloudflare lab zone/subdomain + zone-scoped DNS token.
- S3 state bucket creation per `STATE-BACKEND.md` and first `tofu init`.
- Setting `OPNORY_IAC_PHASE=1B`,
  `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab`, and
  `OPNORY_AWS_FREE_PLAN_CONFIRMED` and running the two-cycle live proof.
