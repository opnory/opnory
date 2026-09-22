# opnory role

Deploys the canonical Opnory Compose runtime (this template is the new
canonical runtime stack; historical `ops/self-hosted*` stacks are frozen
evidence and are NOT reused).

## Components (current milestone)

- `api` — Opnory API service (built image, `opnory/api:<tag>`)
- `postgres` — PostgreSQL 16 with a named volume
- `redis` — Redis 7 (job/queue plumbing used by @opnory/config)
- `tempo` — trace store (private network only)
- `grafana` — dashboards (private network only)
- `caddy` — the only public ingress; terminates TLS on 443

Deliberately NOT included per the Phase 1A minimal-lab constraint: Qdrant,
SeaweedFS, Slack service. They enter the stack only when the application
milestone actually requires them, with their own ADR amendment.

## Secrets boundary

- PostgreSQL credentials, Grafana admin, OTLP and any app secrets live in
  `/srv/opnory/.env` (mode 0600, owner opnory), rendered by the operator,
  never by this role and never via OpenTofu.
- The role fails closed (assert) when the env file is missing; it never
  invents default credentials.
