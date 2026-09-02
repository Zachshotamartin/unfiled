# Key-Custody Denial or Outage

## Scope

The free private beta uses `UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1`: four independent root
families held in Vercel Sensitive Environment Variables, bound to the exact project ID and the
`production` environment, with each workload receiving only its subset ([ADR-0016](../decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md)).
Use this runbook for configuration rejection at startup, envelope authentication failure, root
registry/ring drift, an unexpected missing or extra root in a workload, or a suspected wrong-root
success. The AWS KMS section at the end applies only to a future funded deployment.

The safe state is fail closed: no plaintext persistence/cache/fallback, AI organization to Inbox,
AI-assisted search lexical-only, and manual encrypted operations unavailable rather than decrypted
with an alternate key.

## Authority

The release operator disables affected features and redeploys. Only the key recovery owner changes
root material, rings, registries, or generations, and only through the rotation procedure in
`HUMAN_SETUP.md`. The security owner leads any wrong-root success, root exposure, unexplained ring
change, or missing-subset finding. Runtime code never generates or rewrites a root.

## Diagnose without changing custody

1. Confirm environment (`production` only; Preview is not built), service/deployment, expected
   root key IDs and statuses from the web registry, incident window, and the last redeploy from
   restricted configuration references. Never print a ring value.
2. Inspect aggregate safe error class: `ConfigurationError`/startup rejection, envelope
   authentication failure, key-record mismatch, or project/environment binding failure.
3. Compare the operation with the subset contract:
   - web holds all four families and may rewrap through the locked CAS RPC;
   - organizer holds AI object-wrap and AI content-MAC only;
   - worker, verifier, and search hold AI object-wrap only;
   - no isolated project holds a private-manual root; any AWS, legacy, local, or public-prefixed key
     variable is rejected at startup.
4. Check for: a ring whose `projectId` or `deploymentEnvironment` does not match the injected
   `VERCEL_PROJECT_ID`/`VERCEL_ENV`; a registry root missing from the ring or vice versa; a retired
   root omitted from a workload's `*_RETIRED_*_ROOT_KEY_IDS_JSON`; a mixed deployment set after a
   rotation; whitespace or non-canonical JSON.

Stop as S1 if an isolated workload can open a private-manual envelope, a workload holds a root outside
its subset, a ring value appears in any log or response, or a root was changed outside the rotation
procedure.

## Contain and recover

1. Disable the affected feature and pause rewrap/rotation. Do not add a plaintext fallback, move a
   root to a non-Sensitive variable, or copy a ring to another project or environment.
2. For a startup rejection after a configuration change, roll back to the complete prior
   configuration/deployment set. Never remove a generation still referenced by data.
3. For registry/ring drift, correct the documents through the rotation procedure (registry, rings,
   retired lists, then redeploy every project that carries the family) with key-recovery approval.
4. For a suspected exposed root, treat as [suspected key exposure](./suspected-key-exposure.md):
   generate a new root generation, rewrap owner intermediate keys, and retire the old root.
5. Prove one synthetic encrypted operation per affected workload before cohort traffic, plus the
   negative probe that each isolated workload cannot open a private-manual envelope.

## Verification and evidence

Require correct subsets per workload, every negative probe denied, no plaintext artifact, envelope
authentication, queue/receipt reconciliation, and a zero-hit privacy canary. After rotation,
references to the retired generation must reach zero and a restore check must pass before removal.

Record safe incident class/counts, service and registry digests, root key IDs and statuses (never
material), deployment IDs before/after, the subset matrix result, synthetic verification, approvals,
and root-cause follow-up.

## Deferred: AWS KMS (not used in the free beta)

If a funded deployment selects `UNFILED_KEY_CUSTODIAN=aws-kms`, extend this runbook with: STS/OIDC
exchange and role trust checks, `AccessDenied` versus outage classification, alias/policy digests,
CloudTrail delivery, staged/retired generation handling through Terraform, and the KMS recovery
owner's allow/deny probe matrix. Do not add static AWS credentials or move a KMS root into Vercel.
