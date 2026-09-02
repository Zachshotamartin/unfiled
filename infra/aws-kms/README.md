# Unfiled KMS and workload identities

This Terraform root is one environment's custody boundary for Unfiled's per-user intermediate keys. It defaults to Production and creates five distinct Vercel OIDC workload roles—web, index worker, verifier, organizer, and owner search—and independently managed AWS KMS root generations for every key-class × purpose pair. Instantiate it again with separate state and names for Preview. Unfiled still uses exactly five Vercel projects total: each environment-specific AWS role trusts the matching environment subject from the same project.

## Security contract

The four Production aliases are:

- `alias/unfiled/ai-assisted/object-wrap`
- `alias/unfiled/ai-assisted/content-mac`
- `alias/unfiled/private-manual/object-wrap`
- `alias/unfiled/private-manual/content-mac`

Aliases are derived from `kms_alias_namespace`. A separately instantiated Preview stack uses an environment-unique namespace such as `unfiled-preview`; it never retargets a Production alias.

The `root_key_generations` registry is append-only after first apply. Its canonical IDs have the form `<key_class>_<purpose>_v<generation>`. Exactly one generation per pair is active, and every alias targets that active generation.

| Generation status | Alias target | `GenerateDataKey`          | `Decrypt`                  | Web root rewrap | Index worker access             | Verifier access              | Organizer access                  | Owner-search access                  |
| ----------------- | ------------ | -------------------------- | -------------------------- | --------------- | ------------------------------- | ---------------------------- | --------------------------------- | ------------------------------------ |
| `staged`          | No           | Denied                     | Denied                     | Denied          | Describe AI object-wrap only    | Describe AI object-wrap only | Describe both AI purposes only    | Denied, including `DescribeKey`      |
| `active`          | Yes          | Allowed with exact context | Allowed with exact context | `ReEncryptTo`   | Generate/decrypt AI object-wrap | Decrypt AI object-wrap       | Generate/decrypt both AI purposes | Decrypt/describe AI object-wrap only |
| `retired`         | No           | Denied                     | Allowed with exact context | `ReEncryptFrom` | Decrypt AI object-wrap          | Decrypt AI object-wrap       | Decrypt both AI purposes          | Decrypt/describe AI object-wrap only |

AI content-MAC and private-manual generations never name the index worker as a key-policy principal and never appear in its filtered registry. Its IAM policy explicitly denies every AI content-MAC and private-manual generation. The verifier receives no `GenerateDataKey`, `ReEncryptFrom`, or `ReEncryptTo`; it can only decrypt active or retired AI object-wrap intermediate keys while validating a shadow generation.

The organizer is a fourth, independently attributable workload. Its exact environment OIDC subject can generate/decrypt active and decrypt retired AI-assisted object-wrap and content-MAC roots because atomic encrypted decisions, Review payloads, receipts, and note writes need both purposes. It can only describe staged AI roots. Its registry excludes every private-manual identifier, its IAM policy explicitly denies every private-manual generation, and explicit denies prevent grant creation and root rewrap even if another identity policy changes. It has no key-administration or index/verifier authority.

Owner search is a fifth, independently attributable workload. Its exact selected-environment OIDC subject may decrypt and describe only active or retired AI-assisted object-wrap roots so it can open already-built encrypted index documents. It cannot see staged roots and cannot generate data keys, encrypt, re-encrypt, create grants, schedule key deletion, use content-MAC/private-manual roots, or access provider/BYOK credentials. Each role trust contains one exact subject and the fixed STS audience: Production omits Preview, and Preview omits Production. The two deployments must never share a role, KMS root, alias namespace, runtime value, or Terraform state.

Every cryptographic permission is bound to exactly these non-secret encryption-context fields:

- `UnfiledOwnerId`
- `UnfiledKeyClass`
- `UnfiledKeyPurpose`
- `UnfiledKeyRecordId`

The key policy does **not** contain the usual account-root delegation statement. Only the explicit, same-account `key_administrator_arns` can recover or change a key policy. Terraform requires at least two distinct administrator ARNs so one deleted or inaccessible principal does not become the sole recovery path. `bypass_policy_lockout_safety_check` is fixed to `false`, so AWS rejects key creation if the applying principal cannot retain `kms:PutKeyPolicy` through the resulting policy. Never bypass that failure.

Every KMS key has `lifecycle.prevent_destroy = true`, a 30-day deletion window, and AWS-managed cryptographic key-material rotation enabled. Removing or renaming an applied registry entry therefore fails planning instead of scheduling destruction. Application-level generations remain separate from AWS's transparent annual key-material rotation.

