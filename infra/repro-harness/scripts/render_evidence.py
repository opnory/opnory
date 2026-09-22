#!/usr/bin/env python3
"""Validate an evidence document against the Phase 1 evidence schema.

Fails closed:
  - schema invalid -> exit 3
  - schema valid but contains forbidden material heuristics -> exit 3
  - overall_result PASS requires two PASS cycles and observed <= declared budget

Uses jsonschema if available; otherwise a minimal built-in validator for the
top-level required fields and the nested cycle shape (stdlib-only fallback).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schema" / "evidence.schema.json"

FORBIDDEN_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)client_secret[\"'\s:=]+[A-Za-z0-9_/-]{8,}"),
    re.compile(r"(?i)access[_-]?token[\"'\s:=]+[A-Za-z0-9_.-]{16,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),  # AWS access key id shape
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),  # Slack tokens
)

REQUIRED_STEPS = (
    "preflight", "plan", "apply", "cloud_init", "ansible_converge",
    "compose_up", "workload_health", "opnory_verification",
    "post_apply_drift", "ansible_idempotence", "destroy",
    "post_destroy_residue",
)


def _scan_forbidden(doc: dict) -> list[str]:
    blob = json.dumps(doc)
    return [p.pattern for p in FORBIDDEN_PATTERNS if p.search(blob)]


def _minimal_validate(doc: dict, errors: list[str]) -> None:
    for key in ("schema_version", "generated_at", "generator", "commit_sha",
                "tool_versions", "provider", "environment",
                "terraform_state_identity", "cycles", "overall_result"):
        if key not in doc:
            errors.append(f"missing required field: {key}")
    if doc.get("environment") not in (None, "lab"):
        errors.append("environment must be 'lab'")
    if doc.get("overall_result") not in (None, "PASS", "FAIL", "ABORTED", "DRY_RUN"):
        errors.append("overall_result invalid")
    for i, cycle in enumerate(doc.get("cycles", [])):
        for step in REQUIRED_STEPS:
            if step not in cycle:
                errors.append(f"cycle {i + 1}: missing step {step}")
            elif cycle[step].get("status") not in (
                    "pass", "fail", "skipped", "dry_run_planned"):
                errors.append(f"cycle {i + 1} step {step}: invalid status")
        if cycle.get("cycle_result") not in ("PASS", "FAIL", "ABORTED", "DRY_RUN"):
            errors.append(f"cycle {i + 1}: invalid cycle_result")


def _semantic_assert(doc: dict, errors: list[str]) -> None:
    if doc.get("overall_result") == "PASS":
        cycles = doc.get("cycles", [])
        if len(cycles) != 2 or not all(c.get("cycle_result") == "PASS" for c in cycles):
            errors.append("overall_result=PASS requires exactly two PASS cycles")
        budget = doc.get("mutation_budget", {})
        if budget.get("observed", 0) > budget.get("declared", -1):
            errors.append("overall_result=PASS but mutation budget exceeded")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", help="Path to evidence JSON")
    args = parser.parse_args(argv)

    errors: list[str] = []
    try:
        doc = json.loads(Path(args.evidence).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot parse evidence: {exc}", file=sys.stderr)
        return 3

    schema = json.loads(SCHEMA_PATH.read_text())
    try:
        import jsonschema  # type: ignore
        jsonschema.validate(doc, schema)
    except ImportError:
        _minimal_validate(doc, errors)
    except Exception as exc:  # jsonschema.ValidationError
        errors.append(f"schema: {getattr(exc, 'message', str(exc))}")

    for pattern in _scan_forbidden(doc):
        errors.append(f"forbidden material pattern present: {pattern!r}")

    _semantic_assert(doc, errors)

    if errors:
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        return 3
    print(f"evidence VALID: {args.evidence} overall={doc.get('overall_result')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
