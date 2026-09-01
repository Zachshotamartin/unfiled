import { strict as assert } from "node:assert";

import { Client, type ClientConfig, type QueryResult } from "pg";

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CAPTURE_ID = "cap_78000000000000000000000001";
const JOB_ID = "job_78000000000000000000000001";
const NOTE_ID = "note_78000000000000000000000001";
const MUTATION_ID = "mut_78000000000000000000000001";
const OWNER_INTERACTION_KEY = "lock-order-e1-batch";
const OBJECT_KEY_ID = "c5c3.lock_order.object.v1";
const MAC_KEY_ID = "c5c3.lock_order.mac.v1";
const CLAIM_APPLICATION = "unfiled-organizer-lock-order-claim";
const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type KeyRecord = Readonly<{
  created: boolean;
  keyId: string;
  keyVersion: number;
}>;

type RolloutRecord = Readonly<{ state: string }>;
type ClaimResult = Readonly<{
  result: Readonly<{ jobs?: readonly Readonly<{ jobId?: string }>[] }>;
}>;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function databaseUrl(): string {
  const value = process.env.UNFILED_TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
  const parsed = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.hostname)) {
    throw new Error("The lock-order regression is restricted to a local PostgreSQL instance.");
  }
  return value;
}

function clientConfig(applicationName: string): ClientConfig {
  return {
    application_name: applicationName,
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 3_000,
    query_timeout: 8_000
  };
}

function envelope(
  resourceId: string,
  kind: "capture" | "note_content" | "note_mutation",
  keyId: string
): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    suite: "A256GCM",
    keyId,
    context: {
      tenantId: OWNER_ID,
      resourceId,
      recordVersion: 1,
      kind
    },
    wrappedDataKey: {
      nonce: "A".repeat(16),
      ciphertext: "B".repeat(64)
    },
    payload: {
      nonce: "C".repeat(16),
      ciphertext: "D".repeat(80)
    }
  };
}

async function rollback(client: Client): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // The connection may already have ended after a failed statement.
  }
}

async function close(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // Preserve the original regression failure.
  }
}

async function removeFixture(client: Client): Promise<void> {
  await client.query("begin");
  try {
    await client.query(
      `delete from public.content_key_operation_reservations as reservation
       using public.encrypted_owner_interaction_reservations as binding
       where binding.user_id = $1
         and binding.idempotency_key = $2
         and reservation.user_id = binding.user_id
         and reservation.reservation_id = binding.reservation_id`,
      [OWNER_ID, OWNER_INTERACTION_KEY]
    );
    await client.query(
      `delete from public.encrypted_owner_interaction_claims
       where user_id = $1 and idempotency_key = $2`,
      [OWNER_ID, OWNER_INTERACTION_KEY]
    );
    await client.query("delete from public.organization_jobs where id = $1", [JOB_ID]);
    await client.query("delete from public.captures where id = $1", [CAPTURE_ID]);
    await client.query("delete from public.notes where id = $1", [NOTE_ID]);
    await client.query(
      `delete from public.user_content_keys
       where user_id = $1 and key_id = any($2::text[])`,
      [OWNER_ID, [OBJECT_KEY_ID, MAC_KEY_ID]]
    );
    await client.query("commit");
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function activeKey(
  client: Client,
  purpose: "object_wrap" | "content_mac",
  fixtureKeyId: string
): Promise<KeyRecord> {
  const existing = await client.query<{ key_id: string; key_version: number }>(
    `select key_id, key_version
     from public.user_content_keys
     where user_id = $1
       and key_class = 'ai_assisted'
       and key_purpose = $2::public.content_key_purpose
       and state = 'active'
     order by key_version desc
     limit 1`,
    [OWNER_ID, purpose]
  );
  if (existing.rowCount === 1) {
    const record = existing.rows[0];
    assert(record !== undefined);
    return { created: false, keyId: record.key_id, keyVersion: record.key_version };
  }

  const inserted = await client.query<{ key_id: string; key_version: number }>(
    `insert into public.user_content_keys (
       user_id, key_id, key_class, key_purpose, key_version,
       kms_key_id, wrapped_intermediate_key, state, created_at, activated_at
     )
     select
       $1, $2, 'ai_assisted', $3::public.content_key_purpose,
       coalesce(max(key_version), 0) + 1,
       'arn:aws:kms:us-west-2:123456789012:key/78000000-0000-4000-8000-000000000001',
       decode(repeat('78', 32), 'hex'), 'active',
       transaction_timestamp(), transaction_timestamp()
     from public.user_content_keys
     where user_id = $1
       and key_class = 'ai_assisted'
       and key_purpose = $3::public.content_key_purpose
     returning key_id, key_version`,
    [OWNER_ID, fixtureKeyId, purpose]
  );
  const record = inserted.rows[0];
  assert(record !== undefined);
  return { created: true, keyId: record.key_id, keyVersion: record.key_version };
}

async function waitForBlockedAdvisory(client: Client, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ waiting: boolean }>(
      `select exists (
         select 1
         from pg_catalog.pg_locks
         where pid = $1 and locktype = 'advisory' and not granted
       ) as waiting`,
      [pid]
    );
    if (result.rows[0]?.waiting === true) return;
    await delay(20);
  }
  throw new Error("Organizer claim did not reach the blocked rollout advisory in time.");
}

