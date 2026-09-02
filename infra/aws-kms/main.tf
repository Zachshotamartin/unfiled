provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  runtime_role_arns = [
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_name_prefix}-web",
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_name_prefix}-worker",
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_name_prefix}-verifier",
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_name_prefix}-organizer",
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_name_prefix}-search",
  ]
  issuer_hostpath           = "oidc.vercel.com/${var.vercel_team_slug}"
  issuer_url                = "https://${local.issuer_hostpath}"
  web_subject               = "owner:${var.vercel_team_slug}:project:${var.web_project_name}:environment:${var.deployment_environment}"
  worker_subject            = "owner:${var.vercel_team_slug}:project:${var.worker_project_name}:environment:${var.deployment_environment}"
  verifier_subject          = "owner:${var.vercel_team_slug}:project:${var.verifier_project_name}:environment:${var.deployment_environment}"
  organizer_subject         = "owner:${var.vercel_team_slug}:project:${var.organizer_project_name}:environment:${var.deployment_environment}"
  search_subject            = "owner:${var.vercel_team_slug}:project:${var.search_project_name}:environment:${var.deployment_environment}"
  search_production_subject = "owner:${var.vercel_team_slug}:project:${var.search_project_name}:environment:production"
  search_preview_subject    = "owner:${var.vercel_team_slug}:project:${var.search_project_name}:environment:preview"

  encryption_context_keys = [
    "UnfiledOwnerId",
    "UnfiledKeyClass",
    "UnfiledKeyPurpose",
    "UnfiledKeyRecordId",
  ]

  required_context = {
    "kms:EncryptionContext:UnfiledOwnerId"     = "false"
    "kms:EncryptionContext:UnfiledKeyClass"    = "false"
    "kms:EncryptionContext:UnfiledKeyPurpose"  = "false"
    "kms:EncryptionContext:UnfiledKeyRecordId" = "false"
  }

  administrator_actions = [
    "kms:CancelKeyDeletion",
    "kms:CreateAlias",
    "kms:DeleteAlias",
    "kms:DescribeKey",
    "kms:DisableKey",
    "kms:DisableKeyRotation",
    "kms:EnableKey",
    "kms:EnableKeyRotation",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:ListResourceTags",
    "kms:PutKeyPolicy",
    "kms:ScheduleKeyDeletion",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:UpdateAlias",
    "kms:UpdateKeyDescription",
  ]

  common_tags = merge(var.tags, {
    Application = "unfiled"
    Environment = var.deployment_environment
    ManagedBy   = "terraform"
  })

  key_pairs = {
    ai_assisted_object_wrap = {
      alias_name      = "alias/${var.kms_alias_namespace}/ai-assisted/object-wrap"
      confidentiality = "application-encrypted"
      key_class       = "ai_assisted"
      purpose         = "object_wrap"
    }
    ai_assisted_content_mac = {
      alias_name      = "alias/${var.kms_alias_namespace}/ai-assisted/content-mac"
      confidentiality = "application-encrypted"
      key_class       = "ai_assisted"
      purpose         = "content_mac"
    }
    private_manual_object_wrap = {
      alias_name      = "alias/${var.kms_alias_namespace}/private-manual/object-wrap"
      confidentiality = "application-encrypted-private"
      key_class       = "private_manual"
      purpose         = "object_wrap"
    }
    private_manual_content_mac = {
      alias_name      = "alias/${var.kms_alias_namespace}/private-manual/content-mac"
      confidentiality = "application-encrypted-private"
      key_class       = "private_manual"
      purpose         = "content_mac"
    }
  }

  root_key_generations = {
    for registry_id, generation in var.root_key_generations : registry_id => merge(generation, {
      pair_id         = "${generation.key_class}_${generation.purpose}"
      confidentiality = local.key_pairs["${generation.key_class}_${generation.purpose}"].confidentiality
    })
  }

  active_generation_id_by_pair = {
    for pair_id, pair in local.key_pairs : pair_id => one([
      for registry_id, generation in local.root_key_generations : registry_id
      if generation.key_class == pair.key_class && generation.purpose == pair.purpose && generation.status == "active"
    ])
  }

  retired_generation_ids_by_pair = {
    for pair_id, pair in local.key_pairs : pair_id => sort([
      for registry_id, generation in local.root_key_generations : registry_id
      if generation.key_class == pair.key_class && generation.purpose == pair.purpose && generation.status == "retired"
    ])
  }

  staged_generation_ids_by_pair = {
    for pair_id, pair in local.key_pairs : pair_id => sort([
      for registry_id, generation in local.root_key_generations : registry_id
      if generation.key_class == pair.key_class && generation.purpose == pair.purpose && generation.status == "staged"
    ])
  }

  worker_generation_ids = sort([
    for registry_id, generation in local.root_key_generations : registry_id
    if generation.key_class == "ai_assisted" && generation.purpose == "object_wrap"
  ])

  ai_content_mac_generation_ids = sort([
    for registry_id, generation in local.root_key_generations : registry_id
    if generation.key_class == "ai_assisted" && generation.purpose == "content_mac"
  ])

  verifier_generation_ids = sort([
    for registry_id, generation in local.root_key_generations : registry_id
    if generation.key_class == "ai_assisted" && generation.purpose == "object_wrap"
  ])

  search_generation_ids = sort([
    for registry_id, generation in local.root_key_generations : registry_id
    if generation.key_class == "ai_assisted" && generation.purpose == "object_wrap" && generation.status != "staged"
  ])

  staged_ai_object_wrap_generation_ids = sort([
    for registry_id, generation in local.root_key_generations : registry_id
    if generation.key_class == "ai_assisted" && generation.purpose == "object_wrap" && generation.status == "staged"
  ])

  organizer_generation_ids = sort([
    for registry_id, generation in local.root_key_generations : registry_id
    if generation.key_class == "ai_assisted"
  ])

  private_generation_ids = sort([
    for registry_id, generation in local.root_key_generations : registry_id
    if generation.key_class == "private_manual"
  ])

  key_administrators_same_account = alltrue([
    for arn in var.key_administrator_arns : startswith(
      arn,
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:"
    )
  ])

  key_administrators_not_runtime_roles = alltrue([
    for arn in var.key_administrator_arns : !contains(local.runtime_role_arns, arn)
  ])

  preview_resources_are_isolated = (
    var.deployment_environment != "preview" ||
    (
      var.resource_name_prefix != "unfiled-production" &&
      var.kms_alias_namespace != "unfiled"
    )
  )
}

