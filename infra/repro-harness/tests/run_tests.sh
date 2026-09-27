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

# F-5 (t_84c60ec5): budget enforcement is CUMULATIVE across cycles. The
# old per-cycle `init --force` truncated the ledger so totals only ever saw
# the last cycle (max 28 vs the declared 56 <= 60 arithmetic). One ledger,
# two cycles of create+delete: totals must observe BOTH cycles (5+5+5+5=20).
L3="$TMP/ledger-cumulative.jsonl"
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" init --cycle 1 --commit abc1234
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" record --cycle 1 --step apply --action create --count 5
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" record --cycle 1 --step destroy --action delete --count 5
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" record --cycle 2 --step cycle_start --action noop --count 0
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" record --cycle 2 --step apply --action create --count 5
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" record --cycle 2 --step destroy --action delete --count 5
expect_rc 0 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" assert-budget --budget 20
expect_rc 3 "$PY" "$HERE/scripts/mutation_ledger.py" --ledger "$L3" assert-budget --budget 19

# --- AWS escape guards (Phase 1B-COST-SAFETY; static only, zero AWS calls) ---
# Runs the full 15+guard-16 suite as part of the standard self-test gate.
if bash "$HERE/tests/aws_escape_guards.sh" >/dev/null 2>&1; then
  echo "ok: aws_escape_guards.sh (all guards pass)"
else
  echo "FAIL: aws_escape_guards.sh — see its own output for the failing guard"
  fail=1
fi

# --- AWS preflight provider=aws path ----------------------------------------
# A provider=aws target in dry-run mode must pass the config-shape checks.
cat > "$TMP/lab-aws.json" <<'EOF'
{"environment": "lab", "provider": "aws", "mutation_budget": 60,
 "state_identity": "s3:opnory-iac-state/lab.tfstate",
 "allowed_provider_account_hint": "deadbeefcafe",
 "aws_free_plan_attestation": "human-confirmed-free-plan-2026-09",
 "tofu Working directory": "infra/environments/lab"}
EOF
expect_rc 0 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/lab-aws.json" --mode dry-run

# provider=aws live mode without the free-plan gate must fail closed (rc 3)
# even when the Phase 1B live authorization IS set: G2 is independent of G1.
OPNORY_IAC_PHASE=1B OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab \
  expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/lab-aws.json" --mode live --steps plan

# An agent-forged free-plan value (env != target attestation) must not pass.
OPNORY_IAC_PHASE=1B OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab \
  OPNORY_AWS_FREE_PLAN_CONFIRMED=forged-by-agent \
  expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/lab-aws.json" --mode live --steps plan

# A tampered instance_type in the lab variables must fail the static check.
cp "$HERE/../environments/lab/variables.tf" "$TMP/variables.tf.bak"
sed 's/var.instance_type == "t3a.medium"/var.instance_type == "m5.2xlarge"/' \
  "$HERE/../environments/lab/variables.tf" > "$TMP/vt-tmp" && cp "$TMP/vt-tmp" "$HERE/../environments/lab/variables.tf"
expect_rc 3 "$PY" "$HERE/scripts/preflight.py" --target "$TMP/lab-aws.json" --mode dry-run
cp "$TMP/variables.tf.bak" "$HERE/../environments/lab/variables.tf"

# --- F-2/F-3 self-test: stripped-labels provider dir (t_84c60ec5) -----------
# The label assertion must fail CLOSED (rc=3, never a traceback — the F-2
# IndexError regression exited rc=1 and lost the offender detail) and must
# NAME the offending resource. The fixture strips the in-block tags from
# ONLY aws_subnet in a copy of the real module while the file still
# references local.labels in other blocks — exactly the violation shape the
# old file-level `or "local.labels" in text` fallback masked (F-3).
NEGFIX2="$TMP/labelfix"
mkdir -p "$NEGFIX2/infra/repro-harness/scripts" \
         "$NEGFIX2/infra/providers/aws/network" \
         "$NEGFIX2/infra/environments/lab"
cp "$HERE/scripts/preflight.py" "$NEGFIX2/infra/repro-harness/scripts/"
cp "$HERE/../providers/aws/network/main.tf" "$NEGFIX2/infra/providers/aws/network/main.tf"
sed '/resource "aws_subnet" "lab"/,/^}/ s/^[[:space:]]*tags = local\.labels$//' \
  "$NEGFIX2/infra/providers/aws/network/main.tf" > "$TMP/stripped.tf"
mv "$TMP/stripped.tf" "$NEGFIX2/infra/providers/aws/network/main.tf"
if grep -q 'tags = local.labels' "$NEGFIX2/infra/providers/aws/network/main.tf"; then
  echo "ok: fixture still references local.labels in sibling blocks (F-3 premise holds)"
else
  echo "FAIL: fixture construction stripped every labels reference"; fail=1
fi
cat > "$TMP/labelfix-target.json" <<'EOF'
{"environment": "lab", "provider": "aws", "mutation_budget": 60,
 "state_identity": "s3:opnory-iac-state/lab.tfstate",
 "aws_free_plan_attestation": "x",
 "tofu Working directory": "infra/environments/lab"}
EOF
PFOUT="$("$PY" "$NEGFIX2/infra/repro-harness/scripts/preflight.py" \
  --target "$TMP/labelfix-target.json" --mode dry-run 2>&1)"
PFRC=$?
if [ "$PFRC" -eq 3 ]; then
  if printf '%s' "$PFOUT" | grep -q 'aws_subnet\.lab missing lab labels'; then
    if printf '%s' "$PFOUT" | grep -q 'Traceback'; then
      echo "FAIL: label assertion crashed with a traceback (F-2 regression)"
      fail=1
    else
      echo "ok: stripped-labels provider dir -> rc=3, offender aws_subnet.lab named, no traceback (F-2/F-3)"
    fi
  else
    echo "FAIL: offender aws_subnet.lab not named in the FAIL detail"
    fail=1
  fi
else
  echo "FAIL: expected rc=3 on stripped-labels provider dir, got rc=$PFRC (exit contract is 0|3)"
  fail=1
fi

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
# F-6 (t_84c60ec5): the leaked-key fixture is assembled from two fragments
# so the REPO never contains the contiguous forbidden pattern — CI's
# forbidden-pattern grep scans all of infra/ and previously matched this
# test's own input string. The assembled key exists only in the throwaway
# /tmp evidence file, where render_evidence.py must reject it.
LEAK1='-----BEGIN OPENSSH PRIV'
LEAK2='ATE KEY-----'
sed "s/\"unresolved\"/\"$LEAK1$LEAK2\"/" "$TMP/ev-dry.json" > "$TMP/ev-bad.json"
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
