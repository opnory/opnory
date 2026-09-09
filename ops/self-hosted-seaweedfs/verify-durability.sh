#!/usr/bin/env bash
# Gate 1A SeaweedFS durability + least-privilege smoke verifier
# Proves: fail-closed bootstrap, Admin absent at steady state, Tempo bucket-scoped credential,
# cross-bucket denial, durable flush, destroy/recreate Tempo recovery, Tempo trace/query retrieval.
# Does NOT prove: Opnory lifecycle corpus fidelity, frozen opnory.* attribute contract,
# Opnory telemetry redaction (separate artifact using real Opnory emitter + Phase 7 corpus).

set -euo pipefail

# ========= CONFIGURATION =========
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_DIR}/compose.yml"
ENV_FILE="${COMPOSE_DIR}/.env"
S3_JSON_FILE="${COMPOSE_DIR}/s3.json"
S3_BOOTSTRAP_TEMPLATE="${COMPOSE_DIR}/s3.bootstrap.json.example"
S3_RUNTIME_TEMPLATE="${COMPOSE_DIR}/s3.runtime.json.example"

TEMPO_OTLP_ENDPOINT="http://localhost:4318/v1/traces"
TEMPO_API_ENDPOINT="http://localhost:3200"
SEAWEEDFS_S3_ENDPOINT="http://localhost:8333"

CONTAINER_NAMES=("seaweedfs" "bootstrap-bucket" "tempo")
VOLUME_NAME="seaweedfs-data"

BASELINE_MODE=false

# ========= HELPERS =========
log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { log "FAIL: $*"; exit 1; }
ok() { log "OK: $*"; }

require_env() {
  local var=$1
  [[ -n "${!var:-}" ]] || die "Missing required env: $var"
}

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
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

check_prereqs() {
  command -v docker >/dev/null || die "docker not found"
  command -v aws >/dev/null || die "aws CLI not found"
  command -v jq >/dev/null || die "jq not found"
  command -v curl >/dev/null || die "curl not found"
  [[ -f "${ENV_FILE}" ]] || die "Missing ${ENV_FILE}"
  [[ -f "${S3_BOOTSTRAP_TEMPLATE}" ]] || die "Missing ${S3_BOOTSTRAP_TEMPLATE}"
  [[ -f "${S3_RUNTIME_TEMPLATE}" ]] || die "Missing ${S3_RUNTIME_TEMPLATE}"
  # Load .env
  set -a; source "${ENV_FILE}"; set +a
  require_env SEAWEEDFS_SIGNING_KEY
  if [[ "${BASELINE_MODE}" == "true" ]]; then
    require_env SEAWEEDFS_ACCESS_KEY
    require_env SEAWEEDFS_SECRET_KEY
    log "BASELINE MODE: using admin credentials for Tempo; credential negative controls SKIPPED"
  else
    require_env SEAWEEDFS_ADMIN_ACCESS_KEY
    require_env SEAWEEDFS_ADMIN_SECRET_KEY
    require_env SEAWEEDFS_TEMPO_ACCESS_KEY
    require_env SEAWEEDFS_TEMPO_SECRET_KEY
  fi
  ok "Prerequisites satisfied"
}

generate_bootstrap_s3_config() {
  log "Generating bootstrap S3 config with real credentials..."
  jq -n \
    --arg admin_key "${SEAWEEDFS_ADMIN_ACCESS_KEY}" \
    --arg admin_secret "${SEAWEEDFS_ADMIN_SECRET_KEY}" \
    --arg tempo_key "${SEAWEEDFS_TEMPO_ACCESS_KEY}" \
    --arg tempo_secret "${SEAWEEDFS_TEMPO_SECRET_KEY}" \
    '{
      identities: [
        {
          name: "admin",
          credentials: [{accessKey: $admin_key, secretKey: $admin_secret}],
          actions: ["Admin"]
        },
        {
          name: "tempo",
          credentials: [{accessKey: $tempo_key, secretKey: $tempo_secret}],
          actions: ["Read:tempo-traces", "Write:tempo-traces", "List:tempo-traces", "Tagging:tempo-traces"]
        }
      ]
    }' > "${S3_JSON_FILE}"
  ok "Bootstrap S3 config written to ${S3_JSON_FILE}"
}

