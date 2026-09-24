# Operator SSH public key registered with the project so cloud-init can
# authorize it (the key material travels only via -var at apply time).
resource "hcloud_ssh_key" "this" {
  name       = "opnory-lab-operator"
  public_key = var.ssh_public_key
  labels     = local.labels
}
