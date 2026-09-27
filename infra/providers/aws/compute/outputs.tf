# Host-contract outputs (infra/modules/host-contract/README.md).
# EXACTLY these keys; extra outputs fail validate_contract.py.

output "host_address" {
  description = "Public IPv4 of the lab host"
  value       = aws_instance.this.public_ip
}

output "instance_id" {
  description = "Internal wiring only (lifecycle SSH probes / future use). The environment root must not re-export this."
  value       = aws_instance.this.id
}

output "private_address" {
  description = "Internal address for host-local service binding: the true VPC-internal private IP (strictly more faithful to ADR 0012 §3 than the Hetzner public-address fallback)."
  value       = aws_instance.this.private_ip
}

output "dns_name" {
  description = "Public FQDN that resolves to host_address (Cloudflare record, DNS-only)"
  value       = var.hostname
}

output "environment" {
  description = "Deployment environment (lab)"
  value       = var.environment
}
