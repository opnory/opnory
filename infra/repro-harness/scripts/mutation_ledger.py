#!/usr/bin/env python3
"""Append-only mutation ledger for the Opnory IaC reproducibility harness.

Every lifecycle step that can create/modify/delete provider resources records
one JSON line here. The ledger is the accounting source for the Phase 1B
mutation budget: observed mutations are compared against the declared budget
and any overflow fails the run.

Ledger entries contain ONLY sanitized facts: step name, action type, count,
timestamp. No resource IDs that encode account/project identifiers, no
addresses beyond the lab host, no credentials of any kind.

Usage:
  mutation_ledger.py --ledger PATH init --cycle N --commit SHA
  mutation_ledger.py --ledger PATH record --cycle N --step STEP --action {create,update,delete,noop} --count K
  mutation_ledger.py --ledger PATH totals
  mutation_ledger.py --ledger PATH assert-budget --budget N
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ACTIONS = ("create", "update", "delete", "noop")
LEDGER_VERSION = 1


def _append(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"corrupt ledger line {lineno} in {path}: {exc}")
    return out


def cmd_init(args: argparse.Namespace) -> int:
    path = Path(args.ledger)
    if path.exists() and path.stat().st_size > 0 and not args.force:
        print(f"ledger {path} already exists; refusing to reinitialize without --force",
              file=sys.stderr)
        return 3
    if args.force and path.exists():
        path.unlink()
    _append(path, {
        "ledger_version": LEDGER_VERSION,
        "event": "init",
        "cycle": args.cycle,
        "commit_sha": args.commit,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    if not 0 <= args.count <= 1000:
        print(f"unreasonable mutation count {args.count}; refusing", file=sys.stderr)
        return 3
    _append(Path(args.ledger), {
        "event": "mutation",
        "cycle": args.cycle,
        "step": args.step,
        "action": args.action,
        "count": args.count,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    return 0


def _totals(entries: list[dict]) -> dict:
    totals: dict[str, int] = {a: 0 for a in ACTIONS}
    for e in entries:
        if e.get("event") == "mutation":
            totals[e["action"]] = totals.get(e["action"], 0) + e["count"]
    totals["observed"] = totals["create"] + totals["update"] + totals["delete"]
    return totals


def cmd_totals(args: argparse.Namespace) -> int:
    print(json.dumps(_totals(_read(Path(args.ledger))), indent=2, sort_keys=True))
    return 0


def cmd_assert_budget(args: argparse.Namespace) -> int:
    totals = _totals(_read(Path(args.ledger)))
    observed = totals["observed"]
    print(f"mutation budget: declared={args.budget} observed={observed}")
    if observed > args.budget:
        print("MUTATION BUDGET EXCEEDED — failing closed", file=sys.stderr)
        return 3
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", required=True)
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("--cycle", type=int, required=True)
    p_init.add_argument("--commit", required=True)
    p_init.add_argument("--force", action="store_true")

    p_rec = sub.add_parser("record")
    p_rec.add_argument("--cycle", type=int, required=True)
    p_rec.add_argument("--step", required=True)
    p_rec.add_argument("--action", choices=ACTIONS, required=True)
    p_rec.add_argument("--count", type=int, required=True)

    sub.add_parser("totals")

    p_budget = sub.add_parser("assert-budget")
    p_budget.add_argument("--budget", type=int, required=True)

    args = parser.parse_args(argv)
    return {
        "init": cmd_init,
        "record": cmd_record,
        "totals": cmd_totals,
        "assert-budget": cmd_assert_budget,
    }[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