resource "aws_iam_openid_connect_provider" "vercel" {
  url            = local.issuer_url
  client_id_list = [var.oidc_audience]

  tags = merge(local.common_tags, {
    Name = "${var.resource_name_prefix}-vercel-oidc"
  })

  lifecycle {
    precondition {
      condition     = local.key_administrators_same_account
      error_message = "Every KMS key administrator must be an IAM user/role in the current AWS account and partition."
    }

    precondition {
      condition     = local.key_administrators_not_runtime_roles
      error_message = "Runtime roles must never be configured as KMS key administrators."
    }

    precondition {
      condition     = local.preview_resources_are_isolated
      error_message = "Preview must use non-Production resource_name_prefix and kms_alias_namespace values in its separate Terraform state."
    }
  }
}

resource "aws_iam_role" "web" {
  name                 = "${var.resource_name_prefix}-web"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ExactVercelWebEnvironmentSubject"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.vercel.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.issuer_hostpath}:aud" = var.oidc_audience
          "${local.issuer_hostpath}:sub" = local.web_subject
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name     = "${var.resource_name_prefix}-web"
    Workload = "interactive-web-api"
  })
}

resource "aws_iam_role" "worker" {
  name                 = "${var.resource_name_prefix}-worker"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ExactVercelWorkerEnvironmentSubject"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.vercel.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.issuer_hostpath}:aud" = var.oidc_audience
          "${local.issuer_hostpath}:sub" = local.worker_subject
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name     = "${var.resource_name_prefix}-worker"
    Workload = "encrypted-index-worker"
  })
}

resource "aws_iam_role" "verifier" {
  name                 = "${var.resource_name_prefix}-verifier"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ExactVercelVerifierEnvironmentSubject"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.vercel.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.issuer_hostpath}:aud" = var.oidc_audience
          "${local.issuer_hostpath}:sub" = local.verifier_subject
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name     = "${var.resource_name_prefix}-verifier"
    Workload = "rag-generation-verifier"
  })
}