## Before the first apply

1. Create at least two distinct, independently controlled, monitored KMS administrator or break-glass principals in the target account. Dedicated recovery roles are recommended. Terraform rejects a single ARN or duplicate ARNs; do not use any runtime role.
2. Assume one of the listed administrator principals for the first apply. That session also needs identity permissions to create the IAM/OIDC/KMS resources in this root. Confirm it with `aws sts get-caller-identity`.
3. In the five Vercel projects—web, index worker, verifier, organizer, and owner search—enable **Team Issuer** under Settings → Security → OIDC. Do not create another search project for Preview; the same search project emits distinct exact `production` and `preview` subjects.
4. Copy `terraform.tfvars.example` to the ignored environment-specific tfvars file. Replace the account, region, exact Vercel team slug, all five exact project names, administrator ARNs, and tags. Persist the entire generation registry in reviewed configuration; do not rely on memory of its default.
5. Configure a distinct encrypted, access-controlled remote Terraform backend with locking for each environment before apply. Backend configuration is account-specific and intentionally is not checked in here.
6. Do not create static AWS access keys for any Vercel runtime role. Vercel OIDC is the only runtime AWS authentication path.

### Production and Preview isolation

The Production stack keeps the checked-in defaults:

```hcl
deployment_environment = "production"
resource_name_prefix   = "unfiled-production"
kms_alias_namespace    = "unfiled"
```

Instantiate Preview from the same Terraform source with a different backend/state and at least these overrides:

```hcl
deployment_environment = "preview"
resource_name_prefix   = "unfiled-preview"
kms_alias_namespace    = "unfiled-preview"
```

Use the same five exact `*_project_name` values in both stacks. The Preview values above create different IAM role names, KMS keys, aliases, and tags while binding trust to only the exact Preview subjects. Terraform rejects Preview if either Production naming default is reused. Because an IAM OIDC provider URL can be registered only once per AWS account and this root owns that provider, use a separate Preview AWS account when applying both complete stacks. Never import or manage one provider from two Terraform states. If a future shared bootstrap stack owns the provider instead, refactor this root explicitly and review that state migration before using one account.

If `oidc.vercel.com/<team-slug>` is already registered in the account, import it instead of creating a duplicate:

```sh
terraform import aws_iam_openid_connect_provider.vercel arn:aws:iam::<account-id>:oidc-provider/oidc.vercel.com/<team-slug>
```

If AWS reports that a new key policy would not allow a future `PutKeyPolicy`, stop. Assume a principal listed in `key_administrator_arns` or correct the administrator list. Do not set the bypass flag and do not restore account-root delegation.

## Validate and apply

Use Terraform 1.13.3, matching CI, and the committed AWS-provider lock file:

```sh
terraform init
terraform fmt -check -recursive
terraform validate
terraform test
terraform plan -out unfiled-kms.tfplan
terraform show unfiled-kms.tfplan
terraform apply unfiled-kms.tfplan
terraform output
```

Reject any initial plan that contains anything other than the expected OIDC provider, five runtime roles and policies, four v1 KMS keys, and four stable aliases. On every later plan, reject any KMS-key destroy or replacement.

## Application configuration

The four existing scalar outputs always resolve to the active roots:

- `ai_assisted_object_wrap_kms_key_arn`
- `ai_assisted_content_mac_kms_key_arn`
- `private_manual_object_wrap_kms_key_arn`
- `private_manual_content_mac_kms_key_arn`

The rotation-aware outputs are:

- `active_root_key_arns`: exactly one active ARN per pair;
- `staged_root_key_arns`: zero or one describe-only candidate ARN per pair;
- `retired_root_key_arns`: retained decrypt-only ARN sets per pair;
- `web_root_key_registry`: complete active, staged, and retired configuration;
- `worker_root_key_registry`: an operator/audit inventory filtered to AI-assisted object-wrap roots only;
- `verifier_root_key_registry`: the equivalent operator/audit inventory for the verifier's decrypt-only role;
- `organizer_root_key_registry`: AI-assisted object-wrap and content-MAC generations only;
- `search_root_key_registry`: active and retired AI-assisted object-wrap generations only; staged roots are absent;
- `verifier_retired_ai_object_wrap_roots_json`: exact retired object-wrap ARN JSON for
  `UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`;
