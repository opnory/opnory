# Compute module — one disposable Hetzner Cloud VM (infra/providers/hetzner/compute/).
module "compute" {
  source = "../../providers/hetzner/compute"

  hostname            = var.hostname
  ssh_public_key      = var.ssh_public_key
  cloud_init_template = "${path.root}/../../bootstrap/cloud-init/cloud-config.yml"
  environment         = var.environment
  server_type         = var.server_type
  image               = var.image
  location            = var.location
}

# Network/firewall module (infra/providers/hetzner/network/).
module "network" {
  source = "../../providers/hetzner/network"

  operator_cidr = var.operator_cidr
  server_id     = module.compute.server_id
}

# DNS policy (infra/modules/dns/README.md): exactly one A record, TTL <= 300,
# no CNAME/wildcard, destroyed with this stack. Cloudflare is authoritative
# for the zone (dig-verified jocelyn/ishaann.ns.cloudflare.com for
# opnory.com); the compute provider must not own a zone.
#
# The record MUST be DNS-only (proxied = false, grey cloud): a proxied record
# would point at Cloudflare edge IPs and break the verify_opnory.sh
# dns_name==host_address assertion.
resource "cloudflare_record" "lab" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "A"
  content = module.compute.host_address
  ttl     = 300
  proxied = false

  comment = "opnory-iac lab (environment=lab managed-by=opnory-iac swarm=iac-1b)"
}
