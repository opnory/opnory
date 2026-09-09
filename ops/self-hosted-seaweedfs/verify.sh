#!/usr/bin/env bash
# Gate 1A SeaweedFS + Tempo durability verifier
# Reproduces the full durability claim: emit → flush → destroy Tempo → recreate → retrieve
# Exits nonzero on ANY failed assertion. Traps cleanup.

set -euo pipefail

# ========= CONFIGURATION =========
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_DIR}/compose.yml"
ENV_FILE="${COMPOSE_DIR}/.env"
S3_JSON_FILE="${COMPOSE_DIR}/s3.json"

TEMPO_OTLP_ENDPOINT="http://localhost:4318/v1/traces"
TEMPO_API_ENDPOINT="http://localhost:3200"
SEAWEEDFS_S3_ENDPOINT="http://localhost:8333"

CONTAINER_NAMES=("seaweedfs" "bootstrap-bucket" "tempo")
VOLUME_NAME="seaweedfs-data"

BASELINE_MODE=false

# ========= ARGUMENT PARSING =========
usage() {
  cat <<EOF
Usage: $0 [--baseline]

--baseline    Run baseline verification against current working-tree config (admin identity + bootstrap-bucket).
              Skips credential negative controls (covered only after least-privilege hardening).
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --baseline) BASELINE_MODE=true ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

# ========= HELPERS =========
log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { log "FAIL: $*"; exit 1; }
ok() { log "OK: $*"; }

require_env() {
  local var=$1
  [[ -n "${!var:-}" ]] || die "Missing required env: $var"
}

check_prereqs() {
  command -v docker >/dev/null || die "docker not found"
  command -v aws >/dev/null || die "aws CLI not found"
  command -v jq >/dev/null || die "jq not found"
  command -v curl >/dev/null || die "curl not found"
  [[ -f "${ENV_FILE}" ]] || die "Missing ${ENV_FILE}"
  [[ -f "${S3_JSON_FILE}" ]] || die "Missing ${S3_JSON_FILE}"
  # Load .env
  set -a; source "${ENV_FILE}"; set +a
  require_env SEAWEEDFS_ACCESS_KEY
  require_env SEAWEEDFS_SECRET_KEY
  require_env SEAWEEDFS_SIGNING_KEY
  if [[ "${BASELINE_MODE}" == "true" ]]; then
    # Baseline: Tempo uses admin creds (single identity), no SEAWEEDFS_TEMPO_* required
    require_env SEAWEEDFS_ACCESS_KEY
    require_env SEAWEEDFS_SECRET_KEY
    log "BASELINE MODE: using admin credentials for Tempo; credential negative controls SKIPPED"
  else
    require_env SEAWEEDFS_TEMPO_ACCESS_KEY
    require_env SEAWEEDFS_TEMPO_SECRET_KEY
  fi
  ok "Prerequisites satisfied"
}

cleanup() {
  log "Cleaning up containers..."
  for c in "${CONTAINER_NAMES[@]}"; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  # Note: we preserve seaweedfs-data volume intentionally
}
trap cleanup EXIT

wait_healthy() {
  local service=$1
  local max_wait=${2:-60}
  local waited=0
  log "Waiting for ${service} to be healthy..."
  while [[ $waited -lt $max_wait ]]; do
    local status
    status=$(docker inspect -f '{{.State.Health.Status}}' "$service" 2>/dev/null || echo "none")
    [[ "$status" == "healthy" ]] && { ok "${service} healthy"; return 0; }
    sleep 2
    waited=$((waited + 2))
  done
  die "${service} did not become healthy within ${max_wait}s"
}

wait_tempo_ready() {
  local max_wait=60
  local waited=0
  log "Waiting for Tempo API..."
  while [[ $waited -lt $max_wait ]]; do
    if curl -sf "${TEMPO_API_ENDPOINT}/ready" >/dev/null 2>&1; then
      ok "Tempo API ready"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  die "Tempo API did not become ready within ${max_wait}s"
}

