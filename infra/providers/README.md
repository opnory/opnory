# providers/

Provider implementations of the host-contract live here, one directory per
provider: `infra/providers/<name>/{compute,network,storage}/`.

## Phase 1B status: Hetzner Cloud implemented

The verifier gate (t_52a43bce) selected **Hetzner Cloud**
(`hetznercloud/hcloud` pinned `~> 1.69.0`). This directory now contains
exactly one provider, per ADR 0012 §4:

- `hetzner/compute/` — one disposable VM exposing exactly the host-contract
  outputs (`host_address`, `private_address`, `dns_name`, `environment`);
  cloud-init rendered from `bootstrap/cloud-init/cloud-config.yml`.
- `hetzner/network/` — firewall implementing
  `modules/firewall-policy/policy.json`.
- `hetzner/storage/` — intentionally absent: the Compose stack needs no
  provider volume (named docker volumes + host paths). Do not add one
  without a documented architectural requirement.

Every Hetzner resource carries the lab-only label set
`environment=lab, managed-by=opnory-iac, swarm=iac-1b`; preflight asserts
this statically (fail-closed).

See `environments/lab/PHASE-1B-SYNTHESIS.md` for the full contract (state
backend, CI/OIDC deviation, DNS boundary, two-cycle procedure).
