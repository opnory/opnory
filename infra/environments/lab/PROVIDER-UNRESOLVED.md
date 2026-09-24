# lab environment — Phase 1B state (provider resolved)

> **Superseded by Phase 1B synthesis.** See `PHASE-1B-SYNTHESIS.md` in this
> directory. The verifier gate (t_52a43bce) selected **Hetzner Cloud**
> (`hetznercloud/hcloud` ~> 1.69.0); the provider implementation now lives at
> `infra/providers/hetzner/` and this root wires it to the Cloudflare DNS
> record and the out-of-band state backend stub.
>
> Live mutation budget remains ZERO until a human runs the two-cycle proof
> per `docs/security/iac-phase1b-execution-contract.md`.

## Status

Phase 1B provider selection is verified and implemented. `main.tf`,
`variables.tf`, `outputs.tf`, and `versions.tf` in this directory wire:

- `infra/providers/hetzner/compute/` — one Hetzner Cloud VM (host-contract
  outputs);
- `infra/providers/hetzner/network/` — firewall implementing
  `modules/firewall-policy/policy.json`;
- one Cloudflare A record per `modules/dns/README.md` policy (DNS-only,
  TTL 300, owned by this stack);
- `backend "s3" {}` — out-of-band; connection details via init-time
  `-backend-config` only, never committed.

## Historical note (Phase 1A)

Phase 1A deliberately shipped no provider: repository evidence contained no
compute-provider credentials or documented preference, and fabricating one
would have violated the task contract. The preflight gate failed closed on
that state. Phase 1B resolved it through the swarm decision record
(workspace t_d0295ea2: providers considered, evidence, rejection rationale)
and independent security concurrence (commit cfaabdf8), with the OIDC
deviation explicitly written into the decision record.

## What still requires a human

- Hetzner Cloud account + lab-labeled project + project-scoped `HCLOUD_TOKEN`
  (operator shell only; Hetzner has no GitHub OIDC — documented deviation).
- Cloudflare lab zone/subdomain + zone-scoped DNS token.
- Out-of-band S3-compatible state bucket creation, first `tofu init`, and
  committing the resulting `.terraform.lock.hcl`.
- Setting `OPNORY_IAC_PHASE=1B` and
  `OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab` and running the
  two-cycle live proof.