emit_trace() {
  local trace_id=$1
  local span_id=$2
  local payload
  payload=$(jq -nc --arg tid "$trace_id" --arg sid "$span_id" '
    {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "gate1a-verifier" } }] },
        scopeSpans: [{
          spans: [{
            traceId: $tid,
            spanId: $sid,
            name: "gate1a-verifier-span",
            kind: 2,
            startTimeUnixNano: (now * 1000000000 | tostring),
            endTimeUnixNano: ((now + 1) * 1000000000 | tostring),
            attributes: [
              { key: "test.corpus", value: { stringValue: "gate1a" } },
              { key: "test.tenant", value: { stringValue: "tenant-a" } },
              { key: "test.secret", value: { stringValue: "REDACT_ME" } }
            ]
          }]
        }]
      }]
    }')
  curl -sf -X POST "${TEMPO_OTLP_ENDPOINT}" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null || die "Failed to emit trace"
  ok "Emitted trace ${trace_id}"
}

query_trace_by_id() {
  local trace_id=$1
  curl -sf "${TEMPO_API_ENDPOINT}/api/traces/${trace_id}" || die "Failed to query trace ${trace_id}"
}

query_traceql() {
  local query=$1
  local start=$2
  local end=$3
  curl -sf -G "${TEMPO_API_ENDPOINT}/api/search" \
    --data-urlencode "q=${query}" \
    --data-urlencode "start=${start}" \
    --data-urlencode "end=${end}" \
    --data-urlencode "limit=10" || die "TraceQL query failed"
}

