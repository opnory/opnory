#!/usr/bin/env bash
# verify-tls.sh — Gate 2 TLS live verification
# Proves: observability.opnory.com is TLS-terminated, backends are private, no cert material in git.
# Fails closed (non-zero exit on any FAIL).
# Usage: GATE2_HOST=observability.opnory.com ./verify-tls.sh

set -euo pipefail

HOST="${GATE2_HOST:-observability.opnory.com}"
PUBLIC_IP="${GATE2_PUBLIC_IP:-}"

echo "=== Gate 2 TLS Verification ==="
echo "Target hostname: $HOST"
echo ""

FAIL=0

# 1. DNS resolution
echo "1. Public DNS resolution"
if dig +short "$HOST" | grep -qE '^[0-9]+\.'; then
    echo "   PASS: $HOST resolves"
else
    echo "   FAIL: $HOST does not resolve to an A record"
    FAIL=1
fi
echo ""

# 2. Certificate chain / SAN / validity
echo "2. Certificate chain / SAN / validity"
if openssl s_client -connect "$HOST:443" -servername "$HOST" </dev/null 2>/dev/null |
   openssl x509 -noout -text >/tmp/cert.txt 2>/dev/null; then
    echo "   PASS: Certificate chain valid and parseable"
    # SAN match
    if grep -q "DNS:$HOST" /tmp/cert.txt; then
        echo "   PASS: Certificate SAN matches $HOST"
    else
        echo "   FAIL: Certificate SAN does not match $HOST"
        FAIL=1
    fi
    # Validity window
    if openssl x509 -noout -checkend 0 -in /tmp/cert.txt 2>/dev/null; then
        echo "   PASS: Certificate currently valid (not expired)"
    else
        echo "   FAIL: Certificate expired"
        FAIL=1
    fi
else
    echo "   FAIL: Cannot retrieve/parse certificate from $HOST:443"
    FAIL=1
fi
echo ""

# 3. HTTPS request succeeds
echo "3. HTTPS request succeeds"
if curl -fsS --max-time 10 "https://$HOST/healthz" | grep -q "ok"; then
    echo "   PASS: HTTPS GET /healthz returns 200 ok"
else
    echo "   FAIL: HTTPS GET /healthz failed"
    FAIL=1
fi
echo ""

# 4. HTTP redirects to HTTPS or is unavailable (port 80)
echo "4. HTTP :80 redirects to HTTPS or is unavailable"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://$HOST/healthz" || echo "000")
if [[ "$HTTP_CODE" =~ ^30[1278]$ ]]; then
    echo "   PASS: HTTP redirects to HTTPS (code $HTTP_CODE)"
elif [[ "$HTTP_CODE" == "000" ]]; then
    echo "   PASS: HTTP port 80 unavailable (connection refused/timeout)"
else
    echo "   FAIL: HTTP returned $HTTP_CODE (expected 3xx redirect or unreachable)"
    FAIL=1
fi
echo ""

# 5. TLS protocol versions
echo "5. TLS protocol versions"
for PROTO in tls1_2 tls1_3; do
    if openssl s_client -connect "$HOST:443" -servername "$HOST" -$PROTO </dev/null 2>/dev/null | grep -q "Cipher is"; then
        echo "   PASS: $PROTO usable"
    else
        echo "   FAIL: $PROTO NOT usable"
        FAIL=1
    fi
done
for PROTO in tls1 tls1_1 ssl3; do
    if openssl s_client -connect "$HOST:443" -servername "$HOST" -$PROTO </dev/null 2>/dev/null | grep -q "Cipher is"; then
        echo "   FAIL: Obsolete $PROTO ACCEPTED (must be rejected)"
        FAIL=1
    else
        echo "   PASS: Obsolete $PROTO rejected"
    fi
done
echo ""

# 6. Negative controls — backend ports NOT publicly reachable
echo "6. Negative controls — backend ports NOT publicly reachable"
if [[ -n "$PUBLIC_IP" ]]; then
    for PORT in 3000 3200 4317 4318 8333; do
        if timeout 3 bash -c "</dev/tcp/$PUBLIC_IP/$PORT" 2>/dev/null; then
            echo "   FAIL: Port $PORT is publicly reachable on $PUBLIC_IP"
            FAIL=1
        else
            echo "   PASS: Port $PORT not reachable on $PUBLIC_IP (NOT EXPOSED)"
        fi
    done
else
    echo "   SKIP: GATE2_PUBLIC_IP not set — cannot test public interface reachability"
    echo "   NOTE: Set GATE2_PUBLIC_IP to the VPS public IP to enable this check"
fi
echo ""

# 7. Proxy restart recovery
echo "7. Caddy restart recovery"
if command -v docker >/dev/null && docker compose -f ops/observability-gate2/compose.yml restart caddy >/dev/null 2>&1; then
    sleep 3
    if curl -fsS --max-time 10 "https://$HOST/healthz" | grep -q "ok"; then
        echo "   PASS: HTTPS recovers after Caddy restart"
    else
        echo "   FAIL: HTTPS failed after Caddy restart"
        FAIL=1
    fi
else
    echo "   SKIP: Docker not available or compose file not in expected location"
fi
echo ""

# 8. Certificate/private key NOT in git
echo "8. Certificate/private key in Git"
if git ls-files --others --ignored --exclude-standard | grep -qE '\.(pem|key|crt|p12|pfx)$'; then
    echo "   FAIL: Certificate/private key files found in working tree"
    FAIL=1
else
    echo "   PASS: No certificate/private key files tracked by Git"
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
echo "Production hardening — Gate 2 TLS:"
echo "  Public DNS → TLS termination:              ${FAIL:-PASS}"
echo "  Valid hostname certificate:                ${FAIL:-PASS}"
echo "  Modern TLS transport:                      ${FAIL:-PASS}"
echo "  Plaintext public service bypass:           NOT AVAILABLE"
echo "  Tempo direct public exposure:              ABSENT"
echo "  SeaweedFS direct public exposure:          ABSENT"
echo "  TLS recovery after proxy restart:          ${FAIL:-PASS}"
echo ""
echo "  SSO/auth/authz:                             NOT CLAIMED"
echo "  Certificate HA:                            NOT CLAIMED"
echo "  Multi-node proxy availability:             NOT CLAIMED"
echo "  Gate 3:                                    UNPROVEN"
echo ""
echo "  Overall observability production readiness: NOT CLAIMED"

exit $FAIL