# Shared lab-only label set applied to EVERY Hetzner resource in this stack.
# preflight.py asserts these label blocks statically (verifier gap G2).
locals {
  labels = {
    environment = "lab"
    managed-by  = "opnory-iac"
    swarm       = "iac-1b"
  }
}
