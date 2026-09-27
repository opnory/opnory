# providers/

Provider implementations of the host-contract live here, one directory per
provider: `infra/providers/<name>/{compute,network,storage}/`.

## Phase 1B-COST-SAFETY status: AWS selected for the live proof; Hetzner implemented, non-selected

The live proof target for Phase 1B-COST-SAFETY is **AWS on the human-confirmed
Free plan** (`hashicorp/aws` pinned `~> 6.66`). Zero out-of-pocket cloud cost
is the governing constraint and it ended the Hetzner selection before any live
execution (zero Hetzner live mutations ever occurred).

- `aws/compute/` — exactly one disposable `t3a.medium` EC2 instance
  (credit_specification standard, IMDSv2 required, 20GiB gp3 encrypted root
  volume, dynamic owner-pinned Ubuntu Noble AMI) plus one `aws_key_pair`;
  exposes exactly the host-contract outputs.
- `aws/network/` — dedicated VPC/subnet/IGW/route-table/security-group with
  auto-assigned public IPv4 (no Elastic IP) implementing
  `modules/firewall-policy/policy.json` exactly.
- `aws/iam/` — the least-privilege `opnory-lab-executor` policy (committed
  with placeholders; principal NOT created by the repo) and its README
  documenting the AWS-un-scopable permission set.
- `hetzner/` — **kept byte-for-byte, marked non-selected** for this proof.
  The Hetzner executor remains blocked; it was implemented in Phase 1B-A and
  live execution was abandoned before mutation.

Every AWS resource carries the lab-only label set
`environment=lab, managed-by=opnory-iac, swarm=iac-1b`; preflight asserts
this statically (fail-closed, provider-keyed). The 15 Free-plan escape
guards + destroy-path guard run in the standard self-test suite
(`tests/aws_escape_guards.sh`) — static only, zero AWS API calls.

See `environments/lab/PHASE-1B-SYNTHESIS.md` §20 for the full cost-safety
contract (gates, budget arithmetic, runtime cap, account-safety rules).