- `worker_retired_ai_object_wrap_roots_json`: exact retired object-wrap ARN JSON accepted by the
  worker's `UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON` setting.
- `organizer_retired_ai_object_wrap_roots_json` and
  `organizer_retired_ai_content_mac_roots_json`: exact retired-root allowlists for the organizer's
  two AI-assisted key purposes.
- `search_retired_ai_object_wrap_roots_json`: exact retired AI-assisted object-wrap allowlist for owner search.
- `search_cloud_environment`: the exact eight-value, non-secret owner-search identity/KMS environment contract for this stack.

The verifier deployment consumes exactly `verifier_role_arn`, `verifier_oidc_subject`,
`ai_assisted_object_wrap_kms_key_arn`, and
`verifier_retired_ai_object_wrap_roots_json`. Its `/health` endpoint is liveness-only;
production KMS, database-role, and caller-identity readiness must be proved by the protected
verification and denial procedures below. `verifier_root_key_registry` is review inventory, not a
verifier environment value.

Set `UNFILED_AWS_ROLE_ARN` from `web_role_arn`, `worker_role_arn`, `verifier_role_arn`, or `organizer_role_arn` only in its matching Vercel project and matching environment scope. Set `UNFILED_AWS_REGION` in all five. The index worker and verifier each receive `ai_assisted_object_wrap_kms_key_arn` as `UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN` plus only their matching retired-roots JSON output. Owner search instead receives the exact search-prefixed values in `search_cloud_environment`, including `UNFILED_SEARCH_AWS_ROLE_ARN`, `UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN`, `UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`, and `UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT`. This matches the search runtime's separate fail-closed parser and prevents generic role/key reuse. Add its Vercel project ID and application/database secrets through their separately documented settings; Terraform does not output them. Owner search must not receive another environment's value, another workload's role or registry, a provider key, a database credential, or another runtime secret. The organizer receives the two active AI-assisted root ARNs and only its two exact retired-root JSON outputs; never give it the web registry or either private ARN. Keep all registry outputs as reviewed rotation inventories rather than broad runtime configuration.

`search_oidc_subject` is the only subject trusted by the current stack and `search_oidc_audience` is its fixed audience. `search_production_oidc_subject` and `search_preview_oidc_subject` expose the two exact claims for plan-time evidence: only the one equal to `search_oidc_subject` may appear in the role trust. The other environment's subject must be absent. A Preview deployment uses the same owner-search Vercel project, but its separate stack emits a different `search_role_arn`, key outputs, and runtime contract. Never copy those values between Vercel environment scopes.

The runtime parsers accept at most 20 retired roots for each exact class/purpose pair, and Terraform
enforces the same limit. A 21st promotion is intentionally blocked. Before that point, define and
review a distinct archived-root lifecycle that proves no live row or retained backup still needs
runtime decryption; do not weaken the parser or silently discard the oldest ARN.

These values are identifiers rather than secrets, but their integrity controls authorization. Store them in the matching protected Vercel environment configuration, not in client bundles. Never add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, an intermediate key, a root key, plaintext note content, or an email address to Terraform, Vercel configuration, KMS context, or logs.

## Two-apply v1 → v2 rotation runbook

Rotate one class/purpose pair at a time unless an incident requires otherwise. The checked-in mocked scenario rotates all four to prove the complete policy shape.

### Phase 1: create and verify a staged generation

1. Leave v1 `active` in the complete registry.
2. Add the canonical v2 entry for that same pair with `generation = 2` and `status = "staged"`. Do not rename or remove v1.
3. Run the full validation suite and save a plan. The plan may create v2 and update describe/deny policy lists, but it must not change the existing alias, demote v1, replace a key, or destroy anything.
4. Apply the saved plan.
5. Export and deploy the updated registries. Web may receive the complete registry. The index worker and verifier receive only their object-wrap-only registries; the organizer receives only AI-assisted object-wrap/content-MAC entries. Owner search receives no staged entry at all.
6. With production OIDC sessions, prove that web can `DescribeKey` on v2, worker and verifier can describe an AI object-wrap v2 only, organizer can describe both AI-purpose v2 roots only, and owner search cannot describe or otherwise use the staged root. Prove `GenerateDataKey`, `Decrypt`, and both rewrap directions are denied on every staged root. Prove index/verifier/search have no AI content-MAC/private identifier, organizer has no private identifier, and controlled direct forbidden-key probes return `AccessDenied`.
7. Confirm in CloudTrail that the exact production subjects were used and that the stable alias and all new writes still resolve to v1.

