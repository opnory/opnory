# Minimal Hetzner Cloud VM satisfying the host-contract (ADR 0012 §3).
# Phase 1B: exactly one Linux VM. No HA, no load balancers, no extras.

resource "hcloud_server" "this" {
  name        = "opnory-lab-1"
  server_type = var.server_type
  image       = var.image
  location    = var.location

  ssh_keys = [hcloud_ssh_key.this.id]
  user_data = templatefile(var.cloud_init_template, {
    hostname       = var.hostname
    ssh_public_key = var.ssh_public_key
  })

  labels = local.labels

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }
}

# ipv4_enabled creates a managed primary IPv4 automatically; reference it
# through the server resource only (no separate primary_ip resource needed
# at this scale).
