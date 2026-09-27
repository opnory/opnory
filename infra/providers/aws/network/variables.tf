variable "operator_cidr" {
  description = "Operator CIDR permitted SSH ingress (firewall-policy policy.json source)"
  type        = string

  validation {
    condition     = can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$", var.operator_cidr))
    error_message = "operator_cidr must be an IPv4 CIDR (e.g. 203.0.113.10/32)."
  }
}

variable "availability_zone" {
  description = "Single explicit availability zone in the pinned region (us-east-2); the lab is one host, no multi-AZ"
  type        = string
  default     = "us-east-2a"

  validation {
    condition     = can(regex("^us-east-2[a-f]$", var.availability_zone))
    error_message = "availability_zone must be us-east-2[a-f]; any other region fails closed (guard 14)."
  }
}
