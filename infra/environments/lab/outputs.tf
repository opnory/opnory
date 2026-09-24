# Host-contract outputs, re-exposed verbatim from the compute module.
# render_inventory.py and validate_contract.py consume EXACTLY these keys;
# do not add debugging outputs here (they fail the contract validator).

output "host_address" {
  value = module.compute.host_address
}

output "private_address" {
  value = module.compute.private_address
}

output "dns_name" {
  value = module.compute.dns_name
}

output "environment" {
  value = module.compute.environment
}
