#!/usr/bin/env python3
"""Render the lab Ansible inventory from `tofu output -json` on stdin.

Consumes exactly the host-contract outputs (see
infra/modules/host-contract/README.md) and validates them with the same rules
as validate_contract.py before emitting. Fails closed on any contract
violation — an inventory rendered from a secret-leaking stack must not exist.
"""
import json
import sys

REQUIRED = ["host_address", "private_address", "dns_name", "environment"]
ALLOWED = set(REQUIRED) | {"storage_ref"}


def main() -> int:
    raw = json.load(sys.stdin)
    names = set(raw)
    for r in REQUIRED:
        if r not in names:
            print(f"FAIL: missing required output {r!r}", file=sys.stderr)
            return 1
        if not isinstance(raw[r].get("value"), str):
            print(f"FAIL: output {r!r} is not a string", file=sys.stderr)
            return 1
    extra = names - ALLOWED
    if extra:
        print(
            f"FAIL: outputs outside host-contract present: {sorted(extra)}",
            file=sys.stderr,
        )
        return 1

    host = {
        "ansible_host": raw["host_address"]["value"],
        "ansible_user": "opnory",
        "private_address": raw["private_address"]["value"],
        "dns_name": raw["dns_name"]["value"],
        "environment": raw["environment"]["value"],
    }
    if "storage_ref" in raw:
        host["storage_ref"] = raw["storage_ref"]["value"]

    inv = {"opnory_lab": {"hosts": {raw["dns_name"]["value"]: host}}}
    json.dump(inv, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
