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
  ]
  vercel_team_slug      = "unfiled-team"
  web_project_name      = "unfiled-web"
  worker_project_name   = "unfiled-worker"
  verifier_project_name = "unfiled-verifier"
}

run "four_active_roots_and_exact_workload_boundary" {
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
      && length([
        for statement in jsondecode(aws_kms_key.root[registry_id].policy).Statement : statement
        if length(regexall("arn:aws:iam::123456789012:root", jsonencode(statement))) > 0
      ]) == 0
    ])
    error_message = "Every key must keep the KMS lockout safety check and must not delegate policy control to account root."
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
    condition = alltrue([
      for retired_arns in values(output.retired_root_key_arns) : length(retired_arns) == 0
    ])
    error_message = "The initial v1 registry must not report retired keys."
  }
}
