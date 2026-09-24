# Hetzner firewall implementing infra/modules/firewall-policy/policy.json
# exactly:
#   inbound: 22/tcp from operator_cidr; 80/tcp from any; 443/tcp from any;
#   default inbound deny; outbound allow-all.
#
# Hetzner firewalls deny all unspecified inbound traffic by default and have
# no explicit outbound deny; we declare outbound allow-all explicitly for
# symmetry with the policy file.

resource "hcloud_firewall" "lab" {
  name = "opnory-lab-fw"

  labels = local.labels

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = [var.operator_cidr]
    description = "ssh from operator cidr only"
  }

  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "80"
    source_ips = [
      "0.0.0.0/0",
      "::/0",
    ]
    description = "http (acme challenge + redirect to https)"
  }

  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "443"
    source_ips = [
      "0.0.0.0/0",
      "::/0",
    ]
    description = "https"
  }

  rule {
    direction = "out"
    protocol  = "tcp"
    port      = "any"
    destination_ips = [
      "0.0.0.0/0",
      "::/0",
    ]
    description = "outbound allow-all per firewall-policy"
  }

  rule {
    direction = "out"
    protocol  = "udp"
    port      = "any"
    destination_ips = [
      "0.0.0.0/0",
      "::/0",
    ]
    description = "outbound allow-all per firewall-policy"
  }

  rule {
    direction = "out"
    protocol  = "icmp"
    destination_ips = [
      "0.0.0.0/0",
      "::/0",
    ]
    description = "outbound icmp allow per firewall-policy"
  }
}

resource "hcloud_firewall_attachment" "lab" {
  firewall_id = hcloud_firewall.lab.id
  server_ids  = [var.server_id]
}
