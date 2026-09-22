# firewall-policy

Minimum ingress policy **definition** for the one-host lab.

Per ADR 0012, OpenTofu owns the cloud security-group / provider firewall
resource; Ansible role `firewall/` owns the host-level firewall
(ufw/firewalld). This module pins the shared intent so both layers are built
from one source of truth.

## Allowed inbound (the entire policy)

| Port | Proto | Source | Purpose |
|---|---|---|---|
| 22 | tcp | operator CIDR (var) | SSH for Ansible/operators |
| 80 | tcp | any | Caddy HTTP (ACME + redirect) |
| 443 | tcp | any | Caddy HTTPS (Opnory API/UI entrypoint) |

Everything else inbound: deny. All outbound: allow (host updates, image
pulls, OTLP egress as configured).

`policy.json` is the machine-readable form consumed by:
- the eventual provider security-group definition, and
- `ansible/roles/firewall/` defaults (kept in sync; `firewall` role asserts
  equivalence at converge time via its own defaults file).
