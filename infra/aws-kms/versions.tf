terraform {
  required_version = ">= 1.10.0"

  # Account-specific values are supplied from an ignored *.tfbackend file.
  # Terraform 1.10+ is required for native S3 lockfile support.
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60, < 7.0"
    }
  }
}
