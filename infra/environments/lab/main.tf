# Compute module — one disposable EC2 instance
# (infra/providers/aws/compute/). Phase 1B-COST-SAFETY: the selected live lab
# provider is AWS on the human-confirmed Free plan; the Hetzner implementation
# stays in-tree, unselected, with its executor blocked.
module "compute" {
  source = "../../providers/aws/compute"

  hostname            = var.hostname
  ssh_public_key      = var.ssh_public_key
  cloud_init_template = "${path.root}/../../bootstrap/cloud-init/cloud-config.yml"
  environment         = var.environment
  instance_type       = var.instance_type
  ami_owner           = var.ami_owner
  region              = var.aws_region
  subnet_id           = module.network.subnet_id
  security_group_id   = module.network.security_group_id
}

# Network/firewall module (infra/providers/aws/network/).
module "network" {
  source = "../../providers/aws/network"

  operator_cidr     = var.operator_cidr
  availability_zone = var.aws_availability_zone
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
