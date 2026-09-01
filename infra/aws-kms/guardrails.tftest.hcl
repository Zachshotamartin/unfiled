mock_provider "aws" {}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "123456789012"
    arn        = "arn:aws:iam::123456789012:role/unfiled-kms-admin"
    user_id    = "AROATEST"
  }
}

override_data {
  target = data.aws_partition.current
  values = {
    dns_suffix         = "amazonaws.com"
    id                 = "aws"
    partition          = "aws"
    reverse_dns_prefix = "com.amazonaws"
  }
}

variables {
  aws_region = "us-west-2"
  key_administrator_arns = [
    "arn:aws:iam::123456789012:role/unfiled-kms-admin",
  ]
  vercel_team_slug       = "unfiled-team"
  web_project_name       = "unfiled-web"
  worker_project_name    = "unfiled-worker"
  verifier_project_name  = "unfiled-verifier"
  organizer_project_name = "unfiled-organizer"
}

run "reject_verifier_project_identity_reuse" {
  command = plan

  variables {
    verifier_project_name = "unfiled-worker"
  }

  expect_failures = [var.verifier_project_name]
}

run "reject_organizer_project_identity_reuse" {
  command = plan

  variables {
    organizer_project_name = "unfiled-worker"
  }

  expect_failures = [var.organizer_project_name]
}

run "reject_second_active_generation" {
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
  }

  expect_failures = [var.root_key_generations]
}

run "reject_missing_active_pair" {
  command = plan

  variables {
    root_key_generations = {
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
        status     = "retired"
      }
    }
  }

  expect_failures = [var.root_key_generations]
}

run "reject_registry_pair_mismatch" {
  command = plan

  variables {
    root_key_generations = {
      ai_assisted_object_wrap_v9 = {
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
  }

  expect_failures = [var.root_key_generations]
}

run "reject_staged_generation_older_than_active" {
  command = plan

  variables {
    root_key_generations = {
      ai_assisted_object_wrap_v1 = {
        key_class  = "ai_assisted"
        purpose    = "object_wrap"
        generation = 1
        status     = "staged"
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
  }

  expect_failures = [var.root_key_generations]
}

run "reject_second_staged_generation_for_pair" {
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
      ai_assisted_object_wrap_v3 = {
        key_class  = "ai_assisted"
        purpose    = "object_wrap"
        generation = 3
        status     = "staged"
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
  }

  expect_failures = [var.root_key_generations]
}

run "reject_twenty_first_retired_generation_for_pair" {
  command = plan

  variables {
    root_key_generations = merge(
      {
        ai_assisted_object_wrap_v22 = {
          key_class  = "ai_assisted"
          purpose    = "object_wrap"
          generation = 22
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
      },
      {
        for generation in range(1, 22) : "ai_assisted_object_wrap_v${generation}" => {
          key_class  = "ai_assisted"
          purpose    = "object_wrap"
          generation = generation
          status     = "retired"
        }
      }
    )
  }

  expect_failures = [var.root_key_generations]
}

run "reject_cross_account_key_administrator" {
  command = plan

  variables {
    key_administrator_arns = [
      "arn:aws:iam::999999999999:role/unfiled-kms-admin",
    ]
  }

  expect_failures = [aws_iam_openid_connect_provider.vercel]
}

run "reject_runtime_role_as_key_administrator" {
  command = plan

  variables {
    key_administrator_arns = [
      "arn:aws:iam::123456789012:role/unfiled-production-worker",
    ]
  }

  expect_failures = [aws_iam_openid_connect_provider.vercel]
}

run "reject_organizer_role_as_key_administrator" {
  command = plan

  variables {
    key_administrator_arns = [
      "arn:aws:iam::123456789012:role/unfiled-production-organizer",
    ]
  }

  expect_failures = [aws_iam_openid_connect_provider.vercel]
}
