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

override_resource {
  target          = aws_kms_key.root["ai_assisted_object_wrap_v2"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/55555555-5555-4555-8555-555555555555"
    key_id = "55555555-5555-4555-8555-555555555555"
  }
}

override_resource {
  target          = aws_kms_key.root["ai_assisted_content_mac_v2"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/66666666-6666-4666-8666-666666666666"
    key_id = "66666666-6666-4666-8666-666666666666"
  }
}

override_resource {
  target          = aws_kms_key.root["private_manual_object_wrap_v2"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/77777777-7777-4777-8777-777777777777"
    key_id = "77777777-7777-4777-8777-777777777777"
  }
}

override_resource {
  target          = aws_kms_key.root["private_manual_content_mac_v2"]
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-west-2:123456789012:key/88888888-8888-4888-8888-888888888888"
    key_id = "88888888-8888-4888-8888-888888888888"
  }
}

variables {
  aws_region = "us-west-2"
  key_administrator_arns = [
    "arn:aws:iam::123456789012:role/unfiled-kms-admin",
  ]
  vercel_team_slug    = "unfiled-team"
  web_project_name    = "unfiled-web"
  worker_project_name = "unfiled-worker"
}

run "v1_baseline" {
  command = plan

  assert {
    condition = (
      length(aws_kms_key.root) == 4
      && alltrue([for generation in values(local.root_key_generations) : generation.generation == 1 && generation.status == "active"])
    )
    error_message = "The baseline scenario must start with four active v1 roots."
  }
}

run "stage_v2_while_v1_remains_active" {
  command = plan

  variables {
    root_key_generations = {
      ai_assisted_object_wrap_v1 = {
        key_class  = "ai_assisted"
        purpose    = "object_wrap"
        generation = 1
        status     = "active"
      }
      ai_assisted_object_wrap_v2 = {
        key_class  = "ai_assisted"
        purpose    = "object_wrap"
        generation = 2
        status     = "staged"
      }
      ai_assisted_content_mac_v1 = {
        key_class  = "ai_assisted"
        purpose    = "content_mac"
        generation = 1
        status     = "active"
      }
      ai_assisted_content_mac_v2 = {
        key_class  = "ai_assisted"
        purpose    = "content_mac"
        generation = 2
        status     = "staged"
      }
      private_manual_object_wrap_v1 = {
        key_class  = "private_manual"
        purpose    = "object_wrap"
        generation = 1
        status     = "active"
      }
      private_manual_object_wrap_v2 = {
        key_class  = "private_manual"
        purpose    = "object_wrap"
        generation = 2
        status     = "staged"
      }
      private_manual_content_mac_v1 = {
        key_class  = "private_manual"
        purpose    = "content_mac"
        generation = 1
        status     = "active"
      }
      private_manual_content_mac_v2 = {
        key_class  = "private_manual"
        purpose    = "content_mac"
        generation = 2
        status     = "staged"
      }
    }
  }

  assert {
    condition = (
      length(aws_kms_key.root) == 8
      && length([for generation in values(local.root_key_generations) : generation if generation.status == "active"]) == 4
      && length([for generation in values(local.root_key_generations) : generation if generation.status == "staged"]) == 4
      && length([for generation in values(local.root_key_generations) : generation if generation.status == "retired"]) == 0
    )
    error_message = "The preparation phase must add four staged v2 roots while all four v1 roots remain active."
  }

  assert {
    condition = alltrue([
      for pair_id, alias in aws_kms_alias.root :
      alias.target_key_id == aws_kms_key.root[local.active_generation_id_by_pair[pair_id]].key_id
      && local.root_key_generations[local.active_generation_id_by_pair[pair_id]].generation == 1
    ])
    error_message = "Staging v2 must leave every stable alias on active v1."
  }

  assert {
    condition = alltrue([
      for registry_id, generation in local.root_key_generations :
      generation.status != "staged" || (
        length(jsondecode(aws_kms_key.root[registry_id].policy).Statement) == 2
        && length(regexall("GenerateDataKey|kms:Decrypt|ReEncrypt", aws_kms_key.root[registry_id].policy)) == 0
      )
    ])
    error_message = "A staged root must be describe-only and must not permit generate, decrypt, or rewrap traffic."
  }

  assert {
    condition = (
      length([
        for statement in jsondecode(aws_iam_role_policy.worker_kms.policy).Statement : statement
        if startswith(statement.Sid, "Use")
      ]) == 2
      && length(regexall("UseAiAssistedObjectWrapV2|UseAiAssistedContentMacV2|ReEncrypt", aws_iam_role_policy.worker_kms.policy)) == 0
    )
    error_message = "The worker may describe staged AI roots for readiness but cannot use them or rewrap with them."
  }

  assert {
    condition = alltrue([
      for registry_id, generation in local.root_key_generations :
      !(generation.status == "staged" && generation.key_class == "private_manual")
      || length(regexall(aws_iam_role.worker.arn, aws_kms_key.root[registry_id].policy)) == 0
    ])
    error_message = "Private staged key policies must not identify the worker as a principal."
  }

  assert {
    condition = (
      length(output.web_root_key_registry) == 8
      && length(output.worker_root_key_registry) == 4
      && alltrue([for generation in values(output.worker_root_key_registry) : generation.key_class == "ai_assisted"])
      && alltrue([for staged_arns in values(output.staged_root_key_arns) : length(staged_arns) == 1])
    )
    error_message = "Readiness configuration must expose staged roots to web, expose only AI roots to worker, and keep private identifiers out of worker output."
  }
}