# ========= MAIN VERIFICATION =========
main() {
  log "=== Gate 1A Durability Verification Started ==="
  [[ "${BASELINE_MODE}" == "true" ]] && log "BASELINE MODE: credential negative controls will be SKIPPED"
  check_prereqs

  # --- PHASE 1: START STACK ---
  log "Starting stack..."
  docker compose -f "${COMPOSE_FILE}" up -d
  wait_healthy seaweedfs
  wait_healthy bootstrap-bucket 30
  wait_healthy tempo
  wait_tempo_ready

  # --- PHASE 2: VERIFY BOOTSTRAP POSTCONDITION ---
  log "Verifying bucket exists (head-bucket postcondition)..."
  aws s3api head-bucket --bucket tempo-traces \
    --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" \
    --region us-east-1 || die "Bucket tempo-traces not found after bootstrap"

  # --- PHASE 3: EMIT DETERMINISTIC CORPUS ---
  local trace_id1=$(openssl rand -hex 16)
  local span_id1=$(openssl rand -hex 8)
  local trace_id2=$(openssl rand -hex 16)
  local span_id2=$(openssl rand -hex 8)
  local emit_time=$(date +%s)
  emit_trace "${trace_id1}" "${span_id1}"
  emit_trace "${trace_id2}" "${span_id2}"
  log "Emitted traces: ${trace_id1}, ${trace_id2} at ${emit_time}"

  # Wait for flush to object store
  log "Waiting for durable flush to SeaweedFS..."
  sleep 10

  # --- PHASE 4: CAPTURE TRACE IDs FOR LATER ASSERTION ---
  local trace_ids=("${trace_id1}" "${trace_id2}")

  # --- PHASE 5: DESTROY TEMPO + TEMPO-LOCAL STATE ---
  log "Destroying Tempo container and local state..."
  docker rm -f tempo >/dev/null 2>&1 || true
  # Note: SeaweedFS volume (seaweedfs-data) is intentionally preserved

  # --- PHASE 6: RECREATE TEMPO (STEADY STATE) ---
  log "Recreating Tempo against existing SeaweedFS..."
  docker compose -f "${COMPOSE_FILE}" up -d tempo
  wait_healthy tempo
  wait_tempo_ready

  # --- PHASE 7: TRACE-BY-ID ASSERTIONS ---
  log "Verifying trace-by-ID retrieval..."
  for tid in "${trace_ids[@]}"; do
    local result
    result=$(query_trace_by_id "${tid}")
    echo "${result}" | jq -e --arg t "${tid}" '.spans[0].traceID == $t' >/dev/null || die "Trace ${tid} not found by ID"
    ok "Trace ${tid} retrieved by ID"
  done

  # --- PHASE 8: EXPLICIT-WINDOW TRACEQL POSITIVE CONTROL ---
  local search_start=$((emit_time - 60))
  local search_end=$((emit_time + 60))
  log "TraceQL positive control (tenant-a, explicit window)..."
  local result
  result=$(query_traceql '{.service.name = "gate1a-verifier" && .test.tenant = "tenant-a"}' "${search_start}000000000" "${search_end}000000000")
  local count
  count=$(echo "${result}" | jq '.traces | length')
  [[ ${count} -ge 2 ]] || die "Expected >=2 traces, got ${count}"
  ok "TraceQL positive control: ${count} traces found"

  # --- PHASE 9: EXPLICIT-WINDOW TRACEQL NEGATIVE CONTROL ---
  log "TraceQL negative control (tenant-b, should find 0)..."
  result=$(query_traceql '{.service.name = "gate1a-verifier" && .test.tenant = "tenant-b"}' "${search_start}000000000" "${search_end}000000000")
  count=$(echo "${result}" | jq '.traces | length')
  [[ ${count} -eq 0 ]] || die "Negative control failed: found ${count} traces for tenant-b"
  ok "TraceQL negative control: 0 traces as expected"

  # --- PHASE 10: REDACTION ASSERTION ---
  log "Verifying redaction of sensitive attributes..."
  result=$(query_trace_by_id "${trace_id1}")
  local secret_val
  secret_val=$(echo "${result}" | jq -r '.spans[0].attributes[] | select(.key=="test.secret") | .value.stringValue')
  [[ "${secret_val}" != "REDACT_ME" ]] || die "Secret not redacted (found literal REDACT_ME)"
  ok "Redaction assertion passed (secret value not present in stored trace)"

  # --- PHASE 11: NEGATIVE CONTROLS FOR TEMPO CREDENTIAL (SKIPPED IN BASELINE) ---
  if [[ "${BASELINE_MODE}" == "true" ]]; then
    log "BASELINE MODE: Skipping credential negative controls (11a-11c) — covered only after hardening"
  else
    log "Running credential negative controls (Tempo credential must be bucket-scoped)..."
    export AWS_ACCESS_KEY_ID="${SEAWEEDFS_TEMPO_ACCESS_KEY}"
    export AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_TEMPO_SECRET_KEY}"
    export AWS_REGION=us-east-1
    export AWS_ENDPOINT_URL="${SEAWEEDFS_S3_ENDPOINT}"
    export AWS_EC2_METADATA_DISABLED="true"

    # 11a: Cannot create bucket
    log "  11a: Attempting create-bucket with Tempo cred (expect denial)..."
    if aws s3api create-bucket --bucket tempo-traces-2 --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential was able to create bucket"
    fi
    ok "  Tempo credential correctly denied create-bucket"

    # 11b: Cannot delete bucket
    log "  11b: Attempting delete-bucket with Tempo cred (expect denial)..."
    if aws s3api delete-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential was able to delete bucket"
    fi
    ok "  Tempo credential correctly denied delete-bucket"

    # 11c: Cannot access different bucket
    log "  11c: Attempting head-bucket on different bucket with Tempo cred (expect denial)..."
    if aws s3api head-bucket --bucket some-other-bucket --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential accessed different bucket"
    fi
    ok "  Tempo credential correctly denied cross-bucket access"
  fi

  # --- ALL ASSERTIONS PASSED ---
  log "=== ALL GATE 1A ASSERTIONS PASSED ==="
}

main "$@"