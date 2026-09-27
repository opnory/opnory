terraform {
  # Out-of-band state backend (execution-contract §1, ADR 0012).
  # The backend TYPE is declared here; ALL connection details are supplied at
  # init time via -backend-config and are NEVER committed:
  #
  #   tofu init \
  #     -backend-config="bucket=<state-bucket>" \
  #     -backend-config="key=lab.tfstate" \
  #     -backend-config="region=us-east-2" \
  #     -backend-config="use_lockfile=true" \
  #     -backend-config="encrypt=true"
  #
  # NO access_key/secret_key in backend-config args (F7): credentials resolve
  # from the standard AWS env chain ONLY.
  #
  # See infra/environments/lab/STATE-BACKEND.md for the exact contract.
  backend "s3" {}

  required_version = ">= 1.10.0" # S3 use_lockfile backend requires >= 1.10

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }
}

# Provider configuration: region pinned (guard 14) and fail-closed. AWS
# credentials come from the standard env chain; nothing is embedded here.
provider "aws" {
  region = var.aws_region

  # Cost-safety: never skip provider-side checks; never assume a role that
  # would widen the lab principal.
  skip_region_validation = false
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
