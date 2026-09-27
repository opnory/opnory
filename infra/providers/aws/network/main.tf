# AWS network module — dedicated VPC/subnet/IGW/route-table/security-group
# implementing infra/modules/firewall-policy/policy.json exactly:
#   inbound: 22/tcp from operator_cidr; 80/tcp from any; 443/tcp from any;
#   default inbound deny (SG default); outbound allow-all.
#
# Cost-safety constraints (Phase 1B-COST-SAFETY, security design §9):
#   - NO aws_nat_gateway, NO aws_lb/alb/elb, NO aws_eip, NO aws_db*, NO
#     aws_eks, NO aws_organizations_*, NO aws_controltower_* — any of these
#     is a paid-plan escape and fails the escape-guard suite.
#   - The default VPC is NOT used: a dedicated VPC keeps lab residue
#     invisible to the tofu state list residue proof and the label scan.
#   - Public IPv4 is auto-assigned by the subnet attribute (charged only
#     while the instance runs). No Elastic IP: an unassociated EIP bills
#     idle hourly charges.
#
# Resource count (guard 12/F2): this module contributes EXACTLY 11 resource
# blocks. Together with compute's 2 (aws_instance, aws_key_pair) and the
# lab root's 1 cloudflare_record, the graph is 14 blocks/cycle and the
# ledger expectation is 14x2x2 = 56 <= 60.

resource "aws_vpc" "lab" {
  cidr_block           = "10.0.16.0/24"
  enable_dns_hostnames = true
  enable_dns_support   = true

  # checkov:skip=CKV2_AWS_11:Free-plan cost-safety — flow logging requires a
  # metered CloudWatch Logs delivery surface plus an IAM role to publish;
  # the disposable lab VPC carries nothing to audit. See PHASE-1B-SYNTHESIS.md §20.
  # checkov:skip=CKV2_AWS_12:Free-plan cost-safety — managing the default SG
  # would add a 15th resource block to the frozen 14-block mutation graph
  # (preflight aws:resource-graph-count) and widen the least-privilege IAM
  # surface; nothing attaches the default SG — the lab instance uses only
  # the explicit lab SG (22/80/443 exactly, per firewall-policy).
  tags = local.labels
}

resource "aws_subnet" "lab" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.0.16.0/24"
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true # public IPv4 auto-assign; no aws_eip (guard 8)

  # checkov:skip=CKV_AWS_130:Free-plan cost-safety — the ACME HTTP-01
  # challenge and the verify_opnory.sh dns_name==host_address assertion
  # REQUIRE a public IPv4; it is charged only while the instance runs and is
  # released by destroy (post_destroy_residue). No aws_eip exists (guard 8).
  tags = local.labels
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id

  tags = local.labels
}

resource "aws_route_table" "lab" {
  vpc_id = aws_vpc.lab.id

  tags = local.labels
}

resource "aws_route" "lab_default_ipv4" {
  route_table_id         = aws_route_table.lab.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route_table_association" "lab" {
  subnet_id      = aws_subnet.lab.id
  route_table_id = aws_route_table.lab.id
}

resource "aws_security_group" "lab" {
  name        = "opnory-lab-fw"
  description = "opnory lab firewall (firewall-policy policy.json)"
  vpc_id      = aws_vpc.lab.id

  # checkov:skip=CKV2_AWS_5:Graph false positive — the SG IS attached, via
  # module "network" output security_group_id consumed by
  # aws_instance.this's vpc_security_group_ids in providers/aws/compute
  # (see environments/lab/main.tf module wiring); checkov's module graph
  # does not resolve the cross-module reference.
  tags = local.labels
}

# Ingress/egress rules as standalone resources: one rule per policy.json
# entry, each with a description. Private service ports (5432/6379/3100/
# 4317/3000) are never opened — same assertion as the Hetzner stack.

resource "aws_vpc_security_group_ingress_rule" "ssh_operator" {
  security_group_id = aws_security_group.lab.id
  description       = "ssh from operator cidr only"
  cidr_ipv4         = var.operator_cidr
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"

  tags = local.labels
}

resource "aws_vpc_security_group_ingress_rule" "http_acme" {
  security_group_id = aws_security_group.lab.id
  description       = "http (acme challenge + redirect to https)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"

  # checkov:skip=CKV_AWS_260:Free-plan cost-safety / functional requirement —
  # port 80 is REQUIRED open to the world for the ACME HTTP-01 challenge and
  # the https redirect; it implements firewall-policy policy.json exactly
  # (80/tcp from any). Caddy terminates and redirects; nothing else listens.

  tags = local.labels
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.lab.id
  description       = "https"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"

  tags = local.labels
}

# policy.json outbound: "allow-all".
resource "aws_vpc_security_group_egress_rule" "allow_all" {
  security_group_id = aws_security_group.lab.id
  description       = "outbound allow-all per firewall-policy"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"

  tags = local.labels
}