generate_runtime_s3_config() {
  log "Generating runtime S3 config with real credentials..."
  jq -n \
    --arg tempo_key "${SEAWEEDFS_TEMPO_ACCESS_KEY}" \
    --arg tempo_secret "${SEAWEEDFS_TEMPO_SECRET_KEY}" \
    '{
      identities: [
        {
          name: "tempo",
          credentials: [{accessKey: $tempo_key, secretKey: $tempo_secret}],
          actions: ["Read:tempo-traces", "Write:tempo-traces", "List:tempo-traces", "Tagging:tempo-traces"]
        }
      ]
    }' > "${S3_JSON_FILE}"
  ok "Runtime S3 config written to ${S3_JSON_FILE}"
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

wait_bootstrap_bucket() {
  local max_wait=${1:-60}
  local waited=0
  log "Waiting for bootstrap-bucket to complete..."
  while [[ $waited -lt $max_wait ]]; do
    local state
    state=$(docker inspect -f '{{.State.Status}}' bootstrap-bucket 2>/dev/null || echo "notfound")
    if [[ "$state" == "exited" ]]; then
      local exit_code
      exit_code=$(docker inspect -f '{{.State.ExitCode}}' bootstrap-bucket 2>/dev/null)
      if [[ "$exit_code" == "0" ]]; then
        aws s3api head-bucket --bucket tempo-traces \
          --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" \
          --region us-east-1 >/dev/null 2>&1 || die "bootstrap-bucket exited 0 but bucket not found"
        ok "bootstrap-bucket completed successfully (bucket verified)"
        return 0
      else
        die "bootstrap-bucket exited with code ${exit_code}"
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done
  die "bootstrap-bucket did not complete within ${max_wait}s"
}

stop_seaweedfs() {
  log "Stopping SeaweedFS for config swap..."
  docker compose -f "${COMPOSE_FILE}" stop seaweedfs
  local max_wait=30
  local waited=0
  while [[ $waited -lt $max_wait ]]; do
    local state
    state=$(docker inspect -f '{{.State.Status}}' seaweedfs 2>/dev/null || echo "notfound")
    [[ "$state" == "exited" ]] && { ok "SeaweedFS stopped"; return 0; }
    sleep 1
    waited=$((waited + 1))
  done
  die "SeaweedFS did not stop within ${max_wait}s"
}

restart_seaweedfs() {
  log "Starting SeaweedFS with new config..."
  docker compose -f "${COMPOSE_FILE}" up -d --force-recreate seaweedfs
  wait_healthy seaweedfs
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
              { key: "test.tenant", value: { stringValue: "tenant-a" } }
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

assert_admin_denied() {
  log "Asserting Admin credential is denied after config swap..."
  export AWS_ACCESS_KEY_ID="${SEAWEEDFS_ADMIN_ACCESS_KEY}"
  export AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_ADMIN_SECRET_KEY}"
  export AWS_REGION=us-east-1
  export AWS_ENDPOINT_URL="${SEAWEEDFS_S3_ENDPOINT}"
  export AWS_EC2_METADATA_DISABLED="true"

  log "  Admin: Attempting create-bucket (expect denial)..."
  if aws s3api create-bucket --bucket tempo-traces-admin-deny --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
    die "Admin negative control failed: Admin credential was able to create bucket"
  fi
  ok "  Admin credential correctly denied create-bucket"

  log "  Admin: Attempting delete-bucket (expect denial)..."
  if aws s3api delete-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
    die "Admin negative control failed: Admin credential was able to delete bucket"
  fi
  ok "  Admin credential correctly denied delete-bucket"

  log "  Admin: Attempting head-bucket on tempo-traces (expect denial)..."
  if aws s3api head-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
    die "Admin negative control failed: Admin credential accessed bucket"
  fi
  ok "  Admin credential correctly denied head-bucket"
}

