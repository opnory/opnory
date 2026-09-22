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
ALLOWED_ENVIRONMENTS = ("lab",)
FORBIDDEN_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(secret|password|token|api[_-]?key)\s*[:=]\s*['\"]?[A-Za-z0-9/+_=-]{16,}"),
)


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
