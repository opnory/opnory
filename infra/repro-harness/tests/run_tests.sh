#!/usr/bin/env bash
# Self-tests for the IaC reproducibility harness. Non-mutating: exercises
# dry-run/static paths and ledger logic only. Exits 0 only if all pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
PY=python3
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

expect_rc() {
  local want="$1"; shift
  "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" -ne "$want" ]; then
    echo "FAIL: expected rc=$want got rc=$got: $*"
    fail=1
  else
    echo "ok(rc=$want): $*"
  fi
}

TARGET_EXAMPLE="$HERE/config/lab.target.example.json"

# --- preflight -------------------------------------------------------------
# 1. Example target fails (is the example file + provider unresolved)
expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TARGET_EXAMPLE" --mode dry-run

# 2. Valid-looking target in /tmp passes in dry-run even without provider impl? No:
#    provider check requires infra/providers/<name>. Use a fake valid config and
#    accept failure on provider (still fail-closed). So test that a config with a
#    bogus environment fails.
cat > "$TMP/bad-env.json" <<'EOF'
{"environment": "production", "provider": "x", "mutation_budget": 10,
 "state_identity": "local", "tofu Working directory": "infra"}
EOF
expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/bad-env.json" --mode dry-run

# 3. Lab env with real infra dir still blocked: no provider impl (fail-closed)
cat > "$TMP/lab-no-provider.json" <<'EOF'
{"environment": "lab", "provider": "unresolved", "mutation_budget": 60,
 "state_identity": "s3:example/lab.tfstate", "tofu Working directory": "infra/environments/lab"}
EOF
expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/lab-no-provider.json" --mode dry-run

# 4. live mode without authorization env must fail even ignoring other checks
expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/lab-no-provider.json" --mode live --steps plan,apply

# 5. Phase 1A hard block on apply/destroy even with authorization
OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab OPNORY_IAC_PHASE=1A \
  expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/lab-no-provider.json" --mode live --steps apply,destroy

# --- ledger ----------------------------------------------------------------
L="$TMP/ledger.jsonl"
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L" init --cycle 1 --commit abc1234
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L" record --cycle 1 --step apply --action create --count 5
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L" record --cycle 1 --step destroy --action delete --count 5
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L" assert-budget --budget 10
expect_rc 3 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L" assert-budget --budget 9
expect_rc 3 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L" record --cycle 1 --step apply --action create --count 10000
expect_rc 3 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L" init --cycle 2 --commit def5678

# --- lifecycle (dry-run with example target blocked by preflight) ----------
# Dry-run against the example target must fail preflight — preflight runs for real.
expect_rc 1 "$PY" "$HERE/scripts/lifecycle.py" --target "$TARGET_EXAMPLE" --mode dry-run \
  --ledger "$TMP/l2.jsonl" --evidence-out "$TMP/ev.json"

# --- evidence validation ----------------------------------------------------
# 3a. Build a synthetic DRY_RUN evidence doc valid per schema and validate it.
cat > "$TMP/ev-dry.json" <<EOF
{
  "schema_version": "1.0.0",
  "generated_at": "2026-09-22T00:00:00Z",
  "generator": "infra/repro-harness",
  "commit_sha": "abc1234",
  "tool_versions": {"opentofu": null, "ansible": null, "docker": null, "docker_compose": null},
  "provider": "unresolved",
  "environment": "lab",
  "terraform_state_identity": "s3:example/lab.tfstate",
  "mutation_budget": {"declared": 60, "observed": 0},
  "cycles": [
EOF
cycle() {
cat <<EOF
    {"cycle": $1,
     "preflight": {"status": "pass", "detail": "", "duration_seconds": 0, "mutations": 0},
     "plan": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "apply": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "cloud_init": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "ansible_converge": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "compose_up": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "workload_health": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "opnory_verification": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "post_apply_drift": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "ansible_idempotence": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "destroy": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "post_destroy_residue": {"status": "dry_run_planned", "detail": "", "duration_seconds": 0, "mutations": 0},
     "cycle_result": "DRY_RUN"}
EOF
}
cycle 1 >> "$TMP/ev-dry.json"; echo "," >> "$TMP/ev-dry.json"
cycle 2 >> "$TMP/ev-dry.json"
cat >> "$TMP/ev-dry.json" <<'EOF'
  ],
  "overall_result": "DRY_RUN"
}
EOF
expect_rc 0 "$PY" "$HERE/scripts/render_evidence.py" "$TMP/ev-dry.json"

# 3b. Evidence leaking a private key must be rejected.
sed 's/"unresolved"/"-----BEGIN OPENSSH PRIVATE KEY-----"/' "$TMP/ev-dry.json" > "$TMP/ev-bad.json"
expect_rc 3 "$PY" "$HERE/scripts/render_evidence.py" "$TMP/ev-bad.json"

# 3c. overall_result=PASS with DRY_RUN cycles must be rejected.
sed 's/"overall_result": "DRY_RUN"/"overall_result": "PASS"/' "$TMP/ev-dry.json" > "$TMP/ev-lie.json"
expect_rc 3 "$PY" "$HERE/scripts/render_evidence.py" "$TMP/ev-lie.json"

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL HARNESS SELF-TESTS PASS"
else
  echo "HARNESS SELF-TESTS FAILED"
fi
exit $fail
