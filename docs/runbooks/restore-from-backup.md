# Restore From Backup

## Purpose and authority

Use for scheduled drills or an approved disaster recovery. A drill never serves public traffic. A
Production incident restore requires database, key recovery, release, and security owners. No single
runtime operator may restore the database and supply the root ring to the scratch environment.

Free-beta boundary: the Supabase free plan provides no PITR and no isolated restore project, so a
drill is limited to the plan's actual backup capability. Record that limit explicitly; the
irreversible storage contraction stays blocked until a funded restore gate exists.

Follow [Backup and Restore Policy](../operations/BACKUP_AND_RESTORE_POLICY.md). Do not begin unless the
source recovery point, compatible application deployment, migration head, C.5d contract state, and
root registry are unambiguous.

## Prepare

1. Open a restricted drill/incident record and name operators, approver, objective, source time,
   expected RPO/RTO, and teardown owner.
2. Record immutable references for the source backup point, migration/checksum, five-deployment
   set, contract state, and root registry digest (Terraform state only in a funded AWS deployment).
3. Create a new isolated scratch Supabase project/account boundary. Disable public DNS, email/OTP,
   provider egress, cron/background drains, analytics, error replay, and user traffic.
4. Provision new scratch secrets. Never copy Production service-role, runtime database, provider,
   cron, cursor, or session credentials.
5. Approve narrowly scoped, time-bounded supply of only the exact root generations required to
   authenticate the restored envelopes to the scratch environment, as Sensitive variables bound to the
   scratch project. Do not widen any workload's subset or place material anywhere else.

Stop if the scratch environment can reach a provider or public user, if a key generation is absent,
or if any secret/content must be placed in a command argument or transcript.

## Restore and validate

1. Restore the selected backup/PITR point through the provider management plane. Record timestamps,
   not progress payloads.
2. Before starting an application, verify schema-only state: migration head/checksums, extensions,
   functions, constraints, RLS, grants, role attributes, Vault availability, and C.5d state.
3. Recreate the exact dedicated workload logins in scratch with new passwords and prove
   eleven-/six-/two-/five-RPC allowlists plus table/private/admin/RLS-bypass denials.
4. Deploy the compatible application commit into isolated scratch projects with provider calls and
   public traffic disabled. Verify the deployment-set digest.
5. Run a bounded verifier that emits only counts, digests, timing, and pass/fail:
   - every encrypted object has a valid envelope and permitted key record;
   - required root key ID/generation/context metadata survived;
   - authenticated decryption and canonical projection digests match stored attestations;
   - owner/object/revision/privacy relationships and active-generation coverage reconcile;
   - no legacy plaintext column/value exists when contract state is contracted.
6. Verify synthetic fixture readability through owner-authorized APIs without logging returned
   content. Compare pre-recorded fixture digests in memory and emit pass/fail only.
7. Replay a confirmed synthetic account-deletion receipt through the unauthenticated receipt path;
   prove zero live owner rows, Vault bindings/secrets, index entries, jobs, and sessions.
8. Verify semantic search stays lexical-only unless the entire scratch search trust-domain gate was
   separately authorized. Never call the provider during an ordinary restore drill.
9. Run a canary-log search over scratch sinks and require zero content/token/key-pattern hits.

## Disaster promotion

For an actual recovery, do not point traffic at scratch immediately. First:

1. complete every validation above and reconcile the recovery point with the incident impact;
2. deploy the one compatible five-service set and current safe feature flags;
3. provision fresh runtime/auth credentials and exact OIDC caller mappings;
4. verify monitoring, backups, support, and rollback targets;
5. obtain security/release/database/key-recovery approval;
6. switch traffic gradually, starting with synthetic probes and a controlled cohort.

A pre-contract restore reintroduces the historical exposure window and is a security incident. Do not
claim encrypted-only live storage until the contract is safely re-applied and all newer pre-contract
backups age out.

## Teardown and verification

For drills, delete the scratch root variables, runtime credentials, aliases, and public reachability; destroy
the scratch database/project under the approved process; verify deletion; and close temporary alert
routes. Do not retain a dump or local copy.

The drill passes only when observed RPO/RTO meet objectives, all authentication/parity/ACL/deletion/
canary checks pass, scratch teardown is proven, and gaps have owners/dates. A partial pass blocks
release.

## Evidence

Restricted evidence records source/scratch references, roles, deployment/migration/contract/root-registry
digests, phase timestamps, safe counts/digests, allow/deny matrix, deletion replay, canary result,
RPO/RTO, teardown, findings, and approvals. The public summary contains date, objective, observed
RPO/RTO, result, sanitized findings, and evidence digest only.