run "promote_v2_and_retire_v1" {
  command = plan

  variables {
    root_key_generations = {
      ai_assisted_object_wrap_v1 = {
        key_class  = "ai_assisted"
        purpose    = "object_wrap"
        generation = 1
        status     = "retired"
      }
      ai_assisted_object_wrap_v2 = {
        key_class  = "ai_assisted"
        purpose    = "object_wrap"
        generation = 2
        status     = "active"
      }
      ai_assisted_content_mac_v1 = {
        key_class  = "ai_assisted"
        purpose    = "content_mac"
        generation = 1
        status     = "retired"
      }
      ai_assisted_content_mac_v2 = {
        key_class  = "ai_assisted"
        purpose    = "content_mac"
        generation = 2
        status     = "active"
      }
      private_manual_object_wrap_v1 = {
        key_class  = "private_manual"
        purpose    = "object_wrap"
        generation = 1
        status     = "retired"
      }
      private_manual_object_wrap_v2 = {
        key_class  = "private_manual"
        purpose    = "object_wrap"
        generation = 2
        status     = "active"
      }
      private_manual_content_mac_v1 = {
        key_class  = "private_manual"
        purpose    = "content_mac"
        generation = 1
        status     = "retired"
      }
      private_manual_content_mac_v2 = {
        key_class  = "private_manual"
        purpose    = "content_mac"
        generation = 2
        status     = "active"
      }
    }
  }

  assert {
    condition = (
      length(aws_kms_key.root) == 8
      && length([for generation in values(local.root_key_generations) : generation if generation.status == "active"]) == 4
      && length([for generation in values(local.root_key_generations) : generation if generation.status == "retired"]) == 4
    )
    error_message = "The staged v1→v2 registry must retain four retired v1 roots and add exactly four active v2 roots."
  }

  assert {
    condition = alltrue([
      for pair_id, alias in aws_kms_alias.root :
      alias.target_key_id == aws_kms_key.root[local.active_generation_id_by_pair[pair_id]].key_id
      && local.root_key_generations[local.active_generation_id_by_pair[pair_id]].generation == 2
    ])
    error_message = "Every stable alias must move to its exact active v2 root."
  }

  assert {
    condition = alltrue([
      for registry_id, generation in local.root_key_generations :
      generation.status != "active" || (
        toset(jsondecode(aws_kms_key.root[registry_id].policy).Statement[2].Action) == toset(["kms:Decrypt", "kms:GenerateDataKey"])
        && toset(jsondecode(aws_kms_key.root[registry_id].policy).Statement[3].Action) == toset(["kms:ReEncryptTo"])
      )
    ])
    error_message = "Only active v2 roots may generate data keys and accept root rewraps."
  }

  assert {
    condition = alltrue([
      for registry_id, generation in local.root_key_generations :
      generation.status != "retired" || (
        toset(jsondecode(aws_kms_key.root[registry_id].policy).Statement[2].Action) == toset(["kms:Decrypt"])
        && toset(jsondecode(aws_kms_key.root[registry_id].policy).Statement[3].Action) == toset(["kms:ReEncryptFrom"])
      )
    ])
    error_message = "Retired v1 roots must remain decrypt-only and may only be rewrap sources for the web role."
  }

  assert {
    condition = (
      length(regexall("ReEncrypt", aws_iam_role_policy.worker_kms.policy)) == 0
      && toset(one([
        for statement in jsondecode(aws_iam_role_policy.worker_kms.policy).Statement : statement
        if statement.Sid == "DescribeAiAssistedKeyGenerations"
        ]).Resource) == toset([
        aws_kms_key.root["ai_assisted_object_wrap_v1"].arn,
        aws_kms_key.root["ai_assisted_object_wrap_v2"].arn,
        aws_kms_key.root["ai_assisted_content_mac_v1"].arn,
        aws_kms_key.root["ai_assisted_content_mac_v2"].arn,
      ])
    )
    error_message = "The worker must decrypt active+retired AI roots but must never receive rewrap authority."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(aws_iam_role_policy.worker_kms.policy).Statement : statement
      if statement.Sid == "DenyEveryPrivateManualGenerationEvenIfAnotherPolicyChanges"
      ]).Resource) == toset([
      aws_kms_key.root["private_manual_object_wrap_v1"].arn,
      aws_kms_key.root["private_manual_object_wrap_v2"].arn,
      aws_kms_key.root["private_manual_content_mac_v1"].arn,
      aws_kms_key.root["private_manual_content_mac_v2"].arn,
    ])
    error_message = "The worker explicit deny must expand to every private-manual generation."
  }

  assert {
    condition = alltrue([
      for pair_id, retired_arns in output.retired_root_key_arns :
      length(retired_arns) == 1
      && contains(retired_arns, aws_kms_key.root[local.retired_generation_ids_by_pair[pair_id][0]].arn)
    ])
    error_message = "The staged app configuration must expose each retained v1 ARN as retired."
  }

  assert {
    condition = (
      length(output.web_root_key_registry) == 8
      && length(output.worker_root_key_registry) == 4
      && alltrue([for generation in values(output.worker_root_key_registry) : generation.key_class == "ai_assisted"])
      && length(jsondecode(output.worker_retired_ai_root_registry_json)) == 2
      && alltrue([
        for generation in jsondecode(output.worker_retired_ai_root_registry_json) :
        generation.keyClass == "ai_assisted"
        && generation.status == "retired"
        && contains(["object_wrap", "content_mac"], generation.purpose)
        && startswith(generation.arn, "arn:aws:kms:us-west-2:123456789012:key/")
      ])
    )
    error_message = "Application registries must expose all web roots and exact AI-only worker configuration without leaking private or staged identifiers."
  }
}
