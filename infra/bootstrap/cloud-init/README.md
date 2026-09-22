# cloud-init — first-boot bootstrap only

`cloud-config.yml` is the complete first-boot specification for the lab host.
Per ADR 0012 §1 it may ONLY:

- create the deployment user (`opnory`);
- install the operator SSH public key;
- install the minimal prerequisites Ansible needs to take over
  (python3, rsync, curl);
- perform unavoidable one-time OS initialization (hostname, package metadata
  refresh, unattended security upgrades).

It must NOT deploy Opnory, own firewall policy, contain Compose definitions,
implement backups, or grow into a general installer.

## Inputs

Rendered by the provider stack as a template with exactly two variables:

- `ssh_public_key` — operator public key for the `opnory` user.
- `hostname` — the lab FQDN.

No other variable is permitted; in particular no credentials, tokens, or
application secrets may appear in user-data (user-data is readable from
instance metadata by any local process).
