# Shared lab-only label set applied to every AWS resource in this stack.
# preflight.py asserts these label blocks statically (verifier gap G2),
# provider-keyed as of Phase 1B-COST-SAFETY.
#
# Label coverage decision (F-3, t_84c60ec5), enforced block-level by
# preflight.py:
#   - SG ingress/egress rule resources DO support `tags` (schema-verified)
#     and now carry tags = local.labels.
#   - aws_route and aws_route_table_association carry NO tags attribute in
#     the provider schema — structurally unlabelable. They are exempt in
#     preflight.py PROVIDER_UNLABELABLE_RESOURCES with this rationale:
#     they are child plumbing of aws_route_table / aws_subnet, which ARE
#     labeled, so every route object is reachable only via a labeled parent.
locals {
  labels = {
    environment = "lab"
    managed-by  = "opnory-iac"
    swarm       = "iac-1b"
  }
}
