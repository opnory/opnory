# providers/

Provider implementations of the host-contract live here, one directory per
provider: `infra/providers/<name>/{compute,network,storage}/`.

## Phase 1A status: NO PROVIDER IMPLEMENTED

Repository evidence does not establish any configured compute provider
(no committed credentials, no existing provider integration, no documented
sandbox cloud account for compute). Per ADR 0012 §4 and the Phase 1A task:

- exactly one initial provider may exist here;
- the choice must come from repository/research evidence, not fabrication;
- because no defensible choice exists in-repo, **live execution is BLOCKED**
  and the repro-harness preflight fails closed on
  `infra/providers/<name>/` being absent.

See `environments/lab/PROVIDER-UNRESOLVED.md` for the exact unblock criteria.
