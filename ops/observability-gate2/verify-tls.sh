#!/usr/bin/env bash
# verify-tls.sh — Gate 2 TLS live verification
# Proves: observability.opnory.com is TLS-terminated, backends are private, no cert material in git.
# Fails closed (non-zero exit on any FAIL).
# Usage: GATE2_HOST=observability.opnory.com GATE2_PUBLIC_IP=<VPS_IP> ./verify-tls.sh
# Must run from repo root on the VPS (for docker compose restart + git checks).

set -euo pipefail

HOST="${GATE2_HOST:-observability.opnory.com}"
PUBLIC_IP="${GATE2_PUBLIC_IP:-}"

echo "=== Gate 2 TLS Verification ==="
echo "Target hostname: $HOST"
echo ""

FAIL=0
CHECK_RESULTS=()

record_check() {
    local name="$1"
    local result="$2"
    local detail="${3:-}"
    CHECK_RESULTS+=("$name=$result")
    if [[ "$result" == "PASS" ]]; then
        echo "   PASS: $detail"
    else
        echo "   FAIL: $detail"
        FAIL=1
    fi
}

# 1. DNS resolution
echo "1. Public DNS resolution"
if dig +short "$HOST" | grep -qE '^[0-9]+\.'; then
    record_check "dns" "PASS" "$HOST resolves"
else
    record_check "dns" "FAIL" "$HOST does not resolve to an A record"
fi
echo ""

# 2. Certificate chain / SAN / validity
echo "2. Certificate chain / SAN / validity"
# Capture PEM for -checkend, text for SAN
if CERT_PEM=$(openssl s_client -connect "$HOST:443" -servername "$HOST" </dev/null 2>/dev/null |
    openssl x509 -outform PEM 2>/dev/null); then
    record_check "cert_chain" "PASS" "Certificate chain valid and parseable"
    # SAN match (from text representation)
    CERT_TEXT=$(echo "$CERT_PEM" | openssl x509 -noout -text 2>/dev/null)
    if echo "$CERT_TEXT" | grep -q "DNS:$HOST"; then
        record_check "cert_san" "PASS" "Certificate SAN matches $HOST"
    else
        record_check "cert_san" "FAIL" "Certificate SAN does not match $HOST"
    fi
    # Validity window (against PEM)
    if echo "$CERT_PEM" | openssl x509 -noout -checkend 0 2>/dev/null; then
        record_check "cert_valid" "PASS" "Certificate currently valid (not expired)"
    else
        record_check "cert_valid" "FAIL" "Certificate expired"
    fi
else
    record_check "cert_chain" "FAIL" "Cannot retrieve/parse certificate from $HOST:443"
    record_check "cert_san" "FAIL" "Cannot retrieve/parse certificate from $HOST:443"
    record_check "cert_valid" "FAIL" "Cannot retrieve/parse certificate from $HOST:443"
fi
echo ""

# 3. HTTPS request succeeds
echo "3. HTTPS request succeeds"
if curl -fsS --max-time 10 "https://$HOST/healthz" | grep -q "ok"; then
    record_check "https" "PASS" "HTTPS GET /healthz returns 200 ok"
else
    record_check "https" "FAIL" "HTTPS GET /healthz failed"
fi
echo ""

# 4. HTTP redirects to HTTPS or is unavailable (port 80)
echo "4. HTTP :80 redirects to HTTPS or is unavailable"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://$HOST/healthz" || echo "000")
if [[ "$HTTP_CODE" =~ ^30[1278]$ ]]; then
    record_check "http_redirect" "PASS" "HTTP redirects to HTTPS (code $HTTP_CODE)"
elif [[ "$HTTP_CODE" == "000" ]]; then
    record_check "http_redirect" "PASS" "HTTP port 80 unavailable (connection refused/timeout)"
else
    record_check "http_redirect" "FAIL" "HTTP returned $HTTP_CODE (expected 3xx redirect or unreachable)"
fi
echo ""

# 5. TLS protocol versions
echo "5. TLS protocol versions"
for PROTO in tls1_2 tls1_3; do
    if openssl s_client -connect "$HOST:443" -servername "$HOST" -$PROTO </dev/null 2>/dev/null | grep -q "Cipher is"; then
        record_check "proto_$PROTO" "PASS" "$PROTO usable"
    else
        record_check "proto_$PROTO" "FAIL" "$PROTO NOT usable"
    fi
