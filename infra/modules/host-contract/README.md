# host-contract

The stable output contract every provider implementation must expose.

This module is a **contract definition** (documentation + variable/output
shape), not a reusable resource module. Provider stacks under
`infra/providers/<name>/` must output exactly this shape from their
`compute/` stack; environments consume only these keys.

## Contract (per ADR 0012 §3)

| Output | Type | Required | Purpose |
|---|---|---|---|
| `host_address` | string | yes | Reachable address (IP or FQDN) used by Ansible and operators |
| `private_address` | string | yes | Internal address for host-local service binding |
| `dns_name` | string | yes | Public FQDN that resolves to `host_address` |
| `environment` | string | yes | One of `lab`, `staging`, `production` |
| `storage_ref` | string | no | Opaque storage reference (mount path / volume ID) **only** when downstream configuration genuinely requires it |

## Forbidden as outputs or variables

- PostgreSQL connection URLs
- S3 credentials / access keys / secret keys
- provider API tokens
- SSH private keys
- application secrets of any kind
- passwords

Application secrets travel through the `SecretStore`/`CredentialProvider`
boundary on the host (ADR 0006), referenced by opaque `credentialRef`. They
never enter tfvars, `.tfstate`, plan files, or outputs.

## Consumers

- `environments/lab/` — surfaces these outputs.
- `ansible/inventories/render_inventory.py` — renders the Ansible inventory
  from `tofu output -json`, expecting exactly these keys.
