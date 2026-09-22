# lab environment — provider unresolved (Phase 1A deliberate state)

## Status

There is intentionally **no `*.tf` in this directory** and no
`infra/providers/<name>/` implementation. Why:

1. ADR 0012 §4 requires exactly one initial provider selected from repository
   or research evidence.
2. Sweep of this repository (workflows, docs, ops/, config packages) finds no
   compute-provider credential configuration, no cloud account references for
   lab compute, and no documented preference. Gate-2 TLS proof used a
   home-lab bridged VM behind a residential router — a manual proof rig, not
   an IaC-manageable provider.
3. Fabricating a provider choice (e.g. assuming a Hetzner/AWS/Cloud account
   exists) would violate the task's "do not invent existing credentials or
   claim a provider is configured when it is not" clause.

## What IS implemented for lab

- The full downstream stack consumes only the **host-contract outputs**
  (`host_address`, `private_address`, `dns_name`, `environment`, optional
  `storage_ref`). Nothing downstream of this directory needs to change when a
  provider is selected.
- `bootstrap/cloud-init/` — provider-agnostic first-boot config.
- `ansible/` — full host-state + Compose deployment, driven by inventory
  rendered from `tofu output -json`.
- `repro-harness/` — lifecycle driver; preflight **fails closed** while this
  state persists.

## Unblock criteria (Phase 1B input)

A human with authority over budget/credentials must:

1. Name the provider (exactly one) and the identity mechanism
   (GitHub-OIDC-based preferred per ADR 0012 §8).
2. Implement `infra/providers/<name>/{compute,network,storage}/` exposing the
   host-contract outputs (validated by
   `modules/host-contract/validate_contract.py`).
3. Add `main.tf`/`variables.tf`/`outputs.tf` to this directory wiring the
   provider stack, dns module policy, and firewall-policy module together,
   with an out-of-band backend (backend config supplied at init time via
   `-backend-config`, never committed).
4. Re-run `infra/repro-harness` preflight; it must transition from
   `BLOCKED: provider-unresolved` to ready.

Until (1)-(3), any `tofu apply` here fails by construction (there is nothing
to apply and no backend configured).