async function waitForBlockedRow(client: Client, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ waiting: boolean }>(
      `select exists (
         select 1
         from pg_catalog.pg_stat_activity
         where pid = $1 and state = 'active' and wait_event_type = 'Lock'
       ) as waiting`,
      [pid]
    );
    if (result.rows[0]?.waiting === true) return;
    await delay(20);
  }
  throw new Error("Advisory-first session did not block on the note row in time.");
}

function sqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

type RowFirstScenario = Readonly<{
  id: string;
  label: string;
  mutationSql: string;
  rowLockSql: string;
}>;

async function acquireRolloutAdvisory(client: Client, ownerId: string): Promise<void> {
  await client.query(
    `select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1::text || ':content-encryption-rollout', 0)
     )`,
    [ownerId]
  );
}

async function proveRowFirstFailsFast(
  admin: Client,
  blocker: Client,
  writer: Client,
  scenario: RowFirstScenario
): Promise<void> {
  await writer.query("begin");
  await blocker.query("begin");
  try {
    await writer.query("set local statement_timeout = '2s'");
    const writerLock = await writer.query<{ id: string }>(scenario.rowLockSql, [scenario.id]);
    assert.equal(writerLock.rows[0]?.id, scenario.id);

    await blocker.query("set local lock_timeout = '750ms'");
    await blocker.query("set local statement_timeout = '3s'");
    await acquireRolloutAdvisory(blocker, OWNER_ID);
    const blockerPid = await blocker.query<{ pid: number }>(
      "select pg_catalog.pg_backend_pid() as pid"
    );
    const blockerBackendPid = blockerPid.rows[0]?.pid;
    assert(typeof blockerBackendPid === "number");
    const pendingBlockerRow = blocker
      .query<{ id: string }>(scenario.rowLockSql, [scenario.id])
      .then(
        (result) => ({ result }) as const,
        (error: unknown) => ({ error }) as const
      );
    await waitForBlockedRow(admin, blockerBackendPid);

    const startedAt = performance.now();
    let updateError: unknown;
    try {
      await writer.query(scenario.mutationSql, [scenario.id]);
    } catch (error) {
      updateError = error;
    }
    const failedAfterMilliseconds = performance.now() - startedAt;
    await rollback(writer);
    assert.equal(sqlState(updateError), "40001");
    assert(updateError instanceof Error);
    assert.equal(updateError.message, "content_encryption_rollout_busy");
    assert(
      failedAfterMilliseconds < 1_000,
      `${scenario.label} did not fail fast (${failedAfterMilliseconds.toFixed(0)} ms).`
    );

    const blockerOutcome = await pendingBlockerRow;
    if ("error" in blockerOutcome) throw blockerOutcome.error;
    assert.equal(blockerOutcome.result.rows[0]?.id, scenario.id);
    await blocker.query("commit");
    process.stdout.write(`${scenario.label} failed fast without a rollout deadlock\n`);
  } finally {
    await rollback(writer);
    await rollback(blocker);
  }
}

