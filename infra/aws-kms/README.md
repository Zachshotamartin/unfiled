# Unfiled production KMS and workload identities

This Terraform root is the production custody boundary for Unfiled's per-user intermediate keys. It creates distinct Vercel OIDC workload roles and independently managed AWS KMS root generations for every key-class × purpose pair.

## Security contract

The four stable aliases are:

- `alias/unfiled/ai-assisted/object-wrap`
- `alias/unfiled/ai-assisted/content-mac`
- `alias/unfiled/private-manual/object-wrap`
- `alias/unfiled/private-manual/content-mac`

The `root_key_generations` registry is append-only after first apply. Its canonical IDs have the form `<key_class>_<purpose>_v<generation>`. Exactly one generation per pair is active, and every alias targets that active generation.

| Generation status | Alias target | `GenerateDataKey`          | `Decrypt`                  | Web root rewrap | Index worker access             | Verifier access              |
| ----------------- | ------------ | -------------------------- | -------------------------- | --------------- | ------------------------------- | ---------------------------- |
| `staged`          | No           | Denied                     | Denied                     | Denied          | Describe AI object-wrap only    | Describe AI object-wrap only |
| `active`          | Yes          | Allowed with exact context | Allowed with exact context | `ReEncryptTo`   | Generate/decrypt AI object-wrap | Decrypt AI object-wrap       |
| `retired`         | No           | Denied                     | Allowed with exact context | `ReEncryptFrom` | Decrypt AI object-wrap          | Decrypt AI object-wrap       |

AI content-MAC and private-manual generations never name the index worker as a key-policy principal and never appear in its filtered registry. Its IAM policy explicitly denies every AI content-MAC and private-manual generation. The verifier receives no `GenerateDataKey`, `ReEncryptFrom`, or `ReEncryptTo`; it can only decrypt active or retired AI object-wrap intermediate keys while validating a shadow generation.

Every cryptographic permission is bound to exactly these non-secret encryption-context fields:

- `UnfiledOwnerId`
- `UnfiledKeyClass`
- `UnfiledKeyPurpose`
- `UnfiledKeyRecordId`

The key policy does **not** contain the usual account-root delegation statement. Only the explicit, same-account `key_administrator_arns` can recover or change a key policy. `bypass_policy_lockout_safety_check` is fixed to `false`, so AWS rejects key creation if the applying principal cannot retain `kms:PutKeyPolicy` through the resulting policy. Never bypass that failure.

Every KMS key has `lifecycle.prevent_destroy = true`, a 30-day deletion window, and AWS-managed cryptographic key-material rotation enabled. Removing or renaming an applied registry entry therefore fails planning instead of scheduling destruction. Application-level generations remain separate from AWS's transparent annual key-material rotation.

## Before the first apply

1. Create at least one dedicated KMS administrator role or user in the target account. Two independent, monitored recovery roles are recommended. Do not use either runtime role.
2. Assume one of the listed administrator principals for the first apply. That session also needs identity permissions to create the IAM/OIDC/KMS resources in this root. Confirm it with `aws sts get-caller-identity`.
3. In the web, index-worker, and verifier Vercel projects, enable **Team Issuer** under Settings → Security → OIDC.
4. Copy `terraform.tfvars.example` to the ignored `terraform.tfvars`. Replace the account, region, exact Vercel team slug, exact project names, administrator ARNs, and tags. Persist the entire generation registry in reviewed configuration; do not rely on memory of its default.
5. Configure an encrypted, access-controlled remote Terraform backend with locking for this root before production. The backend is account-specific and intentionally is not checked in here.
6. Do not create static AWS access keys for either Vercel runtime role.

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

Reject any initial plan that contains anything other than the expected OIDC provider, three runtime roles and policies, four v1 KMS keys, and four stable aliases. On every later plan, reject any KMS-key destroy or replacement.

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
- `verifier_retired_ai_object_wrap_roots_json`: exact retired object-wrap ARN JSON for
  `UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`;
- `worker_retired_ai_object_wrap_roots_json`: exact retired object-wrap ARN JSON accepted by the
  worker's `UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON` setting.

The verifier deployment consumes exactly `verifier_role_arn`, `verifier_oidc_subject`,
`ai_assisted_object_wrap_kms_key_arn`, and
`verifier_retired_ai_object_wrap_roots_json`. Its `/health` endpoint is liveness-only;
production KMS, database-role, and caller-identity readiness must be proved by the protected
verification and denial procedures below. `verifier_root_key_registry` is review inventory, not a
verifier environment value.

