variable "aws_region" {
  description = "AWS region that owns this Unfiled environment's KMS keys."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS region identifier."
  }
}

variable "deployment_environment" {
  description = "Exact Vercel deployment environment trusted by this isolated Terraform stack. Production and Preview must use separate state, role names, aliases, and KMS keys."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "preview"], var.deployment_environment)
    error_message = "deployment_environment must be exactly production or preview."
  }
}

variable "vercel_team_slug" {
  description = "Exact Vercel team slug used by Team Issuer mode."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$", var.vercel_team_slug))
    error_message = "vercel_team_slug must be the exact lowercase Vercel team slug."
  }
}

variable "web_project_name" {
  description = "Exact Vercel project name for the interactive web/API deployment."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$", var.web_project_name))
    error_message = "web_project_name must be the exact Vercel project name."
  }
}

variable "worker_project_name" {
  description = "Exact Vercel project name for the isolated index worker."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$", var.worker_project_name)) &&
      var.worker_project_name != var.web_project_name
    )
    error_message = "worker_project_name must be an exact Vercel project name distinct from web_project_name."
  }
}

variable "verifier_project_name" {
  description = "Exact Vercel project name for the isolated RAG generation verifier."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$", var.verifier_project_name)) &&
      var.verifier_project_name != var.web_project_name &&
      var.verifier_project_name != var.worker_project_name
    )
    error_message = "verifier_project_name must be an exact Vercel project name distinct from web_project_name and worker_project_name."
  }
}

variable "organizer_project_name" {
  description = "Exact Vercel project name for the isolated encrypted organizer worker."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$", var.organizer_project_name)) &&
      var.organizer_project_name != var.web_project_name &&
      var.organizer_project_name != var.worker_project_name &&
      var.organizer_project_name != var.verifier_project_name
    )
    error_message = "organizer_project_name must be an exact Vercel project name distinct from web_project_name, worker_project_name, and verifier_project_name."
  }
}

variable "search_project_name" {
  description = "Exact Vercel project name for the isolated owner-search workload. Each stack trusts only this project's exact selected-environment subject; Preview requires separate state, roles, and keys."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$", var.search_project_name)) &&
      var.search_project_name != var.web_project_name &&
      var.search_project_name != var.worker_project_name &&
      var.search_project_name != var.verifier_project_name &&
      var.search_project_name != var.organizer_project_name
    )
    error_message = "search_project_name must be an exact Vercel project name distinct from web_project_name, worker_project_name, verifier_project_name, and organizer_project_name."
  }
}

variable "key_administrator_arns" {
  description = "At least two distinct dedicated human or break-glass IAM principals that administer keys and can independently recover policy control. Every ARN must belong to the current account and partition."
  type        = list(string)

  validation {
    condition = (
      length(var.key_administrator_arns) >= 2 &&
      length(distinct(var.key_administrator_arns)) == length(var.key_administrator_arns) &&
      alltrue([
        for arn in var.key_administrator_arns : can(regex("^arn:[^:]+:iam::[0-9]{12}:(?:role|user)/.+$", arn))
      ])
    )
    error_message = "Provide at least two distinct explicit IAM role/user ARNs for independent key-policy recovery."
  }
}

