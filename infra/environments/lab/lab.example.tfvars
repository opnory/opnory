# Example only. Copy to infra/environments/lab/lab.tfvars (gitignored) or
# pass with -var; never commit real values.
hostname           = "node1.lab.example.com"
dns_record_name    = "node1.lab.example.com"
cloudflare_zone_id = "00000000000000000000000000000000"
ssh_public_key     = "ssh-ed25519 AAAA... operator@example"
operator_cidr      = "203.0.113.10/32"

# AWS (Phase 1B-COST-SAFETY). aws_region and instance_type have allow-list
# validation (us-east-2, t3a.medium) — any other value fails plan. ami_owner
# has NO default: supply the Canonical owner id you verified in the console
# (the same value as the IAM policy's <CANONICAL_OWNER_ID>).
aws_availability_zone = "us-east-2a"
instance_type         = "t3a.medium"
ami_owner             = "<12-digit-canonical-owner-id>"
