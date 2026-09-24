#!/usr/bin/env bash
# verify_opnory.sh — deterministic Phase 1B application verification.
#
# Invoked by lifecycle.py step_opnory_verification with these env vars:
#   OPNORY_VERIFY_DNS_NAME            — public FQDN of the lab host (required)
#   OPNORY_VERIFY_HOST_ADDRESS        — IP/FQDN the host is reachable on (required)
#   OPNORY_VERIFY_SSH_USER            — SSH user for host checks (default: opnory)
#   OPNORY_VERIFY_COMPOSE_PROJECT_DIR — compose project dir (default: /srv/opnory)
#
# Contract (executor gap G1): ALL deterministic checks must pass for exit 0;
# any failure exits 3. Read-only and idempotent only; this script must never
# mutate target state.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 3
}

DNS_NAME=${OPNORY_VERIFY_DNS_NAME:?OPNORY_VERIFY_DNS_NAME is required}
HOST_ADDRESS=${OPNORY_VERIFY_HOST_ADDRESS:?OPNORY_VERIFY_HOST_ADDRESS is required}
SSH_USER=${OPNORY_VERIFY_SSH_USER:-opnory}
COMPOSE_PROJECT_DIR=${OPNORY_VERIFY_COMPOSE_PROJECT_DIR:-/srv/opnory}

# 1. API health: TLS-verified HTTPS GET /health returns 200 + {"status":"ok"}.
#    apps/api/src/index.ts: server.get('/health', ...) returns {status:'ok',...}.
echo "check1: GET https://${DNS_NAME}/health (TLS verified)"
body=$(curl -fsS --max-time 15 "https://${DNS_NAME}/health") \
  || fail "GET /health failed or TLS invalid"
echo "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' \
  || fail "GET /health did not return {status:ok}: $body"

# 2. TLS validity: the curl handshake above already verified the certificate
#    chain for DNS_NAME; re-assert with an explicit SNI probe against the
#    host address.
echo "check2: TLS certificate validity via openssl s_client SNI probe"
echo | openssl s_client -connect "${HOST_ADDRESS}:443" -servername "${DNS_NAME}" \
  -verify_return_error -brief 2>/dev/null \
  | grep -q 'Verification: OK\|CONNECTION ESTABLISHED' \
  || fail "TLS certificate verification failed for ${DNS_NAME}"

# 3. DNS assertion: the FQDN must resolve to the host_address (no stray or
#    Cloudflare-edge addresses). A DNS-only (grey cloud) record is required.
echo "check3: DNS ${DNS_NAME} resolves to ${HOST_ADDRESS}"
resolved=$(dig +short A "${DNS_NAME}" | tr -d '[:space:]') \
  || fail "dig failed for ${DNS_NAME}"
[ -n "$resolved" ] || fail "no A records for ${DNS_NAME}"
found=0
for ip in $resolved; do
  [ "$ip" = "$HOST_ADDRESS" ] && found=1
done
[ "$found" -eq 1 ] || fail "${DNS_NAME} resolves to [$resolved], expected ${HOST_ADDRESS}"

# 4. Auth boundary: an unauthenticated request to a protected route must be
#    denied (401/403), never 200.
#    Pinned route: GET /v1/access/requests/:id requires requireRole
#    (apps/api/src/index.ts) — unauthenticated => 401/403.
echo "check4: protected route denies unauthenticated access"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  "https://${DNS_NAME}/v1/access/requests/00000000-0000-0000-0000-000000000000")
case "$http_code" in
  401|403) : ;;
  *) fail "protected route returned HTTP $http_code (expected 401/403)" ;;
esac

# 5. Compose service health: every service running/healthy, none
#    unhealthy/restarting.
echo "check5: compose services all running/healthy"
ps_json=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=10 "${SSH_USER}@${HOST_ADDRESS}" \
  "cd ${COMPOSE_PROJECT_DIR} && docker compose ps --format json") \
  || fail "docker compose ps failed over ssh"
printf '%s' "$ps_json" | grep -qi 'unhealthy\|restarting' \
  && fail "unhealthy or restarting compose service detected"
printf '%s' "$ps_json" | grep -q 'running\|healthy' \
  || fail "no running/healthy compose service found"

echo "PASS: all Opnory application verification checks passed"
exit 0
