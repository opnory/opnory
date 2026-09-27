# Shared lab-only label set applied to EVERY AWS resource in this stack.
# preflight.py asserts these label blocks statically (verifier gap G2),
# provider-keyed as of Phase 1B-COST-SAFETY.
locals {
  labels = {
    environment = "lab"
    managed-by  = "opnory-iac"
    swarm       = "iac-1b"
  }
}
