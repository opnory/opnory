#!/usr/bin/env bash
# Phase 1B-COST-SAFETY Free-plan escape-guard suite (security design §9:
# 15 task guards + guard 16). All checks are STATIC — zero AWS API calls,
# zero cloud mutations. Exits 0 only if every guard holds.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
AWS_DIR="$REPO/infra/providers/aws"
POLICY="$AWS_DIR/iam/opnory-lab-executor.policy.json"
LAB_ENV="$REPO/infra/environments/lab"
fail=0

ok()   { echo "ok: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }

# assert_absent <guard-label> <grep-pattern> <paths...>
assert_absent() {
  local label="$1"; shift
  local pattern="$1"; shift
  if grep -rEq "$pattern" "$@" 2>/dev/null; then
    bad "$label: forbidden pattern present: $pattern"
  else
    ok "$label: absent ($pattern)"
  fi
}

# assert_present <guard-label> <grep-pattern> <paths...>
assert_present() {
  local label="$1"; shift
  local pattern="$1"; shift
  if grep -rEq "$pattern" "$@" 2>/dev/null; then
    ok "$label: present ($pattern)"
  else
    bad "$label: expected pattern MISSING: $pattern"
  fi
}

TF_FILES="$(find "$REPO/infra" -name '*.tf' -not -path '*/.terraform/*')"

# --- Guard 1: NAT Gateway ---------------------------------------------------
assert_absent "g1:nat-gateway" 'resource\s+"aws_nat_gateway"' $TF_FILES
python3 - "$POLICY" <<'EOF' && ok "g1:iam-no-create-nat-gateway" || bad "g1:iam-no-create-nat-gateway"
import json, sys
pol = json.load(open(sys.argv[1]))
acts = [a for s in pol["Statement"] for a in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])]
sys.exit(0 if not any("CreateNatGateway" in a for a in acts) else 1)
EOF

# --- Guard 2: ELB/ALB/NLB ---------------------------------------------------
assert_absent "g2:load-balancers" 'resource\s+"aws_(lb|alb|elb)[a-z_]*"' $TF_FILES
assert_absent "g2:iam-elb" 'elasticloadbalancing' "$POLICY"

# --- Guard 3: RDS -----------------------------------------------------------
assert_absent "g3:rds" 'resource\s+"aws_db[a-z_]*"\s|resource\s+"aws_rds[a-z_]*"' $TF_FILES
assert_absent "g3:iam-rds" '"rds:' "$POLICY"

# --- Guard 4: EKS -----------------------------------------------------------
assert_absent "g4:eks" 'resource\s+"aws_eks[a-z_]*"' $TF_FILES
assert_absent "g4:iam-eks" '"eks:' "$POLICY"

# --- Guard 5: paid Marketplace AMI -----------------------------------------
assert_present "g5:iam-deny-marketplace" '"Sid":\s*"DenyPaidMarketplaceImages"' "$POLICY"
assert_absent  "g5:no-product-code-filter" 'product-code' "$AWS_DIR/compute/main.tf"
assert_present "g5:ami-owner-pinned" 'owners\s*=\s*\[var\.ami_owner\]' "$AWS_DIR/compute/main.tf"

# --- Guard 6: Reserved Instances -------------------------------------------
python3 - "$POLICY" <<'EOF' && ok "g6:no-ri-purchase-actions" || bad "g6:no-ri-purchase-actions"
import json, sys
pol = json.load(open(sys.argv[1]))
blob = json.dumps(pol)
sys.exit(0 if "PurchaseReserved" not in blob and "PurchaseHostReservation" not in blob
          and "ReservedInstancesOffering" not in blob else 1)
EOF

# --- Guard 7: Savings Plans -------------------------------------------------
assert_absent "g7:savings-plans" 'savingsplans' "$POLICY"