Do not write or rewrap any application record under a staged root. A staged root is intentionally unusable beyond readiness description.

### Phase 2: promote v2 and retire v1

1. Drain the affected isolated workload and pause new encrypted writes for the key pair. Record counts of intermediate-key records by root ARN.
2. In one reviewed registry change, set v1 to `retired` and v2 to `active`.
3. Save and inspect the plan. It must create and destroy zero KMS keys. It should update the two key policies/tags, move the stable alias to v2, and update workload policies and outputs.
4. Apply the saved plan, deploy the promoted registry outputs, and keep writes paused during this fail-closed configuration window.
5. Verify that `GenerateDataKey` succeeds only on v2 and returns the expected full v2 key ARN; v1 generation is denied; both roots can decrypt ciphertext created under their own ARN/context; worker, verifier, organizer, and search private probes remain denied; verifier and search cannot generate a data key; search can decrypt/describe only active and retired AI object-wrap roots and cannot encrypt, rewrap, create grants, schedule deletion, or use staged/content-MAC/private roots; organizer can generate only for the two active AI purposes and cannot rewrap/create grants; and a web-only v1 → v2 `ReEncrypt` probe succeeds with the exact context.
6. Resume writes and the isolated workers only after every gate passes.

### Rewrap retained intermediate keys

Rewrap per-user intermediate-key ciphertext, not note plaintext. For each record referencing v1:

1. Call KMS `ReEncrypt` with v1 as the source, active v2 as the destination, and the record's exact four-field context.
2. Verify the returned key ARN is v2 and that the new ciphertext decrypts under the same owner/class/purpose/record binding.
3. Atomically update the wrapped ciphertext, root ARN, and generation metadata with an idempotency guard.
4. Retry safely until the count referencing v1 is zero, then run integrity and restore drills.

The v1 key stays in the registry as `retired` even after the count reaches zero. `prevent_destroy` is intentional defense against an incomplete inventory, delayed backup, or rollback.

### Rollback and restore gates

- Before any v2 data exists, restore v1 to `active` and v2 to `staged`, inspect a zero-destroy plan, apply, deploy the reverted registry, and rerun probes.
- After any write or rewrap under v2, pause writers and set v1 to `active` and v2 to `retired`. This keeps both generations decryptable while moving new traffic back to v1. Deploy the registry, verify both populations, and rewrap v2 records back only if needed.
- Never remove either entry, disable a key, schedule deletion, edit a policy manually, or remove `prevent_destroy` as a rollback step.
- Restore testing must prove the database backup and Terraform state preserve each record's exact KMS ARN, generation, wrapped bytes, and four context identifiers.

## Required production evidence

The role-separation probe and CloudTrail management events must prove:

1. only the exact web production subject can use private-manual roots;
2. the exact worker production subject can generate/decrypt the active AI object-wrap root, decrypt retired AI object-wrap roots, and only describe staged AI object-wrap roots;
3. the exact verifier production subject can decrypt active/retired AI object-wrap roots, only describe staged AI object-wrap roots, and cannot generate or rewrap keys;
4. the exact organizer production subject can generate/decrypt active and decrypt retired AI object-wrap/content-MAC roots, only describe staged AI roots, and cannot use private roots, rewrap, or create grants;
5. the exact owner-search Production subject can decrypt/describe active and retired AI object-wrap roots only; its exact Preview subject, wrong projects, wrong audience, and every write/grant/rewrap/deletion operation are denied;
6. worker, verifier, and search attempts against every AI content-MAC and private generation, plus organizer attempts against every private generation, return `AccessDenied`;
7. wrong owner, class, purpose, key-record ID, missing context key, extra context key, wrong audience, preview subject, and other project subjects are denied;
8. staged roots cannot generate, decrypt, or rewrap, and owner search cannot describe them;
9. disabling any required root makes the application fail closed without persisting plaintext.

KMS cryptographic operations such as `GenerateDataKey`, `Decrypt`, and `ReEncrypt` are CloudTrail **management** events. The trail must include read and write management events and must not exclude KMS events. Encryption-context values appear in those logs, so they must contain opaque identifiers only.

Primary references: [Vercel OIDC token claims](https://vercel.com/docs/oidc/reference), [Vercel custom OIDC audiences](https://vercel.com/changelog/custom-oidc-token-audiences), [AWS KMS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html), [AWS KMS encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html), and [AWS KMS CloudTrail logging](https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html).
