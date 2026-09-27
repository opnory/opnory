# AWS compute module — exactly one disposable EC2 instance satisfying the
# host-contract (ADR 0012 §3). Phase 1B-COST-SAFETY: no HA, no load balancers,
# no extra instances.
#
# Cost-safety invariants enforced here (security design §9 guards 11/12/13,
# architect §6):
#   - instance_type allow-list is EXACTLY ["t3a.medium"] (variable validation)
#   - credit_specification = "standard" — NEVER "unlimited": surplus CPU
#     credits bill $0.05/vCPU-hr in Unlimited mode; standard can throttle
#     but never bill extra
#   - IMDSv2 required (metadata_options.http_tokens = "required")
#   - root EBS volume: gp3, exactly 20 GiB, encrypted, delete_on_termination
#     (no standalone aws_ebs_volume resource — guard 13)
#   - public IPv4 comes from the subnet auto-assign attribute; no
#     associate_public_ip_address argument, no aws_eip (guard 8)
#   - get_password_data = false; no password material ever requested

data "aws_ami" "ubuntu_noble" {
  most_recent = true

  # Owner is NOT hard-coded (architect risk 1): the operator supplies the
  # verified Canonical owner id at plan time via -var and preflight (live
  # mode) independently resolves the AMI owner and compares. No default —
  # unset owner = fail closed. Guard 5 (paid Marketplace AMI): the explicit
  # IAM Deny on ec2:Owner=aws-marketplace plus this allow-list pin make a
  # marketplace image structurally unreachable.
  owners = [var.ami_owner]

  filter {
    name   = "name"
    values = ["ubuntu-noble-24.04-*amd64-server*"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "this" {
  key_name   = "opnory-lab-operator"
  public_key = var.ssh_public_key

  tags = local.labels
}

resource "aws_instance" "this" {
  ami                    = data.aws_ami.ubuntu_noble.id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]
  key_name               = aws_key_pair.this.key_name

  user_data = templatefile(var.cloud_init_template, {
    hostname       = var.hostname
    ssh_public_key = var.ssh_public_key
  })

  # NEVER "unlimited": surplus credits bill money. Standard mode is the
  # cost-safety invariant (escape test 12 asserts this exact value).
  credit_specification {
    cpu_credits = "standard"
  }

  # checkov:skip=CKV_AWS_126:Free-plan cost-safety — detailed monitoring is a
  # metered per-instance-metric charge; the disposable lab instance needs
  # only the free basic monitoring.
  # checkov:skip=CKV2_AWS_41:Free-plan cost-safety / least privilege — an
  # instance profile widens the blast radius: the lab host runs the compose
  # stack only and needs NO AWS API access; no IAM role is deliberately
  # attached (the executor policy contains no iam:* actions at all, so a
  # role could not be passed even if one were declared — asserted by
  # aws_escape_guards.sh structural check iam:no-admin-poweruser-purchase-billing).
  monitoring = false

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  # ebs_optimized is free on this instance generation
  ebs_optimized = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    encrypted             = true
    delete_on_termination = true # residue-proof
  }

  tags = local.labels
}