async function proveOwnerChangeRejectsBeforeAdvisory(
  blocker: Client,
  writer: Client
): Promise<void> {
  await writer.query("begin");
  await blocker.query("begin");
  try {
    await writer.query("set local statement_timeout = '2s'");
    await acquireRolloutAdvisory(blocker, OTHER_OWNER_ID);
    const startedAt = performance.now();
    let updateError: unknown;
    try {
      await writer.query("update public.organization_jobs set user_id = $2 where id = $1", [
        JOB_ID,
        OTHER_OWNER_ID
      ]);
    } catch (error) {
      updateError = error;
    }
    const failedAfterMilliseconds = performance.now() - startedAt;
    await rollback(writer);
    assert.equal(sqlState(updateError), "42501");
    assert(updateError instanceof Error);
    assert.equal(updateError.message, "content_owner_immutable");
    assert(
      failedAfterMilliseconds < 1_000,
      `Owner immutability did not reject before advisory wait (${failedAfterMilliseconds.toFixed(0)} ms).`
    );
    await blocker.query("commit");
    process.stdout.write("organization-job owner change rejected before the new-owner advisory\n");
  } finally {
    await rollback(writer);
    await rollback(blocker);
  }
}

async function proveOwnerInteractionAdvisoryFirst(
  adminClient: Client,
  blockerClient: Client,
  interactionClient: Client
): Promise<void> {
  await adminClient.query(
    "update public.content_encryption_rollouts set state = 'encrypted_only' where user_id = $1",
    [OWNER_ID]
  );
  await blockerClient.query("begin");
  try {
    await blockerClient.query("set local lock_timeout = '750ms'");
    await blockerClient.query("set local statement_timeout = '3s'");
    await acquireRolloutAdvisory(blockerClient, OWNER_ID);

    const interactionPid = await interactionClient.query<{ pid: number }>(
      "select pg_catalog.pg_backend_pid() as pid"
    );
    const pid = interactionPid.rows[0]?.pid;
    assert(typeof pid === "number");
    const pendingPreparation = interactionClient.query<{
      result: Readonly<{ members: readonly unknown[]; scope: string }>;
    }>(`select public.get_encrypted_mutation_batch($1, $2, 1, $3) as result`, [
      OWNER_ID,
      MUTATION_ID,
      OWNER_INTERACTION_KEY
    ]);

    await waitForBlockedAdvisory(adminClient, pid);
    const noteLock = await blockerClient.query<{ id: string }>(
      "select id from public.notes where id = $1 for update",
      [NOTE_ID]
    );
    assert.equal(noteLock.rows[0]?.id, NOTE_ID);
    await blockerClient.query("commit");

    const preparation = await pendingPreparation;
    const prepared = preparation.rows[0];
    assert(prepared !== undefined);
    assert.equal(prepared.result.scope, "encrypted_mutation_batch_undo");
    assert.equal(prepared.result.members.length, 1);
    process.stdout.write(
      "E1 batch preparation rollout advisory -> sorted note lock order passed\n"
    );
  } finally {
    await rollback(blockerClient);
  }
}

const admin = new Client(clientConfig("unfiled-organizer-lock-order-admin"));
const blocker = new Client(clientConfig("unfiled-organizer-lock-order-blocker"));
const claim = new Client(clientConfig(CLAIM_APPLICATION));
const writer = new Client(clientConfig("unfiled-organizer-lock-order-row-first-writer"));
let originalRollout: RolloutRecord | undefined;
let rolloutCreated = false;
let objectKey: KeyRecord | undefined;
let macKey: KeyRecord | undefined;
let claimPromise: Promise<QueryResult<ClaimResult>> | undefined;
let runFailed = false;
let runFailure: unknown;
let cleanupFailed = false;
let cleanupFailure: unknown;

