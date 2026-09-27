variable "environment" {
  description = "Deployment environment; this root refuses anything but \"lab\""
  type        = string
  default     = "lab"
}

variable "hostname" {
  description = "Public FQDN of the lab host (e.g. node1.lab.opnory.com)"
  type        = string
}

variable "dns_record_name" {
  description = "Cloudflare A record name; must equal hostname per dns module policy"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id that owns the lab record (Cloudflare stays authoritative; Hetzner never owns DNS)"
  type        = string
}

variable "ssh_public_key" {
  description = "Operator SSH public key for the opnory deploy user"
  type        = string
}

variable "operator_cidr" {
  description = "Operator CIDR permitted SSH ingress (e.g. 203.0.113.10/32)"
  type        = string
}

# --- AWS-specific variables (Phase 1B-COST-SAFETY) -------------------------
# All three pin cost-safety-critical values with validation blocks so any
# other value fails plan (guards 11/13/14).

variable "aws_region" {
  description = "Pinned lab region — allow-list is EXACTLY us-east-2 (guard 14). Free-plan availability and reproducibility govern; latency is secondary."
  type        = string
  default     = "us-east-2"

  validation {
    condition     = var.aws_region == "us-east-2"
    error_message = "aws_region must be us-east-2; the lab region is explicit and fails closed."
  }
}

variable "aws_availability_zone" {
  description = "Single explicit availability zone in us-east-2; the lab is one host, no multi-AZ"
  type        = string
  default     = "us-east-2a"

  validation {
    condition     = can(regex("^us-east-2[a-f]$", var.aws_availability_zone))
    error_message = "aws_availability_zone must be us-east-2[a-f]."
  }
}

variable "instance_type" {
  description = "EC2 instance type — allow-list is EXACTLY the human-confirmed Free-plan-eligible type (guard 11)"
  type        = string
  default     = "t3a.medium"

  validation {
    condition     = var.instance_type == "t3a.medium"
    error_message = "instance_type must be t3a.medium; any other type fails closed."
  }
}

variable "ami_owner" {
  description = "Operator-verified 12-digit Canonical account id owning the Ubuntu Noble 24.04 amd64 AMI. NO default — fail closed rather than trusting any published image (guard 5)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.ami_owner))
    error_message = "ami_owner must be a 12-digit AWS account id (operator-verified Canonical owner)."
  }
}
