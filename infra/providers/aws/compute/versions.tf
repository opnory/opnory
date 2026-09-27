terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
  }

  # S3 backend with use_lockfile=true (S3-native locking) requires
  # OpenTofu >= 1.10 — verified in the v1.10.0 CHANGELOG.
  required_version = ">= 1.10.0"
}
