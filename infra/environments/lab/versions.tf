terraform {
  # Out-of-band state backend (execution-contract §1, ADR 0012).
  # The backend TYPE is declared here; ALL connection details are supplied at
  # init time via -backend-config and are NEVER committed:
  #
  #   tofu init \
  #     -backend-config="bucket=<state-bucket>" \
  #     -backend-config="key=lab.tfstate" \
  #     -backend-config="endpoint=<s3-endpoint>" \
  #     -backend-config="region=<region>" \
  #     -backend-config="access_key=..." -backend-config="secret_key=..." ...
  #
  # See infra/environments/lab/STATE-BACKEND.md for the exact contract.
  backend "s3" {}

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.69.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }
}

# Fail-closed environment guard: only the disposable lab may be built here.
resource "terraform_data" "environment_guard" {
  lifecycle {
    precondition {
      condition     = var.environment == "lab"
      error_message = "environments/lab builds environment=lab only. Refusing anything else."
    }
    precondition {
      condition     = var.hostname == var.dns_record_name
      error_message = "hostname and dns_record_name must match; the host FQDN and the Cloudflare A record are one identity."
    }
  }
}