Set `UNFILED_AWS_ROLE_ARN` from `web_role_arn`, `worker_role_arn`, or `verifier_role_arn` only in its matching Vercel project. Set `UNFILED_AWS_REGION` in all three. The index worker and verifier each receive `ai_assisted_object_wrap_kms_key_arn` as `UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN` plus only their matching retired-roots JSON output. Keep the three registry outputs as reviewed rotation inventories; do not pass a broad registry, AI content-MAC ARN, or private ARN into either isolated workload.

The runtime parsers accept at most 20 retired roots for each exact class/purpose pair, and Terraform
enforces the same limit. A 21st promotion is intentionally blocked. Before that point, define and
review a distinct archived-root lifecycle that proves no live row or retained backup still needs
runtime decryption; do not weaken the parser or silently discard the oldest ARN.

These values are identifiers rather than secrets, but their integrity controls authorization. Store them in protected Production environment configuration, not in client bundles. Never add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, an intermediate key, a root key, plaintext note content, or an email address to Terraform, Vercel configuration, KMS context, or logs.

## Two-apply v1 → v2 rotation runbook

Rotate one class/purpose pair at a time unless an incident requires otherwise. The checked-in mocked scenario rotates all four to prove the complete policy shape.

### Phase 1: create and verify a staged generation

1. Leave v1 `active` in the complete registry.
2. Add the canonical v2 entry for that same pair with `generation = 2` and `status = "staged"`. Do not rename or remove v1.
3. Run the full validation suite and save a plan. The plan may create v2 and update describe/deny policy lists, but it must not change the existing alias, demote v1, replace a key, or destroy anything.
4. Apply the saved plan.
5. Export and deploy the updated registries. Web may receive the complete registry. The index worker and verifier receive only their object-wrap-only registries.
6. With production OIDC sessions, prove that web can `DescribeKey` on v2 and that the worker and verifier can describe an AI object-wrap v2 only. Prove `GenerateDataKey`, `Decrypt`, and both rewrap directions are denied on every staged root. Prove neither isolated workload has a configured AI content-MAC/private v2 identifier and controlled direct forbidden-key probes return `AccessDenied`.
7. Confirm in CloudTrail that the exact production subjects were used and that the stable alias and all new writes still resolve to v1.

Do not write or rewrap any application record under a staged root. A staged root is intentionally unusable beyond readiness description.

### Phase 2: promote v2 and retire v1

1. Drain the affected isolated workload and pause new encrypted writes for the key pair. Record counts of intermediate-key records by root ARN.
2. In one reviewed registry change, set v1 to `retired` and v2 to `active`.
3. Save and inspect the plan. It must create and destroy zero KMS keys. It should update the two key policies/tags, move the stable alias to v2, and update workload policies and outputs.
4. Apply the saved plan, deploy the promoted registry outputs, and keep writes paused during this fail-closed configuration window.
5. Verify that `GenerateDataKey` succeeds only on v2 and returns the expected full v2 key ARN; v1 generation is denied; both roots can decrypt ciphertext created under their own ARN/context; worker and verifier private probes remain denied; the verifier cannot generate a data key; and a web-only v1 → v2 `ReEncrypt` probe succeeds with the exact context.
6. Resume writes and the worker only after every gate passes.

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
4. worker and verifier attempts against every AI content-MAC and private generation return `AccessDenied`;
5. wrong owner, class, purpose, key-record ID, missing context key, extra context key, wrong audience, preview subject, and other project subjects are denied;
6. staged roots cannot generate, decrypt, or rewrap;
7. disabling any required root makes the application fail closed without persisting plaintext.

KMS cryptographic operations such as `GenerateDataKey`, `Decrypt`, and `ReEncrypt` are CloudTrail **management** events. The trail must include read and write management events and must not exclude KMS events. Encryption-context values appear in those logs, so they must contain opaque identifiers only.

Primary references: [Vercel OIDC token claims](https://vercel.com/docs/oidc/reference), [Vercel custom OIDC audiences](https://vercel.com/changelog/custom-oidc-token-audiences), [AWS KMS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html), [AWS KMS encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html), and [AWS KMS CloudTrail logging](https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html).