# --- Guard 8: Elastic IP ----------------------------------------------------
assert_absent "g8:elastic-ip" 'resource\s+"aws_eip"' $TF_FILES
python3 - "$POLICY" <<'EOF' && ok "g8:iam-no-allocate-address" || bad "g8:iam-no-allocate-address"
import json, sys
pol = json.load(open(sys.argv[1]))
acts = [a for s in pol["Statement"] for a in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])]
sys.exit(0 if not any("AllocateAddress" in a for a in acts) else 1)
EOF

# --- Guard 9: Organizations --------------------------------------------------
assert_absent "g9:organizations" 'resource\s+"aws_organizations[a-z_]*"\s|resource\s+"aws_controltower[a-z_]*"' $TF_FILES
assert_absent "g9:iam-organizations" '"organizations:|"controltower:' "$POLICY"

# --- Guard 10: Control Tower (same boundary as 9) ---------------------------
# Match resource declarations and IAM action namespaces only — the word
# "controltower" in documentation prose is the rule being stated, not a use.
assert_absent "g10:controltower-resource" 'resource\s+"aws_controltower[a-z_]*"' $TF_FILES
assert_absent "g10:iam-controltower-actions" '"controltower:' "$POLICY"

# --- Guard 11: unknown instance type ----------------------------------------
for f in "$AWS_DIR/compute/variables.tf" "$LAB_ENV/variables.tf"; do
  if grep -q 'var.instance_type == "t3a.medium"' "$f"; then
    ok "g11:instance-type-allowlist ($f)"
  else
    bad "g11:instance-type-allowlist ($f): t3a.medium equality validation missing"
  fi
done
assert_present "g11:iam-instance-type-condition" '"ec2:InstanceType":\s*"t3a\.medium"' "$POLICY"

