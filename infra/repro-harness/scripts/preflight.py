#!/usr/bin/env python3
"""Fail-closed preflight checks for the Opnory IaC reproducibility harness.

Exit contract:
  0 = all checks pass; the harness MAY proceed to the requested mode.
  3 = one or more checks failed; the harness MUST NOT proceed.

This script never performs provider mutation. It reads configuration, the
environment, and the repository only.

Every check is fail-closed: missing tools, missing config, unrecognized
environment, missing live-authorization, or any doubt about state isolation
is a failure, never a warning-by-default.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

LIVE_AUTHORIZATION_ENV = "OPNORY_IAC_LIVE_AUTHORIZED"
LIVE_AUTHORIZATION_VALUE = "phase1b-two-cycle-lab"
# G2 (security design §7): human Free-plan confirmation gate. The value is a
# human-typed attestation recorded in the uncommitted target file; the agent
# and CI may never set it. The env var must equal the target attestation.
AWS_FREE_PLAN_ENV = "OPNORY_AWS_FREE_PLAN_CONFIRMED"
ALLOWED_ENVIRONMENTS = ("lab",)
# Explicit, fail-closed lab region (guard 14) and instance type (guard 11).
AWS_LAB_REGION = "us-east-2"
AWS_LAB_INSTANCE_TYPE = "t3a.medium"
# Corrected mutation arithmetic (security F2): 13 AWS + 1 Cloudflare =
# 14 resource blocks per cycle; two cycles of create+delete = 56 <= 60.
AWS_EXPECTED_GRAPH_BLOCKS = 14
FORBIDDEN_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(secret|password|token|api[_-]?key)\s*[:=]\s*['\"]?[A-Za-z0-9/+_=-]{16,}"),
)
# Provider-keyed resource-block regexes (was: hard-coded hcloud_). The
# selected provider's own prefix is used; the Hetzner path keeps working
# with its original semantics (its executor stays blocked).
PROVIDER_RESOURCE_PREFIXES = {
    "aws": re.compile(r"aws_[a-z0-9_]+"),
    "hetzner": re.compile(r"hcloud_[a-z_]+"),
}


class Check:
    def __init__(self, name: str, ok: bool, detail: str = "") -> None:
        self.name = name
        self.ok = ok
        self.detail = detail

    def line(self) -> str:
        mark = "PASS" if self.ok else "FAIL"
        suffix = f" -- {self.detail}" if self.detail else ""
        return f"[{mark}] {self.name}{suffix}"


def _run(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, (proc.stdout + proc.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, str(exc)


def check_required_tools(mode: str) -> list[Check]:
    checks: list[Check] = []
    # Python is us. Everything else is probed.
    for tool in ("git",):
        checks.append(Check(f"tool:{tool}", shutil.which(tool) is not None,
                            shutil.which(tool) or "not found on PATH"))
    # tofu/ansible/docker are only required when the mode would invoke them.
    needs_all = mode in ("live",)
    for tool in ("tofu", "ansible-playbook", "docker"):
        found = shutil.which(tool) is not None
        if needs_all:
            checks.append(Check(f"tool:{tool}", found, shutil.which(tool) or "not found on PATH"))
        else:
            checks.append(Check(f"tool:{tool} (advisory, not required in {mode} mode)",
                                True, shutil.which(tool) or "absent; dry-run/static modes only"))
    return checks


def check_target_config(target_path: Path) -> tuple[list[Check], dict | None]:
    checks: list[Check] = []
    if not target_path.exists():
        return [Check("target:exists", False, f"{target_path} does not exist")], None
    try:
        config = json.loads(target_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return [Check("target:parse", False, f"cannot parse {target_path}: {exc}")], None

    checks.append(Check("target:parse", True))

    env = config.get("environment")
    checks.append(Check(
        "target:environment",
        env in ALLOWED_ENVIRONMENTS,
        f"environment={env!r}; allowed={list(ALLOWED_ENVIRONMENTS)}. Refusing anything but the disposable lab.",
    ))

    repo_root = Path(__file__).resolve().parents[3]
    provider = config.get("provider", "")
    provider_dir = repo_root / "infra" / "providers" / provider
    if provider_dir.is_dir():
        checks.append(Check("target:provider-implementation", True,
                            f"infra/providers/{provider} exists"))
    else:
        checks.append(Check("target:provider-implementation", False,
                            f"infra/providers/{provider} not found -- provider selection is unresolved. "
                            "Live execution is BLOCKED until exactly one provider implementation exists."))

    tofu_dir = config.get("tofu Working directory") or config.get("tofu_working_directory")
    tf_path = (repo_root / tofu_dir) if tofu_dir else None
    checks.append(Check("target:tofu-dir",
                        bool(tf_path and tf_path.is_dir()),
                        str(tf_path) if tf_path else "missing tofu working directory key"))

    mutation_budget = config.get("mutation_budget")
    checks.append(Check("target:mutation-budget",
                        isinstance(mutation_budget, int) and 0 < mutation_budget <= 200,
                        f"mutation_budget={mutation_budget!r}"))

    state_identity = config.get("state_identity", "")
    looks_secret = any(p.search(state_identity) for p in FORBIDDEN_SECRET_PATTERNS)
    checks.append(Check("target:state-identity-nonsecret",
                        bool(state_identity) and not looks_secret,
                        "state_identity must be a non-secret workspace identifier"))

    example_path = Path(__file__).resolve().parents[1] / "config" / "lab.target.example.json"
    try:
        same = target_path.resolve() == example_path.resolve()
    except OSError:
        same = False
    checks.append(Check("target:not-the-example-file", not same,
                        "the committed example target must never be used for a real run"))

    return checks, config


def check_lab_label_assertion(config: dict) -> list[Check]:
    """Verifier gap G2: every provider resource in infra/providers/<name>/ must
    carry the lab-only label set. Static source scan (fail-closed).
    Provider-keyed as of Phase 1B-COST-SAFETY: the resource regex comes from
    PROVIDER_RESOURCE_PREFIXES; unknown providers fail closed on the
    provider-implementation check above."""
    checks: list[Check] = []
    repo_root = Path(__file__).resolve().parents[3]
    provider = config.get("provider", "")
    if not provider:
        return checks
    provider_dir = repo_root / "infra" / "providers" / provider
    if not provider_dir.is_dir():
        return checks
    prefix_re = PROVIDER_RESOURCE_PREFIXES.get(provider)
    if prefix_re is None:
        checks.append(Check(
            "target:lab-labels-assertion", False,
            f"no resource-prefix mapping for provider {provider!r}; refusing",
        ))
        return checks
    offenders: list[str] = []
    required_labels = (
        re.compile(r'environment\s*=\s*"lab"'),
        re.compile(r'managed-by\s*=\s*"opnory-iac"'),
        re.compile(r'swarm\s*=\s*"iac-1b"'),
    )
    resource_blocks = re.compile(
        r'resource\s+"' + prefix_re.pattern + r'"\s+"([^"]+)"'
    )
    for tf_path in sorted(provider_dir.rglob("*.tf")):
        text = tf_path.read_text(encoding="utf-8")
        for match in resource_blocks.finditer(text):
            # Locate the end of this resource block (best-effort brace match).
            start = match.end()
            depth = 0
            idx = start
            while idx < len(text):
                ch = text[idx]
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        break
                idx += 1
            body = text[start:idx]
            # A resource satisfies the assertion when it references the
            # shared local.labels (which declares the lab set) OR embeds the
            # three lab labels directly.
            uses_shared = "local.labels" in body or "local.labels" in text
            direct = all(p.search(body) for p in required_labels)
            if not (uses_shared or direct):
                offenders.append(
                    f"{tf_path.relative_to(repo_root)}: resource {match.group(1)}.{match.group(2)} missing lab labels"
                )
    checks.append(Check(
        "target:lab-labels-assertion",
        not offenders,
        "; ".join(offenders) if offenders else
        f"infra/providers/{provider} resources carry lab-only labels",
    ))
    return checks


def check_state_isolation(config: dict) -> list[Check]:
    """No committed state/plan artifacts; backend must not be local for live."""
    checks: list[Check] = []
    repo_root = Path(__file__).resolve().parents[3]
    infra = repo_root / "infra"
    offenders = []
    if infra.is_dir():
        for pattern in ("*.tfstate", "*.tfstate.backup", "*.tfplan", "terraform.tfstate.d"):
            offenders.extend(str(p.relative_to(repo_root)) for p in infra.rglob(pattern))
    checks.append(Check("repo:no-committed-state-or-plan", not offenders,
                        "; ".join(offenders) if offenders else "no .tfstate/.tfplan under infra/"))
    return checks


def check_live_authorization(mode: str) -> list[Check]:
    if mode != "live":
        return []
    value = os.environ.get(LIVE_AUTHORIZATION_ENV, "")
    return [Check(
        f"live:human-authorization ({LIVE_AUTHORIZATION_ENV})",
        value == LIVE_AUTHORIZATION_VALUE,
        "Phase 1B live apply/destroy requires an explicit human-set env var "
        f"{LIVE_AUTHORIZATION_ENV}={LIVE_AUTHORIZATION_VALUE!r}. "
        "Unset or wrong value fails closed. This is the human authorization boundary.",
    )]


def check_phase1a_apply_destroy_block(mode: str, steps: list[str]) -> list[Check]:
    """In Phase 1A, apply/destroy must never run regardless of authorization."""
    phase = os.environ.get("OPNORY_IAC_PHASE", "1A")
    dangerous = [s for s in steps if s in ("apply", "destroy")]
    if phase == "1A" and dangerous and mode == "live":
        return [Check(
            "phase1a:apply-destroy-prohibited",
            False,
            f"OPNORY_IAC_PHASE={phase}: steps {dangerous} are prohibited in Phase 1A even with "
            "live authorization. Set OPNORY_IAC_PHASE=1B only as part of the gated Phase 1B run.",
        )]
    return [Check("phase1a:apply-destroy-prohibited", True,
                  f"OPNORY_IAC_PHASE={phase}; mode={mode}")]


# ---------------------------------------------------------------------------
# AWS provider extension (Phase 1B-COST-SAFETY) — the 15 preflight checks.
# Numbering follows the task's PREFLIGHT section; security design §10.
# Static mode validates configuration shapes; live mode adds read-only
# probes. Nothing here mutates anything, and sensitive values (account ids)
# are only ever compared as sha256[:12] and never printed.
# ---------------------------------------------------------------------------

def _aws_sts_caller_identity() -> dict | None:
    """Read-only sts:GetCallerIdentity via the aws CLI. Returns a dict with
    account/arn/user keys or None. Never prints; result is used for
    comparison only and never rendered into evidence."""
    rc, out = _run(["aws", "sts", "get-caller-identity", "--output", "json"],
                   timeout=30)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _account_id_hash12(account_id: str) -> str:
    """sha256(12-digit account id)[:12] — the only identity form ever
    compared or displayed. The raw account id never enters evidence (F8)."""
    import hashlib
    return hashlib.sha256(account_id.encode("utf-8")).hexdigest()[:12]


def check_aws_free_plan_gate(mode: str, config: dict) -> list[Check]:
    """Check 2 (G2): human Free-plan confirmation. The env var must be set by
    the human operator and must equal the attestation recorded in the
    uncommitted target file. The agent may never synthesize this value."""
    if config.get("provider") != "aws":
        return []
    checks: list[Check] = []
    attestation = str(config.get("aws_free_plan_attestation", "")).strip()
    env_value = os.environ.get(AWS_FREE_PLAN_ENV, "")
    if mode != "live":
        checks.append(Check(
            "aws:free-plan-attestation-configured",
            bool(attestation),
            "target file carries aws_free_plan_attestation (required for the "
            "G2 human gate at live time)",
        ))
        return checks
    ok = bool(attestation) and env_value == attestation
    checks.append(Check(
        f"aws:human-free-plan-confirmation ({AWS_FREE_PLAN_ENV})",
        ok,
        "live execution requires the human operator to export "
        f"{AWS_FREE_PLAN_ENV} equal to the target-file attestation. "
        "Unset, agent-set, or mismatched values fail closed. Account-plan "
        "status is HUMAN evidence; it is never inferred from credentials "
        "working.",
    ))
    return checks


def check_aws_credentials(mode: str) -> list[Check]:
    """Checks 3+4 (live only): AWS credentials present and NOT root."""
    checks: list[Check] = []
    if mode != "live":
        return checks
    has_static = bool(os.environ.get("AWS_ACCESS_KEY_ID"))
    has_profile = bool(os.environ.get("AWS_PROFILE"))
    checks.append(Check(
        "aws:credentials-present",
        has_static or has_profile,
        "AWS credentials must resolve from the standard env chain "
        "(AWS_ACCESS_KEY_ID or AWS_PROFILE); root access keys must never "
        "be created",
    ))
    identity = _aws_sts_caller_identity()
    checks.append(Check(
        "aws:credentials-not-root",
        identity is not None and ":root" not in str(identity.get("Arn", "")),
        "sts:GetCallerIdentity Arn must NOT be the account root user; "
        "Terraform/OpenTofu must never run with root credentials",
    ))
    return checks


def check_aws_identity(mode: str, config: dict) -> list[Check]:
    """Check 5 (live only): expected account identity. Compares
    sha256(account)[:12] of the live sts account id against the target's
    allowed_provider_account_hint. The raw id never appears anywhere (F8)."""
    if config.get("provider") != "aws" or mode != "live":
        return []
    hint = str(config.get("allowed_provider_account_hint", "")).strip()
    identity = _aws_sts_caller_identity()
    checks: list[Check] = []
    if identity is None or not hint:
        checks.append(Check(
            "aws:expected-account-identity",
            False,
            "cannot verify AWS account identity (sts unavailable or target "
            "hint missing); failing closed",
        ))
        return checks
    account = str(identity.get("Account", ""))
    matched = bool(re.fullmatch(r"[0-9]{12}", account)) and \
        _account_id_hash12(account) == hint
    checks.append(Check(
        "aws:expected-account-identity",
        matched,
        "sha256(account)[:12] compared to the target hint; the raw account "
        "id is never printed, logged, or written to evidence",
    ))
    return checks


def check_aws_region_and_instance(config: dict) -> list[Check]:
    """Checks 6+7 (static): region pinned to us-east-2 and instance type to
    t3a.medium in the lab variables; provider block must not skip region
    validation. Live mode additionally asserts the env agrees (check 6)."""
    if config.get("provider") != "aws":
        return []
    checks: list[Check] = []
    repo_root = Path(__file__).resolve().parents[3]
    lab_vars = repo_root / "infra" / "environments" / "lab" / "variables.tf"
    text = lab_vars.read_text(encoding="utf-8") if lab_vars.exists() else ""
    checks.append(Check(
        "aws:region-pinned",
        f'var.aws_region == "{AWS_LAB_REGION}"' in text.replace("  ", " ")
        or f'== "{AWS_LAB_REGION}"' in text,
        f"lab region must be exactly {AWS_LAB_REGION} (guard 14)",
    ))
    checks.append(Check(
        "aws:instance-type-allowed",
        f'var.instance_type == "{AWS_LAB_INSTANCE_TYPE}"' in text.replace("  ", " "),
        f"instance_type allow-list must be exactly {AWS_LAB_INSTANCE_TYPE} "
        "(guard 11)",
    ))
    # skip_region_validation must never be set true anywhere in the lab root.
    versions = repo_root / "infra" / "environments" / "lab" / "versions.tf"
    vtext = versions.read_text(encoding="utf-8") if versions.exists() else ""
    checks.append(Check(
        "aws:no-region-validation-skip",
        "skip_region_validation = false" in vtext,
        "provider config must keep skip_region_validation = false",
    ))
    return checks


def check_aws_ami_source(config: dict) -> list[Check]:
    """Check 8 (static): the AMI data source must pin owners to a tfvar with
    no default, use the Ubuntu Noble amd64 name filter, and must not filter
    by product codes (paid marketplace escape)."""
    if config.get("provider") != "aws":
        return []
    repo_root = Path(__file__).resolve().parents[3]
    compute_main = repo_root / "infra" / "providers" / "aws" / "compute" / "main.tf"
    compute_vars = repo_root / "infra" / "providers" / "aws" / "compute" / "variables.tf"
    checks: list[Check] = []
    if not compute_main.exists() or not compute_vars.exists():
        checks.append(Check("aws:ami-source-shape", False,
                            "infra/providers/aws/compute/ stack files missing"))
        return checks
    text = compute_main.read_text(encoding="utf-8")
    vars_text = compute_vars.read_text(encoding="utf-8")
    owners_pinned = re.search(r"owners\s*=\s*\[var\.ami_owner\]", text)
    name_filter = re.search(r'"ubuntu-noble-24\.04-\*amd64-server\*"', text)
    # ami_owner variable block must carry NO default assignment (fail closed
    # on unset). Match the assignment shape only — prose mentioning the word
    # "default" (e.g. "NO default:") must not trip this.
    var_block = re.search(r'variable "ami_owner"[\s\S]*?(?=\nvariable |\Z)',
                          vars_text)
    owner_no_default = bool(var_block) and not re.search(
        r'^\s*default\s*=', var_block.group(0), re.MULTILINE)
    no_product_code = "product-code" not in text
    checks.append(Check(
        "aws:ami-source-shape",
        bool(owners_pinned and name_filter and owner_no_default and no_product_code),
        "AMI data source: owners pinned to var.ami_owner (no default), "
        "Noble 24.04 amd64 name filter, no product-code filter",
    ))
    return checks


def check_aws_resource_graph(config: dict) -> list[Check]:
    """Check 9 (static): the AWS graph must be EXACTLY the approved 14-block
    set per cycle (13 AWS + 1 Cloudflare; security F2 correction). Any
    expansion fails closed before plan."""
    if config.get("provider") != "aws":
        return []
    repo_root = Path(__file__).resolve().parents[3]
    checks: list[Check] = []
    blocks: list[tuple[str, str]] = []
    prefixes = PROVIDER_RESOURCE_PREFIXES["aws"].pattern + \
        r"|cloudflare_[a-z0-9_]+"
    resource_re = re.compile(r'resource\s+"(' + prefixes + r')"\s+"([^"]+)"')
    scan_dirs = [
        repo_root / "infra" / "providers" / "aws",
        repo_root / "infra" / "environments" / "lab",
    ]
    for scan_dir in scan_dirs:
        if not scan_dir.is_dir():
            continue
        for tf_path in sorted(scan_dir.rglob("*.tf")):
            text = tf_path.read_text(encoding="utf-8")
            for m in resource_re.finditer(text):
                blocks.append((m.group(1), m.group(2)))
    count = len(blocks)
    expected = AWS_EXPECTED_GRAPH_BLOCKS
    # Exactly one aws_instance block (guard 12: unexpected additional instance)
    n_instances = sum(1 for t, _ in blocks if t == "aws_instance")
    checks.append(Check(
        "aws:resource-graph-count",
        count == expected and n_instances == 1,
        f"graph blocks={count} expected={expected} (13 AWS + 1 Cloudflare; "
        f"aws_instance blocks={n_instances}, expected 1). Any expansion "
        "fails closed (guards 1-4, 8-13).",
    ))
    return checks


def check_aws_state_backend(config: dict) -> list[Check]:
    """Check 10 (static): backend s3 block present with the lockfile-enabled
    shape; no credentials may appear in backend-config args (F7)."""
    if config.get("provider") != "aws":
        return []
    repo_root = Path(__file__).resolve().parents[3]
    versions = repo_root / "infra" / "environments" / "lab" / "versions.tf"
    text = versions.read_text(encoding="utf-8") if versions.exists() else ""
    checks: list[Check] = []
    checks.append(Check(
        "aws:s3-backend-config",
        'backend "s3" {}' in text and "use_lockfile" in text,
        'backend "s3" declared with use_lockfile=true init args; '
        "credentials come from the env chain only",
    ))
    checks.append(Check(
        "aws:backend-no-credentials",
        not re.search(r'^\s*-backend-config="[^"]*(access_key|secret_key)',
                      text, re.MULTILINE),
        "no access_key/secret_key in backend-config args (F7: env chain only)",
    ))
    return checks


def check_aws_cloudflare_credentials(mode: str) -> list[Check]:
    """Check 11 (live only): Cloudflare token present (Cloudflare stays
    authoritative DNS)."""
    if mode != "live":
        return []
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    return [Check(
        "aws:cloudflare-credentials-present",
        bool(token),
        "CLOUDFLARE_API_TOKEN must be present; Cloudflare remains the "
        "authoritative DNS (Zone.DNS-Edit on opnory.com only)",
    )]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="Path to lab target JSON config")
    parser.add_argument("--mode", choices=("dry-run", "static", "live"), default="dry-run")
    parser.add_argument("--steps", default="",
                        help="Comma-separated lifecycle steps the caller intends to run")
    args = parser.parse_args(argv)

    steps = [s.strip() for s in args.steps.split(",") if s.strip()]
    checks: list[Check] = []
    checks.extend(check_required_tools(args.mode))
    target_checks, config = check_target_config(Path(args.target))
    checks.extend(target_checks)
    if config is not None:
        checks.extend(check_state_isolation(config))
        checks.extend(check_lab_label_assertion(config))
        # --- AWS extension (Phase 1B-COST-SAFETY, checks 2, 5-10) ---
        checks.extend(check_aws_free_plan_gate(args.mode, config))
        checks.extend(check_aws_identity(args.mode, config))
        checks.extend(check_aws_region_and_instance(config))
        checks.extend(check_aws_ami_source(config))
        checks.extend(check_aws_resource_graph(config))
        checks.extend(check_aws_state_backend(config))
    # --- AWS extension (checks 3, 4, 11 — live-mode probes) ---
    if config is not None and config.get("provider") == "aws":
        checks.extend(check_aws_credentials(args.mode))
        checks.extend(check_aws_cloudflare_credentials(args.mode))
    checks.extend(check_live_authorization(args.mode))
    checks.extend(check_phase1a_apply_destroy_block(args.mode, steps))

    for check in checks:
        print(check.line())
    failures = [c for c in checks if not c.ok]
    print(f"\npreflight: {len(checks) - len(failures)}/{len(checks)} checks passed")
    if failures:
        print("preflight FAILED -- fail-closed; do not proceed", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
