#!/usr/bin/env python3
"""Deterministic Phase 1 lifecycle / destructive-test orchestrator.

Implements the acceptance sequence from the swarm goal:

  empty environment
    -> tofu plan
    -> tofu apply
    -> cloud-init completes
    -> ansible-playbook site.yml (converge)
    -> docker compose up
    -> workload health probe
    -> Opnory verification PASS
    -> tofu plan (post-apply drift: no unexplained changes)
    -> ansible-playbook site.yml (idempotence: second run, no changes)
    -> tofu destroy
    -> post-destroy residue check (zero residue)
    -> repeat entire sequence from zero (cycle 2)
    -> PASS

Modes:
  --mode dry-run  (DEFAULT) Every step is described, none executed. Suitable
                  for CI and for Phase 1A verification of the harness itself.
  --mode static   Runs only the non-mutating validations: preflight, tofu
                  fmt/validate (backend disabled), ansible syntax-check,
                  docker compose config. Mutating steps recorded as skipped.
  --mode live     Full real lifecycle. REFUSES apply/destroy while
                  OPNORY_IAC_PHASE=1A. In Phase 1B additionally requires the
                  human authorization env var enforced by preflight.py.

This script never embeds provider logic. Provider operations happen by
invoking tofu/ansible/docker in the working directories named by the target
config. Fail-closed: any step failing aborts the cycle with result ABORTED;
evidence is rendered regardless so the failure is auditable.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[3]
LEDGER = HERE / "mutation_ledger.py"
PREFLIGHT = HERE / "preflight.py"

STEPS = [
    "preflight",
    "plan",
    "apply",
    "cloud_init",
    "ansible_converge",
    "compose_up",
    "workload_health",
    "opnory_verification",
    "post_apply_drift",
    "ansible_idempotence",
    "destroy",
    "post_destroy_residue",
]


class StepResult:
    def __init__(self, status: str, detail: str = "", duration: float = 0.0,
                 mutations: int = 0) -> None:
        self.status = status  # pass | fail | skipped | dry_run_planned
        self.detail = detail
        self.duration = round(duration, 3)
        self.mutations = mutations

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "detail": self.detail,
            "duration_seconds": self.duration,
            "mutations": self.mutations,
        }


class Context:
    def __init__(self, args: argparse.Namespace, config: dict) -> None:
        self.args = args
        self.config = config
        self.ledger_path = Path(args.ledger)
        self.tofu_dir = REPO_ROOT / (config.get("tofu Working directory")
                                     or config.get("tofu_working_directory", ""))

    def run(self, cmd: list[str], cwd: Path | None = None, timeout: int = 600) -> tuple[int, str]:
        try:
            proc = subprocess.run(
                cmd, cwd=str(cwd) if cwd else None,
                capture_output=True, text=True, timeout=timeout,
            )
            return proc.returncode, (proc.stdout + proc.stderr).strip()[:2000]
        except (OSError, subprocess.TimeoutExpired) as exc:
            return 127, str(exc)

    def ledger(self, *ledger_args: str) -> tuple[int, str]:
        return self.run([sys.executable, str(LEDGER), "--ledger",
                         str(self.ledger_path), *ledger_args])


def dry(step: str) -> StepResult:
    return StepResult("dry_run_planned",
                      f"{step}: real command defined; not executed in this mode")


def step_plan(ctx: Context) -> StepResult:
    if ctx.args.mode == "dry-run":
        return dry("plan")
    t0 = time.monotonic()
    if ctx.args.mode == "static":
        if not ctx.tofu_dir.is_dir():
            return StepResult("skipped", f"{ctx.tofu_dir} not present yet")
        rc1, out1 = ctx.run(["tofu", "init", "-backend=false", "-input=false"],
                            cwd=ctx.tofu_dir)
        if rc1 != 0:
            return StepResult("fail", "tofu init -backend=false failed",
                              time.monotonic() - t0)
        rc2, _ = ctx.run(["tofu", "validate", "-no-color"], cwd=ctx.tofu_dir)
        return StepResult("pass" if rc2 == 0 else "fail",
                          "tofu validate (backend disabled)", time.monotonic() - t0)
    # live
    rc, _ = ctx.run(["tofu", "plan", "-detailed-exitcode", "-input=false",
                     "-out=/tmp/opnory-lab.tfplan"], cwd=ctx.tofu_dir)
    # 0 = no changes (surprising on empty env but not an error), 2 = changes planned
    return StepResult("pass" if rc in (0, 2) else "fail", f"tofu plan rc={rc}",
                      time.monotonic() - t0)


def _parse_mutation_count(output: str, verb: str) -> int:
    # Matches lines like: "Apply complete! Resources: 5 added, 0 changed, 0 destroyed."
    # or "Destroy complete! Resources: 5 destroyed."
    for line in output.splitlines():
        if verb in line and ":" in line:
            try:
                segs = line.split(":", 1)[1].split(",")
                total = 0
                for seg in segs:
                    parts = seg.strip().split()
                    if parts and parts[0].isdigit():
                        total += int(parts[0])
                return total
            except (ValueError, IndexError):
                continue
    return 0


def step_apply(ctx: Context, cycle: int) -> StepResult:
    if ctx.args.mode != "live":
        return dry("apply")
    if os.environ.get("OPNORY_IAC_PHASE", "1A") == "1A":
        return StepResult("fail",
                          "apply hard-blocked in Phase 1A by harness policy")
    t0 = time.monotonic()
    rc, out = ctx.run(["tofu", "apply", "-input=false", "-auto-approve",
                       "/tmp/opnory-lab.tfplan"], cwd=ctx.tofu_dir, timeout=1800)
    mutations = _parse_mutation_count(out, "Apply complete")
    ctx.ledger("record", "--cycle", str(cycle), "--step", "apply",
               "--action", "create", "--count", str(mutations))
    return StepResult("pass" if rc == 0 else "fail", f"tofu apply rc={rc}",
                      time.monotonic() - t0, mutations)


def step_cloud_init(ctx: Context) -> StepResult:
    if ctx.args.mode != "live":
        return dry("cloud_init")
    t0 = time.monotonic()
    # Wait for cloud-init to finish over SSH. The deploy user and SSH key path
    # come from the provisioned host-contract outputs, never from secrets here.
    host_rc, host = ctx.run(["tofu", "output", "-raw", "host_address"],
                            cwd=ctx.tofu_dir)
    if host_rc != 0 or not host:
        return StepResult("fail", "no host_address output from OpenTofu",
                          time.monotonic() - t0)
    user = ctx.config.get("ssh_user", "opnory-deploy")
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
           "-o", "ConnectTimeout=10", f"{user}@{host.strip()}",
           "cloud-init status --wait"]
    rc, out = ctx.run(cmd, timeout=900)
    return StepResult("pass" if rc == 0 else "fail",
                      f"cloud-init status rc={rc}", time.monotonic() - t0)


def _ansible(ctx: Context, extra: list[str], label: str) -> StepResult:
    if ctx.args.mode != "live":
        return dry(label)
    t0 = time.monotonic()
    playbook = REPO_ROOT / ctx.config.get("ansible_playbook", "infra/ansible/site.yml")
    inv_dir = REPO_ROOT / "infra/ansible/inventories/lab"
    rc, out = ctx.run(["ansible-playbook", "-i", str(inv_dir), str(playbook)] + extra,
                      timeout=3600)
    return StepResult("pass" if rc == 0 else "fail", f"{label} rc={rc}",
                      time.monotonic() - t0)


def step_compose_up(ctx: Context) -> StepResult:
    if ctx.args.mode != "live":
        return dry("compose_up")
    t0 = time.monotonic()
    host_rc, host = ctx.run(["tofu", "output", "-raw", "host_address"], cwd=ctx.tofu_dir)
    if host_rc != 0 or not host:
        return StepResult("fail", "no host_address output", time.monotonic() - t0)
    user = ctx.config.get("ssh_user", "opnory-deploy")
    project = ctx.config.get("compose_project_dir", "/srv/opnory")
    rc, _ = ctx.run(["ssh", "-o", "BatchMode=yes", f"{user}@{host.strip()}",
                     f"cd {project} && docker compose up -d --wait"],
                    timeout=1200)
    return StepResult("pass" if rc == 0 else "fail", f"compose up rc={rc}",
                      time.monotonic() - t0)


def step_health(ctx: Context) -> StepResult:
    if ctx.args.mode != "live":
        return dry("workload_health")
    t0 = time.monotonic()
    dns_rc, dns = ctx.run(["tofu", "output", "-raw", "dns_name"], cwd=ctx.tofu_dir)
    if dns_rc != 0 or not dns:
        return StepResult("fail", "no dns_name output", time.monotonic() - t0)
    rc, _ = ctx.run(["curl", "-fsS", "--max-time", "30",
                     f"https://{dns.strip()}/healthz"], timeout=60)
    return StepResult("pass" if rc == 0 else "fail", f"/healthz rc={rc}",
                      time.monotonic() - t0)


def step_opnory_verification(ctx: Context) -> StepResult:
    if ctx.args.mode != "live":
        return dry("opnory_verification")
    t0 = time.monotonic()
    # Verification suite hooks in here; defined by Phase 1B contract.
    rc, _ = ctx.run([str(REPO_ROOT / "infra/repro-harness/scripts/verify_opnory.sh")],
                    timeout=900)
    return StepResult("pass" if rc == 0 else "fail",
                      f"verify_opnory.sh rc={rc}", time.monotonic() - t0)


def step_post_apply_drift(ctx: Context) -> StepResult:
    if ctx.args.mode != "live":
        return dry("post_apply_drift")
    t0 = time.monotonic()
    rc, out = ctx.run(["tofu", "plan", "-detailed-exitcode", "-input=false"],
                      cwd=ctx.tofu_dir)
    if rc == 0:
        return StepResult("pass", "no drift", time.monotonic() - t0)
    if rc == 2:
        return StepResult("fail", "unexplained drift detected after apply",
                          time.monotonic() - t0)
    return StepResult("fail", f"tofu plan rc={rc}", time.monotonic() - t0)


def step_ansible_idempotence(ctx: Context) -> StepResult:
    if ctx.args.mode != "live":
        return dry("ansible_idempotence")
    t0 = time.monotonic()
    playbook = REPO_ROOT / ctx.config.get("ansible_playbook", "infra/ansible/site.yml")
    inv_dir = REPO_ROOT / "infra/ansible/inventories/lab"
    rc, out = ctx.run(["ansible-playbook", "-i", str(inv_dir), str(playbook)],
                      timeout=3600)
    if rc != 0:
        return StepResult("fail", f"second ansible run rc={rc}",
                          time.monotonic() - t0)
    # Count changed>0 across host recap lines.
    changed = 0
    for line in out.splitlines():
        if "changed=" in line:
            try:
                frag = [p for p in line.split() if p.startswith("changed=")][0]
                changed += int(frag.split("=")[1])
            except (IndexError, ValueError):
                pass
    if changed == 0:
        return StepResult("pass", "second run: 0 changes (idempotent)",
                          time.monotonic() - t0)
    return StepResult("fail", f"second run reported {changed} changes — not idempotent",
                      time.monotonic() - t0)


def step_destroy(ctx: Context, cycle: int) -> StepResult:
    if ctx.args.mode != "live":
        return dry("destroy")
    if os.environ.get("OPNORY_IAC_PHASE", "1A") == "1A":
        return StepResult("fail",
                          "destroy hard-blocked in Phase 1A by harness policy")
    t0 = time.monotonic()
    rc, out = ctx.run(["tofu", "destroy", "-auto-approve", "-input=false"],
                      cwd=ctx.tofu_dir, timeout=1800)
    mutations = _parse_mutation_count(out, "Destroy complete")
    ctx.ledger("record", "--cycle", str(cycle), "--step", "destroy",
               "--action", "delete", "--count", str(mutations))
    return StepResult("pass" if rc == 0 else "fail", f"tofu destroy rc={rc}",
                      time.monotonic() - t0, mutations)


def step_post_destroy_residue(ctx: Context) -> StepResult:
    if ctx.args.mode != "live":
        return dry("post_destroy_residue")
    t0 = time.monotonic()
    rc, out = ctx.run(["tofu", "state", "list"], cwd=ctx.tofu_dir)
    if rc != 0:
        return StepResult("fail", f"tofu state list rc={rc}", time.monotonic() - t0)
    remaining = [ln for ln in out.splitlines() if ln.strip()]
    if remaining:
        return StepResult("fail",
                          f"{len(remaining)} resources remain after destroy — residue",
                          time.monotonic() - t0)
    return StepResult("pass", "zero residue after destroy", time.monotonic() - t0)


def run_cycle(ctx: Context, cycle: int) -> dict:
    results: dict[str, StepResult] = {}
    ctx.ledger("init", "--cycle", str(cycle), "--commit", ctx.args.commit,
               "--force")

    # Preflight is always really executed — it is non-mutating by design.
    t0 = time.monotonic()
    rc, out = ctx.run([sys.executable, str(PREFLIGHT), "--target", ctx.args.target,
                       "--mode", ctx.args.mode,
                       "--steps", ",".join(STEPS)])
    results["preflight"] = StepResult("pass" if rc == 0 else "fail",
                                      "preflight.py " + ("pass" if rc == 0 else "FAIL"),
                                      time.monotonic() - t0)

    step_fns = {
        "plan": lambda: step_plan(ctx),
        "apply": lambda: step_apply(ctx, cycle),
        "cloud_init": lambda: step_cloud_init(ctx),
        "ansible_converge": lambda: _ansible(ctx, [], "ansible_converge"),
        "compose_up": lambda: step_compose_up(ctx),
        "workload_health": lambda: step_health(ctx),
        "opnory_verification": lambda: step_opnory_verification(ctx),
        "post_apply_drift": lambda: step_post_apply_drift(ctx),
        "ansible_idempotence": lambda: step_ansible_idempotence(ctx),
        "destroy": lambda: step_destroy(ctx, cycle),
        "post_destroy_residue": lambda: step_post_destroy_residue(ctx),
    }

    aborted = False
    for step in STEPS[1:]:
        if aborted or results["preflight"].status == "fail":
            results[step] = StepResult("skipped", "aborted upstream")
            continue
        res = step_fns[step]()
        results[step] = res
        if res.status == "fail":
            aborted = True

    statuses = [r.status for r in results.values()]
    if any(s == "fail" for s in statuses):
        cycle_result = "ABORTED" if aborted else "FAIL"
    elif all(s in ("pass",) for s in statuses):
        cycle_result = "PASS"
    elif any(s == "dry_run_planned" for s in statuses) and not any(
            s == "fail" for s in statuses):
        cycle_result = "DRY_RUN"
    else:
        cycle_result = "FAIL"

    return {
        "cycle": cycle,
        **{k: v.to_dict() for k, v in results.items()},
        "cycle_result": cycle_result,
    }


def _tool_versions(ctx: Context) -> dict:
    def first_line(cmd: list[str]) -> str | None:
        rc, out = ctx.run(cmd, timeout=30)
        return out.splitlines()[0][:120] if rc == 0 and out else None

    return {
        "opentofu": first_line(["tofu", "version"]),
        "ansible": first_line(["ansible-playbook", "--version"]),
        "docker": first_line(["docker", "--version"]),
        "docker_compose": first_line(["docker", "compose", "version"]),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", required=True, help="Path to lab target JSON config")
    parser.add_argument("--mode", choices=("dry-run", "static", "live"), default="dry-run")
    parser.add_argument("--cycles", type=int, default=2, choices=(1, 2))
    parser.add_argument("--ledger", default="/tmp/opnory-iac-mutations.jsonl")
    parser.add_argument("--evidence-out", default="/tmp/opnory-iac-evidence.json")
    args = parser.parse_args(argv)

    config = json.loads(Path(args.target).read_text())

    rc, commit = (
        lambda p: (p.returncode, p.stdout.strip())
    )(subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
                     capture_output=True, text=True))
    args.commit = commit

    ctx = Context(args, config)

    cycles = [run_cycle(ctx, n) for n in range(1, args.cycles + 1)]

    # Budget enforcement against declared mutation budget.
    budget = int(config.get("mutation_budget", 0))
    budget_rc, totals_out = ctx.ledger("totals")
    observed = 0
    try:
        observed = json.loads(totals_out).get("observed", 0)
    except json.JSONDecodeError:
        pass
    budget_ok = observed <= budget

    if ctx.args.mode != "live" and all(c["cycle_result"] == "DRY_RUN" for c in cycles):
        overall = "DRY_RUN"
    elif all(c["cycle_result"] == "PASS" for c in cycles) and budget_ok:
        overall = "PASS"
    else:
        overall = "FAIL"

    evidence = {
        "schema_version": "1.0.0",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "generator": "infra/repro-harness",
        "commit_sha": args.commit,
        "tool_versions": _tool_versions(ctx),
        "provider": config.get("provider", "unresolved"),
        "environment": config.get("environment", "lab"),
        "terraform_state_identity": config.get("state_identity", ""),
        "mutation_budget": {"declared": budget, "observed": observed},
        "cycles": cycles,
        "overall_result": overall,
    }

    out_path = Path(args.evidence_out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"evidence written: {out_path}")
    print(f"overall_result: {overall}")
    print(f"mutation budget: declared={budget} observed={observed} ok={budget_ok}")
    return 0 if overall in ("PASS", "DRY_RUN") else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