resource "aws_iam_role" "organizer" {
  name                 = "${var.resource_name_prefix}-organizer"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ExactVercelOrganizerEnvironmentSubject"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.vercel.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.issuer_hostpath}:aud" = var.oidc_audience
          "${local.issuer_hostpath}:sub" = local.organizer_subject
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name     = "${var.resource_name_prefix}-organizer"
    Workload = "encrypted-organizer-worker"
  })
}

resource "aws_iam_role" "search" {
  name                 = "${var.resource_name_prefix}-search"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ExactVercelSearchEnvironmentSubject"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.vercel.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.issuer_hostpath}:aud" = var.oidc_audience
          "${local.issuer_hostpath}:sub" = local.search_subject
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name     = "${var.resource_name_prefix}-search"
    Workload = "owner-search-query"
  })
}

resource "aws_kms_key" "root" {
  for_each = local.root_key_generations

  description                        = "Unfiled ${each.value.key_class}/${each.value.purpose} generation ${each.value.generation} (${each.value.status}) per-user intermediate-key custody"
  deletion_window_in_days            = 30
  enable_key_rotation                = true
  key_usage                          = "ENCRYPT_DECRYPT"
  bypass_policy_lockout_safety_check = false

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid       = "DedicatedSameAccountKeyAdministrators"
        Effect    = "Allow"
        Principal = { AWS = var.key_administrator_arns }
        Action    = local.administrator_actions
        Resource  = "*"
        },
        {
          Sid    = "RuntimeDescribeOnly"
          Effect = "Allow"
          Principal = {
            AWS = concat(
              each.value.key_class == "ai_assisted" && each.value.purpose == "object_wrap"
              ? [aws_iam_role.web.arn, aws_iam_role.worker.arn, aws_iam_role.verifier.arn, aws_iam_role.organizer.arn]
              : each.value.key_class == "ai_assisted"
              ? [aws_iam_role.web.arn, aws_iam_role.organizer.arn]
              : [aws_iam_role.web.arn],
              each.value.key_class == "ai_assisted" && each.value.purpose == "object_wrap" && each.value.status != "staged"
              ? [aws_iam_role.search.arn]
              : []
            )
          }
          Action   = "kms:DescribeKey"
          Resource = "*"
      }],
      each.value.status == "staged" ? [] : [{
        Sid    = each.value.status == "active" ? "BoundActiveIntermediateKey" : "BoundRetiredIntermediateKeyDecryptOnly"
        Effect = "Allow"
        Principal = {
          AWS = (
            each.value.key_class == "ai_assisted" && each.value.purpose == "object_wrap"
            ? [aws_iam_role.web.arn, aws_iam_role.worker.arn, aws_iam_role.organizer.arn]
            : each.value.key_class == "ai_assisted"
            ? [aws_iam_role.web.arn, aws_iam_role.organizer.arn]
            : [aws_iam_role.web.arn]
          )
        }
        Action   = each.value.status == "active" ? ["kms:Decrypt", "kms:GenerateDataKey"] : ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = each.value.key_class
            "kms:EncryptionContext:UnfiledKeyPurpose" = each.value.purpose
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      }],
      each.value.status == "staged" || each.value.key_class != "ai_assisted" || each.value.purpose != "object_wrap" ? [] : [{
        Sid       = "VerifierDecryptAiIntermediateKey"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.verifier.arn }
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = "ai_assisted"
            "kms:EncryptionContext:UnfiledKeyPurpose" = each.value.purpose
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      }],
      each.value.status == "staged" || each.value.key_class != "ai_assisted" || each.value.purpose != "object_wrap" ? [] : [{
        Sid       = "SearchDecryptAiIndexObjectWrap"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.search.arn }
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = "ai_assisted"
            "kms:EncryptionContext:UnfiledKeyPurpose" = "object_wrap"
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      }],
      each.value.status == "staged" ? [] : [{
        Sid       = each.value.status == "active" ? "InteractiveApiReEncryptToActive" : "InteractiveApiReEncryptFromRetired"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.web.arn }
        Action    = each.value.status == "active" ? ["kms:ReEncryptTo"] : ["kms:ReEncryptFrom"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = each.value.key_class
            "kms:EncryptionContext:UnfiledKeyPurpose" = each.value.purpose
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      }]
    )
  })

  tags = merge(local.common_tags, {
    Name                 = "${var.resource_name_prefix}-${replace(each.key, "_", "-")}"
    UnfiledKeyClass      = each.value.key_class
    UnfiledKeyPurpose    = each.value.purpose
    UnfiledKeyGeneration = tostring(each.value.generation)
    UnfiledKeyStatus     = each.value.status
    Confidentiality      = each.value.confidentiality
  })

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = local.key_administrators_same_account
      error_message = "Every KMS key administrator must be an IAM user/role in the current AWS account and partition."
    }

    precondition {
      condition     = local.key_administrators_not_runtime_roles
      error_message = "Runtime roles must never be configured as KMS key administrators."
    }
  }
}