try {
  await Promise.all([admin.connect(), blocker.connect(), claim.connect(), writer.connect()]);
  await removeFixture(admin);

  const rollout = await admin.query<RolloutRecord>(
    "select state::text as state from public.content_encryption_rollouts where user_id = $1",
    [OWNER_ID]
  );
  originalRollout = rollout.rows[0];
  if (originalRollout === undefined) {
    await admin.query(
      "insert into public.content_encryption_rollouts (user_id, state) values ($1, 'expanded')",
      [OWNER_ID]
    );
    originalRollout = { state: "expanded" };
    rolloutCreated = true;
  }

  await admin.query("begin");
  try {
    objectKey = await activeKey(admin, "object_wrap", OBJECT_KEY_ID);
    macKey = await activeKey(admin, "content_mac", MAC_KEY_ID);
    await admin.query(
      "update public.content_encryption_rollouts set state = 'dual_write' where user_id = $1",
      [OWNER_ID]
    );
    await admin.query(
      `insert into public.captures (
         id, user_id, source, device_id, raw_text, content_envelope,
         content_fingerprint, content_length, privacy, client_created_at,
         client_timezone, received_at, status, content_key_id,
         content_key_class, content_key_purpose, content_key_version,
         fingerprint_key_id, fingerprint_key_class, fingerprint_key_purpose,
         fingerprint_key_version
       ) values (
         $1, $2, 'web', 'lock-order-e2e', '[encrypted]', $3::jsonb,
         repeat('f', 64), 24, 'ai_assisted', clock_timestamp(), 'UTC',
         clock_timestamp(), 'queued', $4, 'ai_assisted', 'object_wrap', $5,
         $6, 'ai_assisted', 'content_mac', $7
       )`,
      [
        CAPTURE_ID,
        OWNER_ID,
        envelope(CAPTURE_ID, "capture", objectKey.keyId),
        objectKey.keyId,
        objectKey.keyVersion,
        macKey.keyId,
        macKey.keyVersion
      ]
    );
    await admin.query(
      `insert into public.notes (
         id, user_id, type, title, body_markdown, structured_data,
         current_revision, privacy, created_at, updated_at, content_envelope,
         content_key_id, content_key_class, content_key_purpose,
         content_key_version
       ) values (
         $1, $2, 'generic', '[encrypted]', '[encrypted]',
         '{"schemaVersion":1}'::jsonb, 1, 'ai_assisted',
         clock_timestamp(), clock_timestamp(), $3::jsonb,
         $4, 'ai_assisted', 'object_wrap', $5
       )`,
      [
        NOTE_ID,
        OWNER_ID,
        envelope(NOTE_ID, "note_content", objectKey.keyId),
        objectKey.keyId,
        objectKey.keyVersion
      ]
    );
    await admin.query(
      `insert into public.organization_jobs (
         id, capture_id, user_id, state, prompt_version, schema_version,
         available_at, created_at, updated_at
       ) values (
         $1, $2, $3, 'created', 'routing-v1', 1,
         '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00',
         '2000-01-01 00:00:00+00'
       )`,
      [JOB_ID, CAPTURE_ID, OWNER_ID]
    );
    await admin.query(
      `insert into public.note_mutations (
         id, user_id, note_id, idempotency_key, before_revision,
         after_revision, operations, inverse, created_at,
         mutation_envelope, mutation_key_id, mutation_key_class,
         mutation_key_purpose, mutation_key_version
       ) values (
         $1, $2, $3, 'lock-order-e1-anchor', 0, 1,
         '[]'::jsonb, '[]'::jsonb, clock_timestamp(), $4::jsonb,
         $5, 'ai_assisted', 'object_wrap', $6
       )`,
      [
        MUTATION_ID,
        OWNER_ID,
        NOTE_ID,
        envelope(MUTATION_ID, "note_mutation", objectKey.keyId),
        objectKey.keyId,
        objectKey.keyVersion
      ]
    );
    await admin.query("commit");
  } catch (error) {
    await rollback(admin);
    throw error;
  }

  const triggerContract = await admin.query<{
    definition: string;
    table_name: string;
    trigger_name: string;
  }>(
    `select
       relation.relname as table_name,
       trigger.tgname as trigger_name,
       pg_catalog.lower(pg_catalog.pg_get_functiondef(procedure.oid)) as definition
     from pg_catalog.pg_trigger as trigger
     join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
     join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
     join pg_catalog.pg_proc as procedure on procedure.oid = trigger.tgfoid
     where namespace.nspname = 'public'
       and relation.relname = any(array['notes', 'captures', 'organization_jobs'])
       and not trigger.tgisinternal`
  );
  for (const tableName of ["notes", "captures", "organization_jobs"]) {
    const prelock = triggerContract.rows.find(
      (row) =>
        row.table_name === tableName && row.trigger_name === "a_content_rollout_advisory_prelock"
    );
    assert(prelock !== undefined, `The ${tableName} prelock trigger is missing.`);
    assert.match(prelock.definition, /pg_try_advisory_xact_lock/u);
    assert.match(prelock.definition, /content_encryption_rollout_busy/u);
  }
  const jobGuard = triggerContract.rows.find(
    (row) =>
      row.table_name === "organization_jobs" &&
      row.trigger_name === "organization_jobs_encrypted_rollout_guard" &&
      row.definition.includes("pg_try_advisory_xact_lock") &&
      row.definition.includes("content_encryption_rollout_busy")
  );
  assert(jobGuard !== undefined, "The organization-job guard is not fail-fast.");

  const ownerInteractionContract = await admin.query<{
    definition: string;
    function_name: string;
  }>(
    `select
       procedure.proname as function_name,
       pg_catalog.lower(pg_catalog.pg_get_functiondef(procedure.oid)) as definition
     from pg_catalog.pg_proc as procedure
     join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname = any(array[
         'prepare_encrypted_decision_correction',
         'commit_encrypted_decision_correction',
         'prepare_encrypted_review_resolution',
         'commit_encrypted_review_resolution',
         'get_encrypted_mutation_batch',
         'undo_encrypted_mutation_batch'
       ])`
  );
  assert.equal(ownerInteractionContract.rowCount, 6);
  for (const contract of ownerInteractionContract.rows) {
    // Every encrypted command family shares this first advisory. Reusing the
    // note-write namespace serializes cross-table idempotency absence checks;
    // a Review-specific advisory would let note/taxonomy/capture claims race.
    const interactionAdvisory = contract.definition.indexOf(":encrypted-note-write:");
    const rolloutAdvisory = contract.definition.indexOf(":content-encryption-rollout");
    const firstRowLock = contract.definition.indexOf("for update");
    assert(
      interactionAdvisory >= 0,
      `${contract.function_name} omits the shared encrypted-write advisory.`
    );
    assert(
      rolloutAdvisory > interactionAdvisory,
      `${contract.function_name} takes its rollout advisory out of order.`
    );
    assert(
      firstRowLock > rolloutAdvisory,
      `${contract.function_name} locks a row before owner advisories.`
    );
  }

  for (const functionName of [
    "commit_encrypted_decision_correction",
    "undo_encrypted_mutation_batch"
  ]) {
    const contract = ownerInteractionContract.rows.find(
      (candidate) => candidate.function_name === functionName
    );
    assert(contract !== undefined);
    const noteLock = contract.definition.indexOf("order by note.id for update");
    const mutationLock = contract.definition.indexOf("order by mutation.id for update");
    assert(noteLock >= 0, `${functionName} omits sorted note locking.`);
    assert(
      mutationLock > noteLock,
      `${functionName} does not lock target mutations after sorted notes.`
    );
  }
  const reviewCommit = ownerInteractionContract.rows.find(
    (candidate) => candidate.function_name === "commit_encrypted_review_resolution"
  );
  assert(reviewCommit !== undefined);
  assert(
    reviewCommit.definition.indexOf("order by note.id for update") <
      reviewCommit.definition.indexOf("from public.review_items"),
    "Review commit does not lock sorted notes before the Review row."
  );

  const legacyUndoContract = await admin.query<{ definition: string }>(
    `select pg_catalog.lower(pg_catalog.pg_get_functiondef(procedure.oid)) as definition
     from pg_catalog.pg_proc as procedure
     join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname = 'apply_encrypted_note_mutation'
       and pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
         'p_owner_id uuid, p_note_id text, p_expected_revision integer, p_idempotency_key text, p_command jsonb'`
  );
  const legacyUndoDefinition = legacyUndoContract.rows[0]?.definition;
  assert(legacyUndoDefinition !== undefined);
  assert(
    legacyUndoDefinition.indexOf("encrypted_mutation_batch_members") <
      legacyUndoDefinition.indexOf("for update"),
    "Legacy single-note undo checks E1 batch membership too late."
  );

  await proveRowFirstFailsFast(admin, blocker, writer, {
    id: NOTE_ID,
    label: "row-first note UPDATE",
    mutationSql: "update public.notes set updated_at = updated_at where id = $1",
    rowLockSql: "select id from public.notes where id = $1 for update"
  });
  await proveRowFirstFailsFast(admin, blocker, writer, {
    id: CAPTURE_ID,
    label: "row-first capture UPDATE",
    mutationSql: "update public.captures set received_at = received_at where id = $1",
    rowLockSql: "select id from public.captures where id = $1 for update"
  });
  await proveRowFirstFailsFast(admin, blocker, writer, {
    id: JOB_ID,
    label: "row-first organization-job UPDATE",
    mutationSql: "update public.organization_jobs set updated_at = updated_at where id = $1",
    rowLockSql: "select id from public.organization_jobs where id = $1 for update"
  });
  await proveRowFirstFailsFast(admin, blocker, writer, {
    id: JOB_ID,
    label: "row-first organization-job DELETE",
    mutationSql: "delete from public.organization_jobs where id = $1",
    rowLockSql: "select id from public.organization_jobs where id = $1 for update"
  });
  await proveOwnerChangeRejectsBeforeAdvisory(blocker, writer);

  await blocker.query("begin");
  await blocker.query("set local lock_timeout = '750ms'");
  await blocker.query("set local statement_timeout = '3s'");
  await acquireRolloutAdvisory(blocker, OWNER_ID);

  await claim.query("set statement_timeout = '5s'");
  await claim.query(
    `select set_config(
       'request.jwt.claims', '{"role":"service_role"}', false
     )`
  );
  const claimPid = await claim.query<{ pid: number }>("select pg_catalog.pg_backend_pid() as pid");
  const pid = claimPid.rows[0]?.pid;
  assert(typeof pid === "number");
  const pendingClaim = claim.query<ClaimResult>(
    "select private.claim_encrypted_organizer_jobs_impl($1, 1, 60) as result",
    ["lock-order-e2e"]
  );
  claimPromise = pendingClaim;

  await waitForBlockedAdvisory(admin, pid);

  const captureLock = await blocker.query<{ id: string }>(
    "select id from public.captures where id = $1 for update",
    [CAPTURE_ID]
  );
  assert.equal(captureLock.rows[0]?.id, CAPTURE_ID);

  await blocker.query("commit");
  const claimed = await pendingClaim;
  assert.equal(claimed.rows[0]?.result.jobs?.[0]?.jobId, JOB_ID);

  const finalRows = await admin.query<{ capture_status: string; job_state: string }>(
    `select capture.status::text as capture_status, job.state::text as job_state
     from public.organization_jobs as job
     join public.captures as capture on capture.id = job.capture_id
     where job.id = $1`,
    [JOB_ID]
  );
  assert.deepEqual(finalRows.rows[0], { capture_status: "processing", job_state: "running" });
  process.stdout.write("organizer rollout advisory -> job -> capture lock order passed\n");

  await proveOwnerInteractionAdvisoryFirst(admin, blocker, claim);
} catch (error) {
  runFailed = true;
  runFailure = error;
} finally {
  await rollback(writer);
  await rollback(blocker);
  if (claimPromise !== undefined) {
    try {
      await claimPromise;
    } catch {
      // The primary assertion reports the query failure.
    }
  }
  try {
    if (originalRollout !== undefined) {
      await admin.query("begin");
      await admin.query(
        `delete from public.content_key_operation_reservations as reservation
         using public.encrypted_owner_interaction_reservations as binding
         where binding.user_id = $1
           and binding.idempotency_key = $2
           and reservation.user_id = binding.user_id
           and reservation.reservation_id = binding.reservation_id`,
        [OWNER_ID, OWNER_INTERACTION_KEY]
      );
      await admin.query(
        `delete from public.encrypted_owner_interaction_claims
         where user_id = $1 and idempotency_key = $2`,
        [OWNER_ID, OWNER_INTERACTION_KEY]
      );
      await admin.query("delete from public.organization_jobs where id = $1", [JOB_ID]);
      await admin.query("delete from public.captures where id = $1", [CAPTURE_ID]);
      await admin.query("delete from public.notes where id = $1", [NOTE_ID]);
      if (rolloutCreated) {
        await admin.query("delete from public.content_encryption_rollouts where user_id = $1", [
          OWNER_ID
        ]);
      } else {
        await admin.query(
          "update public.content_encryption_rollouts set state = $2 where user_id = $1",
          [OWNER_ID, originalRollout.state]
        );
      }
      const createdKeys = [objectKey, macKey]
        .filter((key): key is KeyRecord => key?.created === true)
        .map((key) => key.keyId);
      if (createdKeys.length > 0) {
        await admin.query(
          "delete from public.user_content_keys where user_id = $1 and key_id = any($2::text[])",
          [OWNER_ID, createdKeys]
        );
      }
      await admin.query("commit");
    }
  } catch (error) {
    await rollback(admin);
    cleanupFailed = true;
    cleanupFailure = error;
  } finally {
    await Promise.all([close(admin), close(blocker), close(claim), close(writer)]);
  }
}

if (runFailed && cleanupFailed) {
  throw new AggregateError([runFailure, cleanupFailure], "Regression and fixture cleanup failed.");
}
if (runFailed) throw runFailure;
if (cleanupFailed) throw cleanupFailure;
