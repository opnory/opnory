variable "operator_cidr" {
  description = "Operator CIDR permitted SSH ingress (firewall-policy policy.json source)"
  type        = string
}

variable "server_id" {
  description = "hcloud_server id the firewall attaches to"
  type        = string
}