variable "root_key_generations" {
  description = <<-EOT
    Complete managed registry of Unfiled root-key generations. Registry IDs are immutable and
    canonical: <key_class>_<purpose>_v<generation>. Keep every previously applied entry and mark
    new entries staged, and superseded entries retired; removing an entry is intentionally blocked
    by prevent_destroy. Exactly one active generation is required for every key-class × purpose pair.
  EOT

  type = map(object({
    key_class  = string
    purpose    = string
    generation = number
    status     = string
  }))

  default = {
    ai_assisted_object_wrap_v1 = {
      key_class  = "ai_assisted"
      purpose    = "object_wrap"
      generation = 1
      status     = "active"
    }
    ai_assisted_content_mac_v1 = {
      key_class  = "ai_assisted"
      purpose    = "content_mac"
      generation = 1
      status     = "active"
    }
    private_manual_object_wrap_v1 = {
      key_class  = "private_manual"
      purpose    = "object_wrap"
      generation = 1
      status     = "active"
    }
    private_manual_content_mac_v1 = {
      key_class  = "private_manual"
      purpose    = "content_mac"
      generation = 1
      status     = "active"
    }
  }

  validation {
    condition = length(var.root_key_generations) >= 4 && alltrue([
      for generation in values(var.root_key_generations) :
      contains(["ai_assisted", "private_manual"], generation.key_class) &&
      contains(["object_wrap", "content_mac"], generation.purpose) &&
      contains(["active", "staged", "retired"], generation.status) &&
      generation.generation >= 1 &&
      generation.generation == floor(generation.generation)
    ])
    error_message = "Every root-key entry must use an allowed class, purpose, lifecycle status, and positive integer generation."
  }

  validation {
    condition = alltrue([
      for registry_id, generation in var.root_key_generations :
      registry_id == "${generation.key_class}_${generation.purpose}_v${generation.generation}"
    ])
    error_message = "Every registry ID must exactly match <key_class>_<purpose>_v<generation>; IDs are immutable after apply."
  }

  validation {
    condition = alltrue([
      for pair in [
        "ai_assisted/object_wrap",
        "ai_assisted/content_mac",
        "private_manual/object_wrap",
        "private_manual/content_mac",
        ] : length([
          for generation in values(var.root_key_generations) : generation
          if "${generation.key_class}/${generation.purpose}" == pair && generation.status == "active"
      ]) == 1
    ])
    error_message = "Exactly one active root generation is required for each of the four key-class × purpose pairs."
  }

  validation {
    condition = alltrue([
      for pair in [
        "ai_assisted/object_wrap",
        "ai_assisted/content_mac",
        "private_manual/object_wrap",
        "private_manual/content_mac",
        ] : length([
          for generation in values(var.root_key_generations) : generation
          if "${generation.key_class}/${generation.purpose}" == pair && generation.status == "staged"
      ]) <= 1
    ])
    error_message = "At most one staged root generation is allowed for each exact class/purpose pair."
  }

  validation {
    condition = alltrue([
      for generation in values(var.root_key_generations) :
      generation.status != "staged" || generation.generation > try(one([
        for candidate in values(var.root_key_generations) : candidate.generation
        if candidate.key_class == generation.key_class && candidate.purpose == generation.purpose && candidate.status == "active"
      ]), 0)
    ])
    error_message = "A staged generation must be newer than the active generation for its exact class/purpose pair."
  }

  validation {
    condition = alltrue([
      for pair in [
        "ai_assisted/object_wrap",
        "ai_assisted/content_mac",
        "private_manual/object_wrap",
        "private_manual/content_mac",
        ] : length([
          for generation in values(var.root_key_generations) : generation
          if "${generation.key_class}/${generation.purpose}" == pair && generation.status == "retired"
      ]) <= 20
    ])
    error_message = "At most 20 retired root generations may remain runtime-decryptable for each exact class/purpose pair. Define and review an archived-root lifecycle before a 21st promotion."
  }
}

variable "oidc_audience" {
  description = "Audience requested during Vercel's OIDC token exchange and trusted by AWS STS."
  type        = string
  default     = "sts.amazonaws.com"

  validation {
    condition     = var.oidc_audience == "sts.amazonaws.com"
    error_message = "Every environment policy intentionally accepts only sts.amazonaws.com."
  }
}

variable "resource_name_prefix" {
  description = "Environment-unique prefix for IAM role and AWS resource names."
  type        = string
  default     = "unfiled-production"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$", var.resource_name_prefix))
    error_message = "resource_name_prefix must be a short lowercase AWS-safe name."
  }
}

variable "kms_alias_namespace" {
  description = "Environment-unique path segment under alias/ for the four stable KMS aliases. Preview must never reuse the Production namespace."
  type        = string
  default     = "unfiled"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$", var.kms_alias_namespace))
    error_message = "kms_alias_namespace must be a short lowercase AWS KMS alias-safe path segment."
  }
}

variable "tags" {
  description = "Additional non-sensitive AWS resource tags."
  type        = map(string)
  default     = {}
}
