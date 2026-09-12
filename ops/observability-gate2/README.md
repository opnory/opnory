# Gate 2 — TLS termination for observability.opnory.com

## Stack
- **Caddy** — TLS termination / ACME HTTP-01 on `:80` and `:443`, reverse proxy → Grafana
- **Grafana 11.0.0** — operator-facing public endpoint (pinned digest `0dc5a246...`)
- **Tempo 2.5.0** — trace ingest/query, private on compose network (pinned digest `f0200a9b...`)
- **SeaweedFS** — S3-compatible object store, private on compose network (pinned digest `fc9f76fa...`)

## Topology
```text
Internet
   │
   ├── :80   ACME HTTP-01 challenge + redirect to HTTPS
   │
   └── :443  Caddy HTTPS (TLS 1.2/1.3, obsolete versions rejected)
            │
            ▼
        Grafana (private, port 3000)
            │
            ├── Tempo (private, 3200/4317/4318)
            │
            └── SeaweedFS (private, 8333)
```

**NO public exposure:** Grafana 3000, Tempo 3200/4317/4318, SeaweedFS 8333, OTLP 4317/4318 — all private.

**NO Keycloak/OIDC** — that is Gate 3.

## Prerequisites (external)
1. **Public Linux VPS** with stable public IP
2. **Cloudflare DNS-only A record**: `observability.opnory.com` → `<VPS_PUBLIC_IP>` (proxy **disabled**)
3. Inbound TCP `80` and `443` open on VPS firewall/security groups

## Deployment
```bash
# 1. On VPS: clone repo and checkout branch
git clone https://github.com/opnory/opnory.git
cd opnory
git checkout feat/observability-hardening-gate2-tls

# 2. Create .env from example (generate strong keys)
cp ops/observability-gate2/.env.example ops/observability-gate2/.env
# Fill in: SEAWEEDFS_TEMPO_ACCESS_KEY, SEAWEEDFS_TEMPO_SECRET_KEY, SEAWEEDFS_SIGNING_KEY

# 3. Bootstrap SeaweedFS bucket (one-time, admin credential)
# Use the bootstrap template, then switch to runtime
cd ops/observability-gate2
jq --arg ak "$SEAWEEDFS_ADMIN_ACCESS_KEY" --arg sk "$SEAWEEDFS_ADMIN_SECRET_KEY" \
   --arg tak "$SEAWEEDFS_TEMPO_ACCESS_KEY" --arg tsk "$SEAWEEDFS_TEMPO_SECRET_KEY" \
   --arg skey "$SEAWEEDFS_SIGNING_KEY" \
   '.identities[0].credentials[0].accessKey=$ak |
    .identities[0].credentials[0].secretKey=$sk |
    .identities[1].credentials[0].accessKey=$tak |
    .identities[1].credentials[0].secretKey=$tsk' \
   s3.bootstrap.json.example > s3.json

docker compose up -d
# Wait for seaweedfs healthy, create tempo-traces bucket
docker run --rm --network host amazon/aws-cli@sha256:d948ee... \
  --endpoint-url http://<VPS_IP>:8333 s3 mb s3://tempo-traces

# 4. Switch to runtime config (tempo identity only)
jq --arg tak "$SEAWEEDFS_TEMPO_ACCESS_KEY" --arg tsk "$SEAWEEDFS_TEMPO_SECRET_KEY" \
   '.identities[0].credentials[0].accessKey=$tak |
    .identities[0].credentials[0].secretKey=$tsk' \
   s3.runtime.json.example > s3.json

docker compose restart tempo seaweedfs

# 5. Start full stack (Caddy will auto-obtain Let's Encrypt cert)
docker compose up -d
```

## Verification
```bash
# From repo root on VPS (requires docker compose + network access)
GATE2_HOST=observability.opnory.com GATE2_PUBLIC_IP=<VPS_PUBLIC_IP> \
  bash ops/observability-gate2/verify-tls.sh
```
**Expected: EXIT=0, all checks PASS**

## Evidence Targets
```
Production hardening — Gate 2 TLS:
  Public DNS → TLS termination:              PROVEN
  Valid hostname certificate:                PROVEN
  Modern TLS transport:                      PROVEN
  Plaintext public service bypass:           NOT AVAILABLE
  Tempo direct public exposure:              ABSENT
  SeaweedFS direct public exposure:          ABSENT
  TLS recovery after proxy restart:          PROVEN

  SSO/auth/authz:                             NOT CLAIMED
  Certificate HA:                            NOT CLAIMED
  Multi-node proxy availability:             NOT CLAIMED
  Gate 3:                                    UNPROVEN

  Overall observability production readiness: NOT CLAIMED
```

## Files (git-tracked)
- `compose.yml` — service definitions, pinned digests
- `Caddyfile` — TLS termination, reverse proxy to Grafana
- `tempo.yaml` — Tempo config (S3 backend via SeaweedFS)
- `grafana/provisioning/datasources/tempo.yaml` — Tempo datasource
- `.env.example` — credential template
- `s3.bootstrap.json.example` / `s3.runtime.json.example` — SeaweedFS identity configs
- `verify-tls.sh` — live TLS verification (fails closed)
- `.gitignore` — excludes `.env`, `s3.json`, `caddy-data/`, certs

## Blocked
**This gate is deliberately unverified.** The live `verify-tls.sh` run requires the external VPS IP + DNS A record. Until those exist, the skeleton is structurally complete but unproven.