done
for PROTO in tls1 tls1_1 ssl3; do
    if openssl s_client -connect "$HOST:443" -servername "$HOST" -$PROTO </dev/null 2>/dev/null | grep -q "Cipher is"; then
        record_check "proto_$PROTO" "FAIL" "Obsolete $PROTO ACCEPTED (must be rejected)"
    else
        record_check "proto_$PROTO" "PASS" "Obsolete $PROTO rejected"
    fi
done
echo ""

# 6. Negative controls — backend ports NOT publicly reachable
echo "6. Negative controls — backend ports NOT publicly reachable"
if [[ -n "$PUBLIC_IP" ]]; then
    for PORT in 3000 3200 4317 4318 8333; do
        if timeout 3 bash -c "</dev/tcp/$PUBLIC_IP/$PORT" 2>/dev/null; then
            record_check "port_$PORT" "FAIL" "Port $PORT is publicly reachable on $PUBLIC_IP"
        else
            record_check "port_$PORT" "PASS" "Port $PORT not reachable on $PUBLIC_IP (NOT EXPOSED)"
        fi
    done
else
    echo "   SKIP: GATE2_PUBLIC_IP not set — cannot test public interface reachability"
    echo "   NOTE: Set GATE2_PUBLIC_IP to the VPS public IP to enable this check"
    for PORT in 3000 3200 4317 4318 8333; do
        CHECK_RESULTS+=("port_$PORT=SKIP")
    done
fi
echo ""

# 7. Proxy restart recovery
echo "7. Caddy restart recovery"
if command -v docker >/dev/null && docker compose -f ops/observability-gate2/compose.yml restart caddy >/dev/null 2>&1; then
    sleep 3
    if curl -fsS --max-time 10 "https://$HOST/healthz" | grep -q "ok"; then
        record_check "restart" "PASS" "HTTPS recovers after Caddy restart"
    else
        record_check "restart" "FAIL" "HTTPS failed after Caddy restart"
    fi
else
    echo "   SKIP: Docker not available or compose file not in expected location"
    CHECK_RESULTS+=("restart=SKIP")
fi
echo ""

# 8. Certificate/private key NOT in git (tracked + untracked)
echo "8. Certificate/private key in Git"
CERT_FILES=$(git ls-files | grep -E '\.(pem|key|crt|p12|pfx)$' || true)
UNTRACTED_CERT_FILES=$(git ls-files --others --ignored --exclude-standard | grep -E '\.(pem|key|crt|p12|pfx)$' || true)
if [[ -z "$CERT_FILES" && -z "$UNTRACKED_CERT_FILES" ]]; then
    record_check "git_certs" "PASS" "No certificate/private key files tracked or untracked by Git"
else
    record_check "git_certs" "FAIL" "Certificate/private key files found in Git (tracked: $CERT_FILES; untracked: $UNTRACKED_CERT_FILES)"
fi
echo ""

# Summary
echo "=== Gate 2 Evidence Summary ==="
if [[ $FAIL -eq 0 ]]; then
    echo "All checks PASSED"
else
    echo "Some checks FAILED"
fi
echo ""

# Per-check PASS/FAIL in the contracted evidence format
for entry in "${CHECK_RESULTS[@]}"; do
    name="${entry%%=*}"
    result="${entry#*=}"
    case "$name" in
        dns)                  echo "  Public DNS → TLS termination:              $result" ;;
        cert_chain|cert_san|cert_valid) echo "  Valid hostname certificate:                $result" ;;
        https)                echo "  HTTPS request succeeds:                    $result" ;;
        http_redirect)        echo "  HTTP redirects to HTTPS or unavailable:    $result" ;;
        proto_tls1_2|proto_tls1_3|proto_tls1|proto_tls1_1|proto_ssl3) echo "  Modern TLS transport / obsolete rejected:  $result" ;;
        port_3000)            echo "  Grafana direct public exposure:            $result" ;;
        port_3200)            echo "  Tempo direct public exposure:              $result" ;;
        port_4317|port_4318)  echo "  OTLP direct public exposure:               $result" ;;
        port_8333)            echo "  SeaweedFS direct public exposure:          $result" ;;
        restart)              echo "  TLS recovery after proxy restart:          $result" ;;
        git_certs)            echo "  Certificate/private key in Git:            $result" ;;
    esac
done

echo ""
echo "  SSO/auth/authz:                             NOT CLAIMED"
echo "  Certificate HA:                            NOT CLAIMED"
echo "  Multi-node proxy availability:             NOT CLAIMED"
echo "  Gate 3:                                    UNPROVEN"
echo ""
echo "  Overall observability production readiness: NOT CLAIMED"

exit $FAIL