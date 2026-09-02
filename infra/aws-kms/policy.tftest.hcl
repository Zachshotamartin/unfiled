mock_provider "aws" {}

override_data {
  target          = data.aws_caller_identity.current
  override_during = plan
  values = {
    account_id = "123456789012"
    arn        = "arn:aws:iam::123456789012:role/unfiled-kms-admin"
    user_id    = "AROATEST"
  }
}

override_data {
  target          = data.aws_partition.current
  override_during = plan
  values = {
    dns_suffix         = "amazonaws.com"
    id                 = "aws"
    partition          = "aws"
    reverse_dns_prefix = "com.amazonaws"
  }
}

override_resource {
  target          = aws_iam_openid_connect_provider.vercel
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/unfiled-team"
  }
}

override_resource {
  target          = aws_iam_role.web
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/unfiled-production-web"
    id  = "unfiled-production-web"
  }
}

override_resource {
  target          = aws_iam_role.worker
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/unfiled-production-worker"
    id  = "unfiled-production-worker"
  }
}

override_resource {
  target          = aws_iam_role.verifier
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/unfiled-production-verifier"
    id  = "unfiled-production-verifier"
  }
}

override_resource {
  target          = aws_iam_role.organizer
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/unfiled-production-organizer"
    id  = "unfiled-production-organizer"
  }
}

override_resource {
  target          = aws_iam_role.search
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/unfiled-production-search"
    id  = "unfiled-production-search"
  }
}

override_resource {
  target          = aws_kms_key.root["ai_assisted_object_wrap_v1"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111"
    key_id = "11111111-1111-4111-8111-111111111111"
  }
}

override_resource {
  target          = aws_kms_key.root["ai_assisted_content_mac_v1"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/22222222-2222-4222-8222-222222222222"
    key_id = "22222222-2222-4222-8222-222222222222"
  }
}

override_resource {
  target          = aws_kms_key.root["private_manual_object_wrap_v1"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/33333333-3333-4333-8333-333333333333"
    key_id = "33333333-3333-4333-8333-333333333333"
  }
}

override_resource {
  target          = aws_kms_key.root["private_manual_content_mac_v1"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/44444444-4444-4444-8444-444444444444"
    key_id = "44444444-4444-4444-8444-444444444444"
  }
}

variables {
  aws_region = "us-west-2"
  key_administrator_arns = [
    "arn:aws:iam::123456789012:role/unfiled-kms-admin",
    "arn:aws:iam::123456789012:role/unfiled-kms-recovery",
  ]
  vercel_team_slug       = "unfiled-team"
  web_project_name       = "unfiled-web"
  worker_project_name    = "unfiled-worker"
  verifier_project_name  = "unfiled-verifier"
  organizer_project_name = "unfiled-organizer"
  search_project_name    = "unfiled-search"
}

