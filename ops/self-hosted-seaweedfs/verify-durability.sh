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
SEAWEEDFS_S3_ENDPOINT="http://seaweedfs:8333"

CONTAINER_NAMES=("seaweedfs" "tempo")
VOLUME_NAME="seaweedfs-data"

BASELINE_MODE=false

# ========= HELPERS =========
log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }
ok() { log "OK: $*"; }

require_env() {
  local var=$1
  [[ -n "${!var:-}" ]] || die "Missing required env: $var"
}

aws_s3() {
  docker run --rm --network "${COMPOSE_PROJECT:-self-hosted-seaweedfs}_tempo-net" \
    -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
    -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
    -e AWS_REGION="${AWS_REGION:-us-east-1}" \
    -e AWS_EC2_METADATA_DISABLED="true" \
    amazon/aws-cli:latest "$@"
}

require_docker() {
  docker info >/dev/null 2>&1 || die "Docker is not running"
  docker image inspect amazon/aws-cli:latest >/dev/null 2>&1 || die "amazon/aws-cli:latest image not available"
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
  command -v docker >/dev/null || die "docker compose not found"
  command -v jq >/dev/null || die "jq not found"
  command -v curl >/dev/null || die "curl not found"
  command -v openssl >/dev/null || die "openssl not found"
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
  require_docker
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

bootstrap_bucket_fail_closed() {
  log "Running fail-closed bucket bootstrap (Admin credentials)..."
  # One-shot container: deterministic exit code, no persistent-service race.
  set +e
  docker run --rm --network "${COMPOSE_PROJECT:-self-hosted-seaweedfs}_tempo-net" \
    -e AWS_ACCESS_KEY_ID="${SEAWEEDFS_ADMIN_ACCESS_KEY}" \
    -e AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_ADMIN_SECRET_KEY}" \
    -e AWS_REGION=us-east-1 \
    -e AWS_ENDPOINT_URL="http://seaweedfs:8333" \
    -e AWS_EC2_METADATA_DISABLED="true" \
    --entrypoint /bin/sh amazon/aws-cli:latest -c '
      aws s3api head-bucket --bucket tempo-traces 2>/dev/null ||
      aws s3api create-bucket --bucket tempo-traces;
      aws s3api head-bucket --bucket tempo-traces
    '
  local rc=$?
  set -e
  [[ $rc -eq 0 ]] || die "fail-closed bootstrap failed: final head-bucket did not pass (exit ${rc})"
  ok "fail-closed bootstrap completed: bucket tempo-traces verified"
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
  # Emit inside the compose network to avoid host port conflicts.
  # Uses the same pattern as aws_s3(): docker run --rm on tempo-net.
  local network_name="${COMPOSE_PROJECT:-self-hosted-seaweedfs}_tempo-net"
  echo "$payload" | docker run --rm -i --network "$network_name" \
    curlimages/curl:latest \
    curl -sf -X POST http://tempo:4318/v1/traces \
      -H "Content-Type: application/json" \
      -H "X-Tempo-Tenant: single-tenant" \
      -d @- >/dev/null || die "Failed to emit trace"
  ok "Emitted trace ${trace_id}"
}

wait_trace_available() {
  local tid=$1
  local max_wait=${2:-150}
  local waited=0
  local result
  while (( waited < max_wait )); do
    result=$(curl -sf "${TEMPO_API_ENDPOINT}/api/traces/${tid}" 2>/dev/null || true)
    # Tempo 2.x returns OTLP JSON: {"batches": [{"resourceSpans": [...]}]}
    # Check for .batches (OTLP) OR .spans (legacy) — tolerate both shapes.
    if echo "${result}" | jq -e '(.batches // .spans) | length > 0' >/dev/null 2>&1; then
      echo "${result}"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  die "Timeout: trace ${tid} not available after ${max_wait}s"
}

query_traceql() {
  local query=$1
  local start=$2
  local end=$3
  # Return raw body + HTTP status; do NOT die on non-2xx so caller can inspect.
  # CRITICAL: include tenant header to match Tempo multitenancy routing (proven by probes).
  local result
  result=$(curl -s -w '\n__HTTP__%{http_code}' -G "${TEMPO_API_ENDPOINT}/api/search" \
    -H "X-Tempo-Tenant: single-tenant" \
    --data-urlencode "q=${query}" \
    --data-urlencode "start=${start}" \
    --data-urlencode "end=${end}" \
    --data-urlencode "limit=10" \
    || echo "__CURL_FAILED__$?")
  # Guard: if curl failed outright, result won't have __HTTP__ trailer
  [[ "$result" == *"__HTTP__"* ]] || die "TraceQL failed: $result"
  echo "$result"
}

