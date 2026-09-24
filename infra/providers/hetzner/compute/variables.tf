variable "server_type" {
  description = "Hetzner server type for the disposable lab host"
  type        = string
  default     = "cx23"
}

variable "image" {
  description = "Linux image for the lab host"
  type        = string
  default     = "ubuntu-24.04"
}

variable "location" {
  description = "Hetzner location"
  type        = string
  default     = "fsn1"
}

variable "hostname" {
  description = "Lab FQDN (must match the Cloudflare DNS record created by the environment root)"
  type        = string
}

variable "ssh_public_key" {
  description = "Operator SSH public key installed for the opnory deploy user"
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