resource "aws_kms_alias" "root" {
  for_each = local.key_pairs

  name          = each.value.alias_name
  target_key_id = aws_kms_key.root[local.active_generation_id_by_pair[each.key]].key_id
}

resource "aws_iam_role_policy" "web_kms_use" {
  name = "unfiled-bound-content-key-custody"
  role = aws_iam_role.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "DescribeExplicitUnfiledKeyGenerations"
        Effect   = "Allow"
        Action   = "kms:DescribeKey"
        Resource = [for key in aws_kms_key.root : key.arn]
      }],
      [for registry_id, generation in local.root_key_generations : {
        Sid      = "Use${replace(title(replace(registry_id, "_", " ")), " ", "")}"
        Effect   = "Allow"
        Action   = generation.status == "active" ? ["kms:Decrypt", "kms:GenerateDataKey"] : ["kms:Decrypt"]
        Resource = aws_kms_key.root[registry_id].arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = generation.key_class
            "kms:EncryptionContext:UnfiledKeyPurpose" = generation.purpose
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      } if generation.status != "staged"]
    )
  })
}

resource "aws_iam_role_policy" "web_kms_rewrap" {
  name = "unfiled-interactive-root-key-rewrap"
  role = aws_iam_role.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [for registry_id, generation in local.root_key_generations : {
      Sid      = "Rewrap${replace(title(replace(registry_id, "_", " ")), " ", "")}"
      Effect   = "Allow"
      Action   = generation.status == "active" ? ["kms:ReEncryptTo"] : ["kms:ReEncryptFrom"]
      Resource = aws_kms_key.root[registry_id].arn
      Condition = {
        StringEquals = {
          "kms:EncryptionContext:UnfiledKeyClass"   = generation.key_class
          "kms:EncryptionContext:UnfiledKeyPurpose" = generation.purpose
        }
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = local.encryption_context_keys
        }
        Null = local.required_context
      }
    } if generation.status != "staged"]
  })
}

