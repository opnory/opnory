# dns module

Minimal DNS wiring for the lab environment.

Phase 1A decision: DNS record resources are declared **in the environment
root** (`environments/lab/`) once a provider is selected — not in a shared
multi-provider abstraction module (prohibited by ADR 0012 §4: provider
neutrality comes from the contract, not a universal abstraction). This file
documents the policy the eventual record must satisfy:

- exactly one A record mapping the lab FQDN to `host_address`;
- TTL 300 or lower during the disposable-lab lifecycle;
- no CNAME chains; no wildcard records;
- destruction of the environment must remove the record (record is owned by
  the same root stack that owns the host);
- where Cloudflare is already authoritative for the zone, the record is
  managed through the Cloudflare provider; no out-of-band DNS scripts.

This directory intentionally contains no `.tf` in Phase 1A: there is no
selected provider and therefore nothing to declare records against. It exists
so the layout contract is visible and so future work has an owned home.