run "four_active_roots_and_five_exact_workload_boundaries" {
  command = plan

  assert {
    condition     = length(aws_kms_key.root) == 4
    error_message = "The baseline must contain exactly four independently controlled active v1 roots."
  }

  assert {
    condition = toset([for alias in aws_kms_alias.root : alias.name]) == toset([
      "alias/unfiled/ai-assisted/object-wrap",
      "alias/unfiled/ai-assisted/content-mac",
      "alias/unfiled/private-manual/object-wrap",
      "alias/unfiled/private-manual/content-mac",
    ])
    error_message = "Every class/purpose pair must retain its exact stable KMS alias."
  }

  assert {
    condition = (
      output.web_oidc_subject == "owner:unfiled-team:project:unfiled-web:environment:production"
      && output.worker_oidc_subject == "owner:unfiled-team:project:unfiled-worker:environment:production"
      && output.verifier_oidc_subject == "owner:unfiled-team:project:unfiled-verifier:environment:production"
      && output.organizer_oidc_subject == "owner:unfiled-team:project:unfiled-organizer:environment:production"
      && output.search_oidc_subject == "owner:unfiled-team:project:unfiled-search:environment:production"
      && output.search_production_oidc_subject == "owner:unfiled-team:project:unfiled-search:environment:production"
      && output.search_preview_oidc_subject == "owner:unfiled-team:project:unfiled-search:environment:preview"
      && output.search_oidc_audience == "sts.amazonaws.com"
      && output.stack_deployment_environment == "production"
      && output.kms_alias_namespace == "unfiled"
    )
    error_message = "OIDC trust must stay pinned to the exact, distinct production project names."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.worker.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:aud"] == "sts.amazonaws.com"
      && jsondecode(aws_iam_role.worker.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:sub"] == output.worker_oidc_subject
      && jsondecode(aws_iam_role.web.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:sub"] == output.web_oidc_subject
      && jsondecode(aws_iam_role.verifier.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:aud"] == "sts.amazonaws.com"
      && jsondecode(aws_iam_role.verifier.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:sub"] == output.verifier_oidc_subject
      && jsondecode(aws_iam_role.organizer.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:aud"] == "sts.amazonaws.com"
      && jsondecode(aws_iam_role.organizer.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:sub"] == output.organizer_oidc_subject
      && jsondecode(aws_iam_role.search.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:aud"] == "sts.amazonaws.com"
      && jsondecode(aws_iam_role.search.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:sub"] == output.search_oidc_subject
      && jsondecode(aws_iam_role.search.assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:sub"] != output.search_preview_oidc_subject
      && length(keys(jsondecode(aws_iam_role.search.assume_role_policy).Statement[0].Condition.StringEquals)) == 2
      && length(regexall("environment:preview|StringLike", aws_iam_role.search.assume_role_policy)) == 0
      && alltrue([
        for policy in [
          aws_iam_role.web.assume_role_policy,
          aws_iam_role.worker.assume_role_policy,
          aws_iam_role.verifier.assume_role_policy,
          aws_iam_role.organizer.assume_role_policy,
          aws_iam_role.search.assume_role_policy,
        ] : length(regexall("environment:preview|StringLike", policy)) == 0
      ])
    )
    error_message = "AWS role trust must keep the fixed STS audience and exact Vercel subjects."
  }

  assert {
    condition = alltrue([
      for registry_id, generation in local.root_key_generations :
      aws_kms_key.root[registry_id].bypass_policy_lockout_safety_check == false
      && length([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "DedicatedSameAccountKeyAdministrators"
      ]) == 1
      && toset(one([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "DedicatedSameAccountKeyAdministrators"
      ]).Principal.AWS) == toset(var.key_administrator_arns)
      && length(one([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "DedicatedSameAccountKeyAdministrators"
      ]).Principal.AWS) >= 2
      && length([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if length(regexall("arn:aws:iam::123456789012:root", jsonencode(statement))) > 0
      ]) == 0
    ])
    error_message = "Every key must keep the KMS lockout safety check, name the complete two-or-more-principal recovery set, and never delegate policy control to account root."
  }

  assert {
    condition = alltrue([
      for registry_id, generation in local.root_key_generations :
      one([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "BoundActiveIntermediateKey"
      ]).Condition.StringEquals["kms:EncryptionContext:UnfiledKeyClass"] == generation.key_class
      && one([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "BoundActiveIntermediateKey"
      ]).Condition.StringEquals["kms:EncryptionContext:UnfiledKeyPurpose"] == generation.purpose
      && toset(one([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "BoundActiveIntermediateKey"
      ]).Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"]) == toset(local.encryption_context_keys)
      && toset(one([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "BoundActiveIntermediateKey"
      ]).Action) == toset(["kms:Decrypt", "kms:GenerateDataKey"])
      && toset(one([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if statement.Sid == "InteractiveApiReEncryptToActive"
      ]).Action) == toset(["kms:ReEncryptTo"])
    ])
    error_message = "Every active root must pin one pair and exact context, allow data-key generation/decrypt, and permit only web-target rewrap."
  }

  assert {
    condition = (
      length([for statement in jsondecode(aws_iam_role_policy.verifier_kms.policy).Statement : statement if startswith(statement.Sid, "Decrypt")]) == 1
      && length(regexall("GenerateDataKey|ReEncrypt", aws_iam_role_policy.verifier_kms.policy)) == 0
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.verifier_kms.policy).Statement : statement
        if statement.Sid == "DescribeAiObjectWrapKeyGenerations"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_object_wrap_v1"].arn,
      ])
      && length(regexall(aws_iam_role.verifier.arn, aws_kms_key.root["ai_assisted_object_wrap_v1"].policy)) > 0
      && length(regexall(aws_iam_role.verifier.arn, aws_kms_key.root["ai_assisted_content_mac_v1"].policy)) == 0
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.verifier_kms.policy).Statement : statement
        if statement.Sid == "DenyEveryAiContentMacGenerationEvenIfAnotherPolicyChanges"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_content_mac_v1"].arn,
      ])
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.verifier_kms.policy).Statement : statement
        if statement.Sid == "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        ]).Resource) == toset([
        aws_kms_key.root["private_manual_object_wrap_v1"].arn,
        aws_kms_key.root["private_manual_content_mac_v1"].arn,
      ])
      && length(output.verifier_root_key_registry) == 1
      && alltrue([for generation in values(output.verifier_root_key_registry) : generation.key_class == "ai_assisted" && generation.purpose == "object_wrap"])
      && jsondecode(output.verifier_retired_ai_object_wrap_roots_json) == []
    )
    error_message = "The verifier must be AI object-wrap-only and decrypt-only, explicitly deny content-MAC/private roots, and receive no generate or rewrap authority."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.worker_kms.policy).Statement : statement
        if statement.Sid == "DescribeAiObjectWrapKeyGenerations"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_object_wrap_v1"].arn,
      ])
      && length([
        for statement in jsondecode(aws_iam_role_policy.worker_kms.policy).Statement : statement
        if startswith(statement.Sid, "Use")
        && statement.Condition.StringEquals["kms:EncryptionContext:UnfiledKeyPurpose"] == "object_wrap"
      ]) == 1
      && length(regexall(aws_iam_role.worker.arn, aws_kms_key.root["ai_assisted_content_mac_v1"].policy)) == 0
      && length(regexall("ReEncrypt", aws_iam_role_policy.worker_kms.policy)) == 0
    )
    error_message = "The index worker may use only AI-assisted object-wrap generations and must never receive content-MAC or root-rewrap authority."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.worker_kms.policy).Statement : statement
        if statement.Sid == "DenyEveryAiContentMacGenerationEvenIfAnotherPolicyChanges"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_content_mac_v1"].arn,
      ])
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.worker_kms.policy).Statement : statement
        if statement.Sid == "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        ]).Resource) == toset([
        aws_kms_key.root["private_manual_object_wrap_v1"].arn,
        aws_kms_key.root["private_manual_content_mac_v1"].arn,
      ])
    )
    error_message = "The worker must explicitly deny every AI content-MAC and private-manual generation."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.organizer_kms.policy).Statement : statement
        if statement.Sid == "DescribeAiKeyGenerations"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_object_wrap_v1"].arn,
        aws_kms_key.root["ai_assisted_content_mac_v1"].arn,
      ])
      && length([
        for statement in jsondecode(aws_iam_role_policy.organizer_kms.policy).Statement : statement
        if startswith(statement.Sid, "Use")
        && toset(statement.Action) == toset(["kms:Decrypt", "kms:GenerateDataKey"])
        && statement.Condition.StringEquals["kms:EncryptionContext:UnfiledKeyClass"] == "ai_assisted"
        && contains(["object_wrap", "content_mac"], statement.Condition.StringEquals["kms:EncryptionContext:UnfiledKeyPurpose"])
        && toset(statement.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"]) == toset(local.encryption_context_keys)
      ]) == 2
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.organizer_kms.policy).Statement : statement
        if statement.Sid == "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        ]).Resource) == toset([
        aws_kms_key.root["private_manual_object_wrap_v1"].arn,
        aws_kms_key.root["private_manual_content_mac_v1"].arn,
      ])
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.organizer_kms.policy).Statement : statement
        if statement.Sid == "DenyRewrapAndGrantAuthorityEvenIfAnotherPolicyChanges"
      ]).Action) == toset(["kms:CreateGrant", "kms:ReEncryptFrom", "kms:ReEncryptTo"])
      && length(output.organizer_root_key_registry) == 2
      && alltrue([for generation in values(output.organizer_root_key_registry) : generation.key_class == "ai_assisted"])
      && jsondecode(output.organizer_retired_ai_object_wrap_roots_json) == []
      && jsondecode(output.organizer_retired_ai_content_mac_roots_json) == []
      && length(regexall(aws_iam_role.organizer.arn, aws_kms_key.root["ai_assisted_object_wrap_v1"].policy)) > 0
      && length(regexall(aws_iam_role.organizer.arn, aws_kms_key.root["ai_assisted_content_mac_v1"].policy)) > 0
      && length(regexall(aws_iam_role.organizer.arn, aws_kms_key.root["private_manual_object_wrap_v1"].policy)) == 0
      && length(regexall(aws_iam_role.organizer.arn, aws_kms_key.root["private_manual_content_mac_v1"].policy)) == 0
    )
    error_message = "The organizer must use only context-bound AI object-wrap/content-MAC roots, explicitly deny private roots and rewrap/grant authority, and receive no private identifier."
  }

  assert {
    condition = (
      output.search_role_arn == aws_iam_role.search.arn
      && output.search_role_arn != output.web_role_arn
      && output.search_role_arn != output.worker_role_arn
      && output.search_role_arn != output.verifier_role_arn
      && output.search_role_arn != output.organizer_role_arn
      && output.search_ai_object_wrap_kms_key_arn == aws_kms_key.root["ai_assisted_object_wrap_v1"].arn
      && output.search_cloud_environment == {
        UNFILED_AWS_REGION                               = "us-west-2"
        UNFILED_SEARCH_ENV                               = "production"
        UNFILED_SEARCH_PROJECT_TEAM_SLUG                 = "unfiled-team"
        UNFILED_SEARCH_PROJECT_NAME                      = "unfiled-search"
        UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT             = output.search_oidc_subject
        UNFILED_SEARCH_AWS_ROLE_ARN                      = aws_iam_role.search.arn
        UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN        = aws_kms_key.root["ai_assisted_object_wrap_v1"].arn
        UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON = "[]"
      }
      && toset(flatten([
        for statement in jsondecode(aws_iam_role_policy.search_kms.policy).Statement : statement.Action
        if statement.Effect == "Allow"
      ])) == toset(["kms:Decrypt", "kms:DescribeKey"])
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.search_kms.policy).Statement : statement
        if statement.Sid == "DescribeActiveAndRetiredAiObjectWrapGenerations"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_object_wrap_v1"].arn,
      ])
      && length([
        for statement in jsondecode(aws_iam_role_policy.search_kms.policy).Statement : statement
        if startswith(statement.Sid, "Decrypt")
        && toset(statement.Action) == toset(["kms:Decrypt"])
        && statement.Condition.StringEquals["kms:EncryptionContext:UnfiledKeyClass"] == "ai_assisted"
        && statement.Condition.StringEquals["kms:EncryptionContext:UnfiledKeyPurpose"] == "object_wrap"
        && toset(statement.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"]) == toset(local.encryption_context_keys)
      ]) == 1
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.search_kms.policy).Statement : statement
        if statement.Sid == "DenyEveryAiContentMacGenerationEvenIfAnotherPolicyChanges"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_content_mac_v1"].arn,
      ])
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.search_kms.policy).Statement : statement
        if statement.Sid == "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
        ]).Resource) == toset([
        aws_kms_key.root["private_manual_object_wrap_v1"].arn,
        aws_kms_key.root["private_manual_content_mac_v1"].arn,
      ])
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.search_kms.policy).Statement : statement
        if statement.Sid == "DenySearchWriteGrantRewrapAndDeletionAuthority"
        ]).Action) == toset([
        "kms:CreateGrant",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:ReEncrypt*",
        "kms:ScheduleKeyDeletion",
      ])
      && length(output.search_root_key_registry) == 1
      && alltrue([
        for generation in values(output.search_root_key_registry) :
        generation.key_class == "ai_assisted"
        && generation.purpose == "object_wrap"
        && contains(["active", "retired"], generation.status)
      ])
      && jsondecode(output.search_retired_ai_object_wrap_roots_json) == []
      && length([
        for statement in jsondecode(aws_kms_key.root["ai_assisted_object_wrap_v1"].policy).Statement : statement
        if statement.Sid == "SearchDecryptAiIndexObjectWrap"
      ]) == 1
      && alltrue([
        for statement in jsondecode(aws_kms_key.root["ai_assisted_object_wrap_v1"].policy).Statement : (
          toset(keys(statement)) == toset(["Sid", "Effect", "Principal", "Action", "Resource", "Condition"])
          && statement.Effect == "Allow"
          && length(keys(statement.Principal)) == 1
          && statement.Principal.AWS == aws_iam_role.search.arn
          && length(statement.Action) == 1
          && toset(statement.Action) == toset(["kms:Decrypt"])
          && statement.Resource == "*"
          && toset(keys(statement.Condition)) == toset(["StringEquals", "ForAllValues:StringEquals", "Null"])
          && length(keys(statement.Condition.StringEquals)) == 2
          && statement.Condition.StringEquals["kms:EncryptionContext:UnfiledKeyClass"] == "ai_assisted"
          && statement.Condition.StringEquals["kms:EncryptionContext:UnfiledKeyPurpose"] == "object_wrap"
          && length(keys(statement.Condition["ForAllValues:StringEquals"])) == 1
          && toset(statement.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"]) == toset(local.encryption_context_keys)
          && statement.Condition.Null == local.required_context
        ) if statement.Sid == "SearchDecryptAiIndexObjectWrap"
      ])
      && length(regexall(aws_iam_role.search.arn, aws_kms_key.root["ai_assisted_content_mac_v1"].policy)) == 0
      && length(regexall(aws_iam_role.search.arn, aws_kms_key.root["private_manual_object_wrap_v1"].policy)) == 0
      && length(regexall(aws_iam_role.search.arn, aws_kms_key.root["private_manual_content_mac_v1"].policy)) == 0
    )
    error_message = "Owner search must be a distinct exact-Production identity with context-bound decrypt/describe only on active AI object-wrap, explicit write/grant/rewrap/deletion and non-index-root denials, and no Preview trust."
  }

  assert {
    condition = alltrue([
      for retired_arns in values(output.retired_root_key_arns) : length(retired_arns) == 0
    ])
    error_message = "The initial v1 registry must not report retired keys."
  }
}

