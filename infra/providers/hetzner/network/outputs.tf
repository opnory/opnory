output "firewall_id" {
  description = "hcloud firewall id (internal use only; not part of the lab host-contract)"
  value       = hcloud_firewall.lab.id
}
