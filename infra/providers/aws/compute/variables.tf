variable "instance_type" {
  description = "EC2 instance type for the disposable lab host — allow-list is EXACTLY the Free-plan-verified type (guard 11)"
  type        = string
  default     = "t3a.medium"

  validation {
    condition     = var.instance_type == "t3a.medium"
    error_message = "instance_type must be t3a.medium (2 vCPU/4 GiB, the human-confirmed Free-plan-eligible type). Any other type fails closed."
  }
}

variable "ami_owner" {
  description = "AWS account id owning the Ubuntu Noble 24.04 amd64 AMI (the Canonical owner, operator-verified in the console at plan time). NO default: an unset owner fails closed rather than trusting any published image (guard 5)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.ami_owner))
    error_message = "ami_owner must be a 12-digit AWS account id (the operator-verified Canonical owner)."
  }
}

variable "region" {
  description = "Pinned lab region — allow-list is EXACTLY us-east-2 (guard 14). Free-plan availability, service availability and reproducibility govern; latency is secondary."
  type        = string
  default     = "us-east-2"

  validation {
    condition     = var.region == "us-east-2"
    error_message = "region must be us-east-2; the lab region is explicit and fails closed."
  }
}

variable "hostname" {
  description = "Lab FQDN (must match the Cloudflare DNS record created by the environment root)"
  type        = string
}

variable "ssh_public_key" {
  description = "Operator SSH public key installed for the opnory deploy user (travels only via -var at apply time; never committed)"
  type        = string
}

variable "cloud_init_template" {
  description = "Path to the provider-agnostic cloud-init template (bootstrap/cloud-init/cloud-config.yml)"
  type        = string
}

variable "environment" {
  description = "Deployment environment; host-contract restricts this to lab/staging/production and the lab stack pins lab"
  type        = string
}

variable "subnet_id" {
  description = "Public subnet id from the network module"
  type        = string
}

variable "security_group_id" {
  description = "Lab security group id from the network module"
  type        = string
}
