terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
  }

  # Cost-safety: refuse to plan against any region other than the pinned lab
  # region. Guard 14 (unsupported region) at the module layer.
  required_version = ">= 1.10.0"
}