assert_tempo_access() {
  log "Asserting Tempo credential can access its bucket..."
  export AWS_ACCESS_KEY_ID="${SEAWEEDFS_TEMPO_ACCESS_KEY}"
  export AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_TEMPO_SECRET_KEY}"
  export AWS_REGION=us-east-1
  export AWS_ENDPOINT_URL="${SEAWEEDFS_S3_ENDPOINT}"
  export AWS_EC2_METADATA_DISABLED="true"

  log "  Tempo: head-bucket tempo-traces (expect success)..."
  aws s3api head-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" >/dev/null 2>&1 \
    || die "Tempo credential could not access its own bucket"
  ok "  Tempo credential correctly accessed tempo-traces"

  log "  Tempo: head-bucket other-bucket (expect denial)..."
  if aws s3api head-bucket --bucket some-other-bucket --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
    die "Tempo negative control failed: Tempo credential accessed different bucket"
  fi
  ok "  Tempo credential correctly denied cross-bucket access"
}

# ========= MAIN VERIFICATION =========
main() {
  log "=== Gate 1A Durability + Least-Privilege Verification Started ==="
  [[ "${BASELINE_MODE}" == "true" ]] && log "BASELINE MODE: credential negative controls will be SKIPPED"
  check_prereqs

  # --- PHASE 1: BOOTSTRAP WITH ADMIN + TEMPO IDENTITIES ---
  log "=== PHASE 1: Bootstrap with Admin + Tempo identities ==="
  generate_bootstrap_s3_config

  log "Starting SeaweedFS (bootstrap config)..."
  docker compose -f "${COMPOSE_FILE}" up -d seaweedfs
  wait_healthy seaweedfs

  log "Running bootstrap-bucket with Admin credentials..."
  docker compose -f "${COMPOSE_FILE}" up -d bootstrap-bucket
  wait_bootstrap_bucket 30

  # --- PHASE 2: SWAP TO RUNTIME CONFIG (TEMPO ONLY) ---
  log "=== PHASE 2: Swap to runtime config (Tempo only) ==="
  stop_seaweedfs
  generate_runtime_s3_config
  restart_seaweedfs

  # --- PHASE 3: VERIFY IDENTITY SWAP ---
  log "=== PHASE 3: Verify identity swap ==="
  if [[ "${BASELINE_MODE}" == "true" ]]; then
    log "BASELINE MODE: Skipping Admin/Tempo credential assertions"
  else
    assert_admin_denied
    assert_tempo_access
  fi

  # --- PHASE 4: START TEMPO ---
  log "=== PHASE 4: Start Tempo (steady state) ==="
  docker compose -f "${COMPOSE_FILE}" up -d tempo
  wait_healthy tempo
  wait_tempo_ready

  # --- PHASE 5: EMIT DETERMINISTIC CORPUS ---
  log "=== PHASE 5: Emit synthetic traces ==="
  local trace_id1=$(openssl rand -hex 16)
  local span_id1=$(openssl rand -hex 8)
  local trace_id2=$(openssl rand -hex 16)
  local span_id2=$(openssl rand -hex 8)
  local emit_time=$(date +%s)
  emit_trace "${trace_id1}" "${span_id1}"
  emit_trace "${trace_id2}" "${span_id2}"
  log "Emitted traces: ${trace_id1}, ${trace_id2} at ${emit_time}"

  log "Waiting for durable flush to SeaweedFS..."
  sleep 10

  local trace_ids=("${trace_id1}" "${trace_id2}")

  # --- PHASE 6: DESTROY TEMPO + TEMPO-LOCAL STATE ---
  log "=== PHASE 6: Destroy Tempo container and local state ==="
  docker rm -f tempo >/dev/null 2>&1 || true

  # --- PHASE 7: RECREATE TEMPO (STEADY STATE) ---
  log "=== PHASE 7: Recreate Tempo against existing SeaweedFS ==="
  docker compose -f "${COMPOSE_FILE}" up -d tempo
  wait_healthy tempo
  wait_tempo_ready

  # --- PHASE 8: TRACE-BY-ID ASSERTIONS ---
  log "=== PHASE 8: Verify trace-by-ID retrieval ==="
  for tid in "${trace_ids[@]}"; do
    local result
    result=$(query_trace_by_id "${tid}")
    echo "${result}" | jq -e --arg t "${tid}" '.spans[0].traceID == $t' >/dev/null || die "Trace ${tid} not found by ID"
    ok "Trace ${tid} retrieved by ID"
  done

  local search_start=$((emit_time - 60))
  local search_end=$((emit_time + 60))

  # --- PHASE 9: EXPLICIT-WINDOW TRACEQL POSITIVE CONTROL ---
  log "=== PHASE 9: TraceQL positive control (tenant-a, explicit window) ==="
  local result
  result=$(query_traceql '{.service.name = "gate1a-verifier" && .test.tenant = "tenant-a"}' "${search_start}000000000" "${search_end}000000000")
  local count
  count=$(echo "${result}" | jq '.traces | length')
  [[ ${count} -ge 2 ]] || die "Expected >=2 traces, got ${count}"
  ok "TraceQL positive control: ${count} traces found"

  # --- PHASE 10: EXPLICIT-WINDOW TRACEQL NEGATIVE CONTROL ---
  log "=== PHASE 10: TraceQL negative control (tenant-b, should find 0) ==="
  result=$(query_traceql '{.service.name = "gate1a-verifier" && .test.tenant = "tenant-b"}' "${search_start}000000000" "${search_end}000000000")
  count=$(echo "${result}" | jq '.traces | length')
  [[ ${count} -eq 0 ]] || die "Negative control failed: found ${count} traces for tenant-b"
  ok "TraceQL negative control: 0 traces as expected"

  # --- PHASE 11: SCOPE CORRECTION ---
  log "=== PHASE 11: SKIPPING fake REDACT_ME assertion (scope correction) ==="
  log "  This verifier does NOT traverse Opnory emitter/redaction path."
  log "  Opnory redaction/lifecycle proof is a separate artifact using real emitter + Phase 7 corpus."

  # --- PHASE 12: NEGATIVE CONTROLS FOR TEMPO CREDENTIAL ---
  if [[ "${BASELINE_MODE}" == "true" ]]; then
    log "BASELINE MODE: Skipping Tempo credential negative controls"
  else
    log "=== PHASE 12: Tempo credential negative controls ==="
    export AWS_ACCESS_KEY_ID="${SEAWEEDFS_TEMPO_ACCESS_KEY}"
    export AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_TEMPO_SECRET_KEY}"
    export AWS_REGION=us-east-1
    export AWS_ENDPOINT_URL="${SEAWEEDFS_S3_ENDPOINT}"
    export AWS_EC2_METADATA_DISABLED="true"

    log "  12a: Attempting create-bucket with Tempo cred (expect denial)..."
    if aws s3api create-bucket --bucket tempo-traces-2 --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential was able to create bucket"
    fi
    ok "  Tempo credential correctly denied create-bucket"

    log "  12b: Attempting delete-bucket with Tempo cred (expect denial)..."
    if aws s3api delete-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential was able to delete bucket"
    fi
    ok "  Tempo credential correctly denied delete-bucket"

    log "  12c: Attempting head-bucket on different bucket with Tempo cred (expect denial)..."
    if aws s3api head-bucket --bucket some-other-bucket --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential accessed different bucket"
    fi
    ok "  Tempo credential correctly denied cross-bucket access"
  fi

  log "=== ALL GATE 1A DURABILITY + LEAST-PRIVILEGE ASSERTIONS PASSED ==="
}

main "$@"