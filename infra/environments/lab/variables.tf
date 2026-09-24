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

variable "server_type" {
  description = "Hetzner server type"
  type        = string
  default     = "cx23"
}

variable "image" {
  description = "Linux image"
  type        = string
  default     = "ubuntu-24.04"
}

variable "location" {
  description = "Hetzner location"
  type        = string
  default     = "fsn1"
}