run "preview_stack_trusts_only_exact_preview_subjects_with_separate_resources" {
  command = plan

  variables {
    deployment_environment = "preview"
    resource_name_prefix   = "unfiled-preview"
    kms_alias_namespace    = "unfiled-preview"
  }

  assert {
    condition = (
      output.stack_deployment_environment == "preview"
      && output.kms_alias_namespace == "unfiled-preview"
      && output.web_oidc_subject == "owner:unfiled-team:project:unfiled-web:environment:preview"
      && output.worker_oidc_subject == "owner:unfiled-team:project:unfiled-worker:environment:preview"
      && output.verifier_oidc_subject == "owner:unfiled-team:project:unfiled-verifier:environment:preview"
      && output.organizer_oidc_subject == "owner:unfiled-team:project:unfiled-organizer:environment:preview"
      && output.search_oidc_subject == output.search_preview_oidc_subject
      && output.search_oidc_subject != output.search_production_oidc_subject
    )
    error_message = "A Preview stack must bind all five shared Vercel projects to their exact Preview subjects only."
  }

  assert {
    condition = (
      alltrue([
        for binding in [
          { policy = aws_iam_role.web.assume_role_policy, subject = output.web_oidc_subject },
          { policy = aws_iam_role.worker.assume_role_policy, subject = output.worker_oidc_subject },
          { policy = aws_iam_role.verifier.assume_role_policy, subject = output.verifier_oidc_subject },
          { policy = aws_iam_role.organizer.assume_role_policy, subject = output.organizer_oidc_subject },
          { policy = aws_iam_role.search.assume_role_policy, subject = output.search_oidc_subject },
          ] : (
          jsondecode(binding.policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:aud"] == "sts.amazonaws.com"
          && jsondecode(binding.policy).Statement[0].Condition.StringEquals["oidc.vercel.com/unfiled-team:sub"] == binding.subject
          && length(keys(jsondecode(binding.policy).Statement[0].Condition.StringEquals)) == 2
          && length(regexall("environment:production|StringLike", binding.policy)) == 0
        )
      ])
    )
    error_message = "Every Preview role must trust only its exact Preview subject and fixed STS audience, never Production or a wildcard."
  }

  assert {
    condition = (
      aws_iam_role.web.name == "unfiled-preview-web"
      && aws_iam_role.worker.name == "unfiled-preview-worker"
      && aws_iam_role.verifier.name == "unfiled-preview-verifier"
      && aws_iam_role.organizer.name == "unfiled-preview-organizer"
      && aws_iam_role.search.name == "unfiled-preview-search"
      && alltrue([for key in aws_kms_key.root : key.tags.Environment == "preview"])
      && toset([for alias in aws_kms_alias.root : alias.name]) == toset([
        "alias/unfiled-preview/ai-assisted/object-wrap",
        "alias/unfiled-preview/ai-assisted/content-mac",
        "alias/unfiled-preview/private-manual/object-wrap",
        "alias/unfiled-preview/private-manual/content-mac",
      ])
    )
    error_message = "Preview must use environment-unique role names, tags, aliases, and therefore separately instantiated KMS keys/state."
  }

  assert {
    condition = (
      output.search_cloud_environment.UNFILED_SEARCH_ENV == "preview"
      && output.search_cloud_environment.UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT == output.search_preview_oidc_subject
      && output.search_cloud_environment.UNFILED_SEARCH_AWS_ROLE_ARN == aws_iam_role.search.arn
      && output.search_cloud_environment.UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN == aws_kms_key.root["ai_assisted_object_wrap_v1"].arn
      && output.search_cloud_environment.UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON == "[]"
      && length(output.search_cloud_environment) == 8
    )
    error_message = "Preview owner search must receive only its exact isolated identity/KMS environment contract."
  }
}
