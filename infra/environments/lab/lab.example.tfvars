# Example only. Copy to infra/environments/lab/lab.tfvars (gitignored) or
# pass with -var; never commit real values.
hostname           = "node1.lab.example.com"
dns_record_name    = "node1.lab.example.com"
cloudflare_zone_id = "00000000000000000000000000000000"
ssh_public_key     = "ssh-ed25519 AAAA... operator@example"
operator_cidr      = "203.0.113.10/32"
