#!/usr/bin/env python3
"""Validate that a provider stack's `tofu output -json` satisfies the
host-contract, and contains no forbidden sensitive outputs.

Usage: validate_contract.py <outputs.json>

Exit 0 on pass; exit 1 with reasons on stderr on failure.
"""
import json
import re
import sys

REQUIRED = {
    "host_address": str,
    "private_address": str,
    "dns_name": str,
    "environment": str,
}
OPTIONAL = {
    "storage_ref": str,
}
ALLOWED = set(REQUIRED) | set(OPTIONAL)

# Patterns that suggest a value is a credential / secret rather than an address.
FORBIDDEN_KEY = re.compile(
    r"(password|passwd|secret|token|private.?key|credential|conn(ection)?.?string|"
    r"database_url|postgres|dsn|access.?key)",
    re.IGNORECASE,
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_contract.py <outputs.json>", file=sys.stderr)
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        raw = json.load(fh)

    # `tofu output -json` shape: {name: {value, type, sensitive}}
    names = set(raw)
    errors: list[str] = []

    for name, typ in REQUIRED.items():
        if name not in names:
            errors.append(f"missing required output: {name}")
        elif not isinstance(raw[name].get("value"), typ):
            errors.append(f"output {name} value is not a string")
    for name in OPTIONAL:
        if name in names and not isinstance(raw[name].get("value"), OPTIONAL[name]):
            errors.append(f"output {name} value is not a string")

    unexpected = names - ALLOWED
    for n in sorted(unexpected):
        if FORBIDDEN_KEY.search(n):
            errors.append(
                f"output {n!r} looks like a credential/secret and is forbidden "
                "as an infrastructure output (ADR 0012 §3)"
            )
        else:
            errors.append(
                f"output {n!r} is outside the host-contract; providers must "
                "expose only the contract keys"
            )

    env_v = raw.get("environment", {}).get("value")
    if env_v is not None and env_v not in {"lab", "staging", "production"}:
        errors.append(f"environment must be lab|staging|production, got {env_v!r}")

    # Any output flagged sensitive=true in the contract set is a smell: publish
    # non-secret addresses only.
    for n in names & ALLOWED:
        if raw[n].get("sensitive"):
            errors.append(f"output {n!r} is marked sensitive; contract outputs are non-secret")

    if errors:
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print("host-contract: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