# --- Guard 12: non-Free-plan selection / unexpected graph expansion ----------
n_instances=$(grep -rEc 'resource\s+"aws_instance"' $AWS_DIR 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
if [ "$n_instances" -eq 1 ]; then ok "g12:exactly-one-aws_instance (count=$n_instances)"; else bad "g12:expected exactly 1 aws_instance, found $n_instances"; fi
assert_present "g12:credit-standard-pin" 'cpu_credits\s*=\s*"standard"' "$AWS_DIR/compute/main.tf"
assert_present "g12:imdsv2-required" 'http_tokens\s*=\s*"required"' "$AWS_DIR/compute/main.tf"
# IAM cannot flip an instance to "unlimited" CPU credits at runtime (the only
# surplus-billing escape): ModifyInstanceCreditSpecification must be absent
# (security t_76e3b6d1 — the HCL cpu_credits="standard" pin alone does not
# stop a principal with modify access from enabling Unlimited mode, where
# surplus credits bill $0.05/vCPU-hr).
python3 - "$POLICY" <<'EOF' && ok "g12:iam-no-unlimited-credit-flip" || bad "g12:iam-no-unlimited-credit-flip"
import json, sys
pol = json.load(open(sys.argv[1]))
blob = json.dumps(pol)
sys.exit(1 if "ModifyInstanceCreditSpecification" in blob else 0)
EOF

# --- Guard 13: unexpected EBS expansion --------------------------------------
assert_absent "g13:standalone-ebs-volume" 'resource\s+"aws_ebs_volume"' $TF_FILES
assert_present "g13:root-volume-size-20" 'volume_size\s*=\s*20' "$AWS_DIR/compute/main.tf"
assert_present "g13:delete-on-termination" 'delete_on_termination\s*=\s*true' "$AWS_DIR/compute/main.tf"

# --- Guard 14: unsupported region --------------------------------------------
assert_present "g14:region-pinned-us-east-2" 'var\.aws_region == "us-east-2"' "$LAB_ENV/variables.tf"
assert_absent  "g14:no-skip-region-validation" 'skip_region_validation\s*=\s*true' $TF_FILES

# --- Guard 15: missing human Free-plan confirmation (G2 gate exists) --------
GATE="OPNORY_AWS_FREE_PLAN_CONFIRMED"
if grep -q "$GATE" "$REPO/infra/repro-harness/scripts/preflight.py"; then
  ok "g15:free-plan-gate-in-preflight"
else
  bad "g15:free-plan-gate-in-preflight: $GATE not enforced"
fi
# Negative probe: live preflight without the gate must fail closed.
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
cat > "$TMPD/target.json" <<'EOF'
{"environment": "lab", "provider": "aws", "mutation_budget": 60,
 "state_identity": "s3:opnory-iac-state/lab.tfstate",
 "allowed_provider_account_hint": "x", "aws_free_plan_attestation": "human-confirmed-free-plan",
 "tofu Working directory": "infra/environments/lab"}
EOF
if env -u OPNORY_AWS_FREE_PLAN_CONFIRMED -u OPNORY_IAC_LIVE_AUTHORIZED \
  python3 "$REPO/infra/repro-harness/scripts/preflight.py" \
    --target "$TMPD/target.json" --mode live --steps plan >/dev/null 2>&1; then
  bad "g15:live-preflight-without-free-plan-gate must fail (rc 3)"
else
  ok "g15:live-preflight-without-free-plan-gate fails closed"
fi
# Agent-asserted value must NOT satisfy the gate: G1 set, wrong G2 value.
if OPNORY_IAC_PHASE=1B OPNORY_IAC_LIVE_AUTHORIZED=phase1b-two-cycle-lab \
  OPNORY_AWS_FREE_PLAN_CONFIRMED=agent-forged-value \
  python3 "$REPO/infra/repro-harness/scripts/preflight.py" \
    --target "$TMPD/target.json" --mode live --steps plan >/dev/null 2>&1; then
  bad "g15:agent-forged free-plan value must NOT pass the gate"
else
  ok "g15:agent-forged free-plan value rejected"
fi

# --- Guard 16 (security-added): destroy-path permissions regression ----------
python3 - "$POLICY" <<'EOF' && ok "g16:destroy-action-set-present" || bad "g16:destroy-action-set-present"
import json, sys
pol = json.load(open(sys.argv[1]))
blob = json.dumps(pol)
required = ["DeleteVpc", "DeleteSubnet", "DeleteInternetGateway", "DetachInternetGateway",
            "DeleteRouteTable", "DisassociateRouteTable", "DeleteRoute", "DeleteSecurityGroup",
            "DeleteKeyPair", "TerminateInstances"]
missing = [a for a in required if a not in blob]
sys.exit(0 if not missing else print(f"missing: {missing}", file=sys.stderr) or 1)
EOF

# --- Guard 17 (security t_76e3b6d1): provider read-path completeness ---------
# terraform-provider-aws v6.66.0 read-back chain, verified in provider source:
#   aws_key_pair create -> resourceKeyPairRead -> DescribeKeyPairs
#   aws_instance create -> Update -> Read -> Flatten ->
#       DescribeInstanceTypes (instance-type resolution, unconditional)
#       DescribeInstanceAttribute (DisableApiStop/DisableApiTermination)
#       DescribeInstanceCreditSpecifications (burstable types; already in list)
# A policy missing these fails the FIRST live apply at create read-back and
# every later refresh — fail-closed but unpassable. Pin them structurally so
# a future "unused action" trim cannot silently reintroduce the gap.
python3 - "$POLICY" <<'EOF' && ok "g17:provider-read-path-covered" || bad "g17:provider-read-path-covered"
import json, sys
pol = json.load(open(sys.argv[1]))
allows = []
for s in pol["Statement"]:
    if s.get("Effect") != "Allow":
        continue
    acts = s["Action"] if isinstance(s["Action"], list) else [s["Action"]]
    allows.extend(acts)
    if "ec2:CreateTags" in acts:
        res = s["Resource"] if isinstance(s["Resource"], list) else [s["Resource"]]
        if not any("security-group-rule/*" in r for r in res):
            # SG rule resources carry tags; tag-on-create is evaluated against
            # the security-group-rule resource-level CreateTags (AWS SAR).
            print("missing: security-group-rule/* in CreateTags resource set",
                  file=sys.stderr)
            sys.exit(1)
required_reads = ["ec2:DescribeKeyPairs", "ec2:DescribeInstanceTypes",
                 "ec2:DescribeInstanceAttribute", "ec2:DescribeInstanceCreditSpecifications"]
missing = [a for a in required_reads if a not in allows]
sys.exit(0 if not missing else print(f"missing: {missing}", file=sys.stderr) or 1)
EOF

# --- Policy-wide structural guards (IAM by-omission assertions) -------------
python3 - "$POLICY" <<'EOF' && ok "iam:no-admin-poweruser-purchase-billing" || bad "iam:no-admin-poweruser-purchase-billing"
import json, sys
pol = json.load(open(sys.argv[1]))
blob = json.dumps(pol)
# Forbidden ACTION namespaces/policies. Note: the literal value "aws-marketplace"
# (no colon) is the ec2:Owner condition VALUE in the DenyPaidMarketplaceImages
# statement — that is the guard itself, not a violation; only the
# aws-marketplace: ACTION namespace is forbidden.
forbidden = ["AdministratorAccess", "PowerUserAccess", '"iam:', '"aws-portal:', '"billing:',
             '"account:', '"support:', "consolidatebilling", "PurchaseCapacityBlock",
             "PurchaseScheduled", '"aws-marketplace:', '"dynamodb:', '"kms:', '"route53:',
             '"sns:', '"sqs:', '"ses:', '"cloudfront:']
hits = [f for f in forbidden if f in blob]
sys.exit(0 if not hits else print(f"forbidden: {hits}", file=sys.stderr) or 1)
EOF

# --- Negative fixture: a synthetic graph with a NAT gateway resource must ---
# --- FAIL the preflight graph-count guard (security design §9).            ---
NEGFIX="$TMPD/negfix"
mkdir -p "$NEGFIX/infra/providers/aws/compute" "$NEGFIX/infra/environments/lab" \
         "$NEGFIX/infra/repro-harness/scripts"
cp "$REPO/infra/repro-harness/scripts/preflight.py" "$NEGFIX/infra/repro-harness/scripts/"
cat > "$NEGFIX/infra/providers/aws/compute/main.tf" <<'EOF'
resource "aws_nat_gateway" "escape" { allocation_id = "x" }
EOF
cp "$REPO/infra/providers/aws/compute/variables.tf" "$NEGFIX/infra/providers/aws/compute/"
cat > "$NEGFIX/infra/environments/lab/variables.tf" <<'EOF'
variable "aws_region" { default = "us-east-2" }
EOF
cat > "$TMPD/negfix-target.json" <<'EOF'
{"environment": "lab", "provider": "aws", "mutation_budget": 60,
 "state_identity": "s3:opnory-iac-state/lab.tfstate",
 "aws_free_plan_attestation": "x",
 "tofu Working directory": "infra/environments/lab"}
EOF
# Run the graph-count check alone from the synthetic tree: the block count
# differs (and the escape resource would also fail guard 1) — either way the
# check must FAIL, proving unexpected expansion cannot pass silently.
NEGOUT="$(cd "$NEGFIX" && python3 - <<'PYEOF'
import sys
sys.path.insert(0, "infra/repro-harness/scripts")
import importlib.util
spec = importlib.util.spec_from_file_location("pf", "infra/repro-harness/scripts/preflight.py")
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)
config = {"provider": "aws"}
checks = pf.check_aws_resource_graph(config)
bad = [c for c in checks if not c.ok]
print("NEGFAIL" if bad else "NEGPASS")
PYEOF
)"
if [ "$NEGOUT" = "NEGFAIL" ]; then
  ok "negative-fixture: NAT-gateway expansion FAILS the graph-count guard"
else
  bad "negative-fixture: synthetic NAT gateway must fail the graph-count guard"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL FREE-PLAN ESCAPE GUARDS PASS"
else
  echo "FREE-PLAN ESCAPE GUARDS FAILED"
fi
exit $fail
