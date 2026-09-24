# Host-contract outputs (infra/modules/host-contract/README.md).
# EXACTLY these keys; extra outputs fail validate_contract.py.

output "host_address" {
  description = "Public IPv4 of the lab host"
  value       = hcloud_server.this.ipv4_address
}

output "server_id" {
  description = "Internal wiring only (network module firewall attachment). The environment root must not re-export this."
  value       = hcloud_server.this.id
}

output "private_address" {
  description = "Internal address for host-local service binding. The disposable lab host has no private network; services bind to the public address under the firewall or to loopback. Using the public IPv4 satisfies the contract (reachability) while the firewall bounds exposure."
  value       = hcloud_server.this.ipv4_address
}

output "dns_name" {
  description = "Public FQDN that resolves to host_address (Cloudflare record, DNS-only)"
  value       = var.hostname
}

output "environment" {
  description = "Deployment environment (lab)"
  value       = var.environment
}