resource "aws_iam_role_policy" "worker_kms" {
  name = "unfiled-index-object-wrap-key-custody"
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "DescribeAiObjectWrapKeyGenerations"
        Effect   = "Allow"
        Action   = "kms:DescribeKey"
        Resource = [for registry_id in local.worker_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [for registry_id in local.worker_generation_ids : {
        Sid      = "Use${replace(title(replace(registry_id, "_", " ")), " ", "")}"
        Effect   = "Allow"
        Action   = local.root_key_generations[registry_id].status == "active" ? ["kms:Decrypt", "kms:GenerateDataKey"] : ["kms:Decrypt"]
        Resource = aws_kms_key.root[registry_id].arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = "ai_assisted"
            "kms:EncryptionContext:UnfiledKeyPurpose" = "object_wrap"
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      } if local.root_key_generations[registry_id].status != "staged"],
      [{
        Sid      = "DenyEveryAiContentMacGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = "kms:*"
        Resource = [for registry_id in local.ai_content_mac_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [{
        Sid      = "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = "kms:*"
        Resource = [for registry_id in local.private_generation_ids : aws_kms_key.root[registry_id].arn]
      }]
    )
  })
}

resource "aws_iam_role_policy" "verifier_kms" {
  name = "unfiled-ai-only-verification-decrypt"
  role = aws_iam_role.verifier.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "DescribeAiObjectWrapKeyGenerations"
        Effect   = "Allow"
        Action   = "kms:DescribeKey"
        Resource = [for registry_id in local.verifier_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [for registry_id in local.verifier_generation_ids : {
        Sid      = "Decrypt${replace(title(replace(registry_id, "_", " ")), " ", "")}"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.root[registry_id].arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = "ai_assisted"
            "kms:EncryptionContext:UnfiledKeyPurpose" = "object_wrap"
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      } if local.root_key_generations[registry_id].status != "staged"],
      [{
        Sid      = "DenyEveryAiContentMacGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = "kms:*"
        Resource = [for registry_id in local.ai_content_mac_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [{
        Sid      = "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = "kms:*"
        Resource = [for registry_id in local.private_generation_ids : aws_kms_key.root[registry_id].arn]
      }]
    )
  })
}

resource "aws_iam_role_policy" "organizer_kms" {
  name = "unfiled-ai-only-organizer-key-custody"
  role = aws_iam_role.organizer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "DescribeAiKeyGenerations"
        Effect   = "Allow"
        Action   = "kms:DescribeKey"
        Resource = [for registry_id in local.organizer_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [for registry_id in local.organizer_generation_ids : {
        Sid      = "Use${replace(title(replace(registry_id, "_", " ")), " ", "")}"
        Effect   = "Allow"
        Action   = local.root_key_generations[registry_id].status == "active" ? ["kms:Decrypt", "kms:GenerateDataKey"] : ["kms:Decrypt"]
        Resource = aws_kms_key.root[registry_id].arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = "ai_assisted"
            "kms:EncryptionContext:UnfiledKeyPurpose" = local.root_key_generations[registry_id].purpose
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      } if local.root_key_generations[registry_id].status != "staged"],
      [{
        Sid      = "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = "kms:*"
        Resource = [for registry_id in local.private_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [{
        Sid    = "DenyRewrapAndGrantAuthorityEvenIfAnotherPolicyChanges"
        Effect = "Deny"
        Action = [
          "kms:CreateGrant",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
        ]
        Resource = [for registry_id in local.organizer_generation_ids : aws_kms_key.root[registry_id].arn]
      }]
    )
  })
}

resource "aws_iam_role_policy" "search_kms" {
  name = "unfiled-ai-index-search-decrypt-only"
  role = aws_iam_role.search.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "DescribeActiveAndRetiredAiObjectWrapGenerations"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey"]
        Resource = [for registry_id in local.search_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [for registry_id in local.search_generation_ids : {
        Sid      = "Decrypt${replace(title(replace(registry_id, "_", " ")), " ", "")}"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.root[registry_id].arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:UnfiledKeyClass"   = "ai_assisted"
            "kms:EncryptionContext:UnfiledKeyPurpose" = "object_wrap"
          }
          "ForAllValues:StringEquals" = {
            "kms:EncryptionContextKeys" = local.encryption_context_keys
          }
          Null = local.required_context
        }
      }],
      length(local.staged_ai_object_wrap_generation_ids) == 0 ? [] : [{
        Sid      = "DenyEveryStagedAiObjectWrapGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = ["kms:*"]
        Resource = [for registry_id in local.staged_ai_object_wrap_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [{
        Sid      = "DenyEveryAiContentMacGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = ["kms:*"]
        Resource = [for registry_id in local.ai_content_mac_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [{
        Sid      = "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        Effect   = "Deny"
        Action   = ["kms:*"]
        Resource = [for registry_id in local.private_generation_ids : aws_kms_key.root[registry_id].arn]
      }],
      [{
        Sid    = "DenySearchWriteGrantRewrapAndDeletionAuthority"
        Effect = "Deny"
        Action = [
          "kms:CreateGrant",
          "kms:Encrypt",
          "kms:GenerateDataKey*",
          "kms:ReEncrypt*",
          "kms:ScheduleKeyDeletion",
        ]
        Resource = [for registry_id in local.search_generation_ids : aws_kms_key.root[registry_id].arn]
      }]
    )
  })
}
