output "vercel_oidc_provider_arn" {
  description = "AWS IAM OIDC provider trusted by the two exact production subjects."
  value       = aws_iam_openid_connect_provider.vercel.arn
}

output "web_oidc_subject" {
  description = "Exact Vercel production subject trusted by the interactive role."
  value       = local.web_subject
}

output "worker_oidc_subject" {
  description = "Exact Vercel production subject trusted by the AI-only worker role."
  value       = local.worker_subject
}

output "web_role_arn" {
  description = "Set as UNFILED_AWS_ROLE_ARN only in the interactive web/API Vercel project."
  value       = aws_iam_role.web.arn
}

output "worker_role_arn" {
  description = "Set as UNFILED_AWS_ROLE_ARN only in the isolated worker Vercel project."
  value       = aws_iam_role.worker.arn
}

output "ai_assisted_object_wrap_kms_key_arn" {
  description = "Active AI-assisted object-wrapping root ARN available to web and worker roles."
  value       = aws_kms_key.root[local.active_generation_id_by_pair["ai_assisted_object_wrap"]].arn
}

output "ai_assisted_content_mac_kms_key_arn" {
  description = "Active AI-assisted content-MAC root ARN available to web and worker roles."
  value       = aws_kms_key.root[local.active_generation_id_by_pair["ai_assisted_content_mac"]].arn
}

output "private_manual_object_wrap_kms_key_arn" {
  description = "Active private-manual object-wrapping root ARN available only to the interactive web role."
  value       = aws_kms_key.root[local.active_generation_id_by_pair["private_manual_object_wrap"]].arn
}

output "private_manual_content_mac_kms_key_arn" {
  description = "Active private-manual content-MAC root ARN available only to the interactive web role."
  value       = aws_kms_key.root[local.active_generation_id_by_pair["private_manual_content_mac"]].arn
}

output "active_root_key_arns" {
  description = "The four active root ARNs, keyed by canonical class/purpose pair, for application configuration."
  value = {
    for pair_id, registry_id in local.active_generation_id_by_pair :
    pair_id => aws_kms_key.root[registry_id].arn
  }
}

output "retired_root_key_arns" {
  description = "Retained decrypt-only root ARN sets, keyed by canonical class/purpose pair, for application allow-list configuration."
  value = {
    for pair_id, registry_ids in local.retired_generation_ids_by_pair :
    pair_id => toset([for registry_id in registry_ids : aws_kms_key.root[registry_id].arn])
  }
}

output "staged_root_key_arns" {
  description = "Describe-only candidate root ARN sets, keyed by canonical class/purpose pair, for pre-promotion readiness checks."
  value = {
    for pair_id, registry_ids in local.staged_generation_ids_by_pair :
    pair_id => toset([for registry_id in registry_ids : aws_kms_key.root[registry_id].arn])
  }
}

output "web_root_key_registry" {
  description = "Complete active, staged, and retired key registry available to the interactive web/API workload."
  value = {
    for registry_id, generation in local.root_key_generations : registry_id => {
      key_class   = generation.key_class
      purpose     = generation.purpose
      generation  = generation.generation
      status      = generation.status
      kms_key_arn = aws_kms_key.root[registry_id].arn
    }
  }
}

output "worker_root_key_registry" {
  description = "AI-assisted-only active, staged, and retired key registry available to the isolated worker; no private identifiers are included."
  value = {
    for registry_id, generation in local.root_key_generations : registry_id => {
      key_class   = generation.key_class
      purpose     = generation.purpose
      generation  = generation.generation
      status      = generation.status
      kms_key_arn = aws_kms_key.root[registry_id].arn
    } if generation.key_class == "ai_assisted"
  }
}

output "worker_retired_ai_root_registry_json" {
  description = "Exact JSON value for UNFILED_RETIRED_AI_ROOT_REGISTRY_JSON; contains retired AI-assisted roots only and no private or staged identifiers."
  value = jsonencode([
    for registry_id in sort(keys(local.root_key_generations)) : {
      arn      = aws_kms_key.root[registry_id].arn
      keyClass = local.root_key_generations[registry_id].key_class
      purpose  = local.root_key_generations[registry_id].purpose
      status   = local.root_key_generations[registry_id].status
    }
    if local.root_key_generations[registry_id].key_class == "ai_assisted" && local.root_key_generations[registry_id].status == "retired"
  ])
}

output "kms_aliases" {
  description = "Stable human-readable aliases targeting only the active key in each class/purpose pair."
  value       = { for pair_id, alias in aws_kms_alias.root : pair_id => alias.name }
}