assert_admin_denied() {
  log "Asserting Admin credential is denied after config swap..."
  export AWS_ACCESS_KEY_ID="${SEAWEEDFS_ADMIN_ACCESS_KEY}"
  export AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_ADMIN_SECRET_KEY}"
  export AWS_REGION=us-east-1
  export AWS_ENDPOINT_URL="${SEAWEEDFS_S3_ENDPOINT}"
  export AWS_EC2_METADATA_DISABLED="true"

  log "  Admin: Attempting create-bucket (expect denial)..."
  if aws_s3 s3api create-bucket --bucket tempo-traces-admin-deny --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
    die "Admin negative control failed: Admin credential was able to create bucket"
  fi
  ok "  Admin credential correctly denied create-bucket"

  log "  Admin: Attempting delete-bucket (expect denial)..."
  if aws_s3 s3api delete-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
    die "Admin negative control failed: Admin credential was able to delete bucket"
  fi
  ok "  Admin credential correctly denied delete-bucket"

  log "  Admin: Attempting head-bucket on tempo-traces (expect denial)..."
  if aws_s3 s3api head-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
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
  aws_s3 s3api head-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" >/dev/null 2>&1 \
    || die "Tempo credential could not access its own bucket"
  ok "  Tempo credential correctly accessed tempo-traces"

  log "  Tempo: head-bucket other-bucket (expect denial)..."
  if aws_s3 s3api head-bucket --bucket some-other-bucket --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
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

  log "Running fail-closed bootstrap with Admin credentials..."
  bootstrap_bucket_fail_closed

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
  docker compose -f "${COMPOSE_FILE}" up -d --no-deps tempo
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
  # Wait for Tempo's ingester to complete the block (max_block_bytes: 10k)
  # and flush to S3. Graceful stop triggers flush but it's async.
  # Poll S3 until at least one block object appears (not just seed.json).
  local max_wait=120
  local waited=0
  local flushed=false
  while [[ $waited -lt $max_wait ]]; do
    if docker run --rm --network self-hosted-seaweedfs_tempo-net \
      -e AWS_ACCESS_KEY_ID="${SEAWEEDFS_TEMPO_ACCESS_KEY}" \
      -e AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_TEMPO_SECRET_KEY}" \
      -e AWS_REGION=us-east-1 \
      -e AWS_EC2_METADATA_DISABLED=true \
      amazon/aws-cli:latest s3 ls "s3://tempo-traces/single-tenant/" --recursive --endpoint-url http://seaweedfs:8333 2>/dev/null | grep -qE "bloom-0|data.parquet|meta.json"; then
      ok "S3 block objects detected in tempo-traces"
      flushed=true
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
  [[ $flushed == true ]] || die "Timeout waiting for S3 block objects (waited ${max_wait}s)"

  local trace_ids=("${trace_id1}" "${trace_id2}")

  # --- PHASE 6: TRACEQL POSITIVE CONTROL (RUN WHILE ORIGINAL INGEST TEMPO IS UP) ---
  # These assertions are deterministic against the Tempo that ingested the traces.
  # They do NOT need to survive destroy/recreate — that's the trace-by-ID proof.
  local search_start=$((emit_time - 3600))
  local search_end=$((emit_time + 3600))

  log "=== PHASE 6: TraceQL positive control (tenant-a, explicit window) ==="
  local result
  result=$(query_traceql '{resource.service.name = "gate1a-verifier" && .test.tenant = "tenant-a"}' "${search_start}" "${search_end}")
  local http_body http_status
  http_body="${result%$'\n'*}"
  http_status="${result##*$'\n'}"
  http_status="${http_status#*__HTTP__}"
  log "  TraceQL HTTP ${http_status}; body: ${http_body}"
  local count
  count=$(echo "${http_body}" | jq '.traces | length' 2>/dev/null || echo "0")
  [[ ${http_status} -eq 200 ]] || die "TraceQL positive control failed with HTTP ${http_status}"
  [[ ${count} -ge 2 ]] || die "Expected >=2 traces, got ${count} (HTTP ${http_status})"
  ok "TraceQL positive control: ${count} traces found"

  # --- PHASE 7: TRACEQL NEGATIVE CONTROL (RUN WHILE ORIGINAL INGEST TEMPO IS UP) ---
  log "=== PHASE 7: TraceQL negative control (tenant-b, should find 0) ==="
  result=$(query_traceql '{resource.service.name = "gate1a-verifier" && .test.tenant = "tenant-b"}' "${search_start}" "${search_end}")
  http_body="${result%$'\n'*}"
  http_status="${result##*$'\n'}"
  http_status="${http_status#*__HTTP__}"
  log "  TraceQL HTTP ${http_status}; body: ${http_body}"
  count=$(echo "${http_body}" | jq '.traces | length' 2>/dev/null || echo "0")
  [[ ${http_status} -eq 200 ]] || die "TraceQL negative control failed with HTTP ${http_status}"
  [[ ${count} -eq 0 ]] || die "Negative control failed: found ${count} traces for tenant-b (HTTP ${http_status})"
  ok "TraceQL negative control: 0 traces as expected"

  # --- PHASE 8: DESTROY TEMPO + TEMPO-LOCAL STATE ---
  log "=== PHASE 8: Destroy Tempo container and local state ==="
  # Graceful stop (SIGTERM) so the ingester flushes its in-memory block to SeaweedFS
  # before the container is removed. Wait for async flush to complete.
  docker compose -f "${COMPOSE_FILE}" stop tempo
  # Wait for the ingester's async flush to S3 to complete
  # Poll S3 until block objects appear (not just seed.json).
  max_wait=120
  waited=0
  flushed=false
  while [[ $waited -lt $max_wait ]]; do
    if docker run --rm --network self-hosted-seaweedfs_tempo-net \
      -e AWS_ACCESS_KEY_ID="${SEAWEEDFS_TEMPO_ACCESS_KEY}" \
      -e AWS_SECRET_ACCESS_KEY="${SEAWEEDFS_TEMPO_SECRET_KEY}" \
      -e AWS_REGION=us-east-1 \
      -e AWS_EC2_METADATA_DISABLED=true \
      amazon/aws-cli:latest s3 ls "s3://tempo-traces/single-tenant/" --recursive --endpoint-url http://seaweedfs:8333 2>/dev/null | grep -qE "bloom-0|data.parquet|meta.json"; then
      ok "S3 block objects confirmed after graceful stop"
      flushed=true
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
  [[ $flushed == true ]] || die "Timeout waiting for S3 block objects after stop (waited ${max_wait}s)"
  docker compose -f "${COMPOSE_FILE}" rm -f tempo

  # --- PHASE 9: RECREATE TEMPO (STEADY STATE) ---
  log "=== PHASE 9: Recreate Tempo against existing SeaweedFS ==="
  docker compose -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps tempo
  wait_healthy tempo
  wait_tempo_ready
  # Poll trace-by-ID until querier discovers the block (blocklist_poll: 10s).
  # With 10s poller, discovery should happen within ~20-40s; poll up to 180s.
  log "Waiting for Tempo to discover S3 blocks (polling trace-by-ID)..."
  local _discover_probe
  _discover_probe=$(wait_trace_available "${trace_id1}" 180)
  ok "Tempo discovered S3 blocks (trace-by-ID responsive)"

  # --- PHASE 10: TRACE-BY-ID ASSERTIONS (DURABILITY PROOF) ---
  log "=== PHASE 10: Verify trace-by-ID retrieval ==="
  for tid in "${trace_ids[@]}"; do
    local result
    result=$(wait_trace_available "${tid}" 180)
    # Tolerate OTLP (.batches) or legacy (.spans) shape.
    echo "${result}" | jq -e '(.batches // .spans) | length > 0' >/dev/null || die "Trace ${tid} not found by ID (empty)"
    ok "Trace ${tid} retrieved by ID"
    # OTLP response: batches[].scopeSpans[].spans[].traceId (base64, lowercase 'd')
    log "  Response traceID format: $(echo "${result}" | jq -r '([.batches[]?.scopeSpans[]?.spans[]?.traceId] // [.spans[]?.traceID])[0] // "MISSING"')"
  done

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
    if aws_s3 s3api create-bucket --bucket tempo-traces-2 --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential was able to create bucket"
    fi
    ok "  Tempo credential correctly denied create-bucket"

    log "  12b: Attempting delete-bucket with Tempo cred (expect denial)..."
    if aws_s3 s3api delete-bucket --bucket tempo-traces --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential was able to delete bucket"
    fi
    ok "  Tempo credential correctly denied delete-bucket"

    log "  12c: Attempting head-bucket on different bucket with Tempo cred (expect denial)..."
    if aws_s3 s3api head-bucket --bucket some-other-bucket --endpoint-url "${SEAWEEDFS_S3_ENDPOINT}" 2>/dev/null; then
      die "Negative control failed: Tempo credential accessed different bucket"
    fi
    ok "  Tempo credential correctly denied cross-bucket access"
  fi

  log "=== ALL GATE 1A DURABILITY + LEAST-PRIVILEGE ASSERTIONS PASSED ==="
}

main "$@"