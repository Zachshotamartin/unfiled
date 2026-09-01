import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { Client, type ClientConfig } from "pg";

const CONFIRMATION = "CONTRACT UNFILED ENCRYPTED STORAGE V1";
const CONTRACT_LOCK_KEY = "unfiled:encrypted-storage-contract:v1";
const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type CatalogRow = Readonly<{
  definition: string;
  identity: string;
  kind: string;
}>;

type Readiness = Readonly<{
  applied?: unknown;
  readinessDigest?: unknown;
}>;

function databaseUrl(): string {
  const configuredValue = process.env.UNFILED_TEST_DATABASE_URL?.trim();
  const value =
    configuredValue === undefined || configuredValue.length === 0
      ? LOCAL_DATABASE_URL
      : configuredValue;
  const parsed = new URL(value);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("The storage-contract regression requires a PostgreSQL URL.");
  }
  if (!localHosts.has(parsed.hostname)) {
    throw new Error(
      "The storage-contract regression is restricted to a local PostgreSQL instance."
    );
  }
  return value;
}

function clientConfig(applicationName: string): ClientConfig {
  return {
    application_name: applicationName,
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function rollback(client: Client): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the primary regression failure if the connection already ended.
  }
}

async function close(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // Preserve the primary regression failure if setup only connected some clients.
  }
}

async function receiptCount(client: Client): Promise<number> {
  const result = await client.query<{ receipt_count: number }>(
    `select count(*)::integer as receipt_count
     from private.encrypted_storage_contract_receipts
     where contract_version = 1`
  );
  const count = result.rows[0]?.receipt_count;
  assert(typeof count === "number");
  return count;
}

async function catalogFingerprint(client: Client): Promise<string> {
  const result = await client.query<CatalogRow>(
    `with catalog_items(kind, identity, definition) as (
       select
         'schema'::text,
         namespace.nspname::text,
         concat_ws('|', namespace.nspowner::text, coalesce(namespace.nspacl::text, ''))
       from pg_catalog.pg_namespace as namespace
       where namespace.nspname = any(array['public', 'private'])

       union all

       select
         'relation'::text,
         pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
         concat_ws(
           '|', relation.relkind::text, relation.relpersistence::text,
           relation.relrowsecurity::text, relation.relforcerowsecurity::text,
           relation.relowner::text, coalesce(relation.relacl::text, '')
         )
       from pg_catalog.pg_class as relation
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = any(array['public', 'private'])

       union all

       select
         'column'::text,
         pg_catalog.format(
           '%I.%I.%s:%s', namespace.nspname, relation.relname,
           attribute.attname, attribute.attnum
         ),
         concat_ws(
           '|', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
           attribute.attnotnull::text, attribute.attidentity::text,
           attribute.attgenerated::text, attribute.attisdropped::text,
           coalesce(pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid), '')
         )
       from pg_catalog.pg_attribute as attribute
       join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       left join pg_catalog.pg_attrdef as attribute_default
         on attribute_default.adrelid = attribute.attrelid
        and attribute_default.adnum = attribute.attnum
       where namespace.nspname = any(array['public', 'private'])
         and attribute.attnum > 0

       union all

       select
         'constraint'::text,
         pg_catalog.format(
           '%I.%I.%I', namespace.nspname, relation.relname, constraint_row.conname
         ),
         pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
       from pg_catalog.pg_constraint as constraint_row
       join pg_catalog.pg_class as relation on relation.oid = constraint_row.conrelid
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = any(array['public', 'private'])

       union all

       select
         'function'::text,
         pg_catalog.format(
           '%I.%I(%s)', namespace.nspname, procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid)
         ),
         concat_ws(
           '|', procedure.prokind::text, procedure.provolatile::text,
           procedure.prosecdef::text, procedure.proleakproof::text,
           procedure.proowner::text, coalesce(procedure.proacl::text, ''),
           pg_catalog.pg_get_functiondef(procedure.oid)
         )
       from pg_catalog.pg_proc as procedure
       join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
       where namespace.nspname = any(array['public', 'private'])
         and procedure.prokind = any(array['f'::char, 'p'::char])

       union all

       select
         'trigger'::text,
         pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, trigger.tgname),
         concat_ws(
           '|', trigger.tgenabled::text, trigger.tgisinternal::text,
           pg_catalog.pg_get_triggerdef(trigger.oid, true)
         )
       from pg_catalog.pg_trigger as trigger
       join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = any(array['public', 'private'])

       union all

       select
         'index'::text,
         pg_catalog.format(
           '%I.%I', index_namespace.nspname, index_relation.relname
         ),
         pg_catalog.pg_get_indexdef(index_row.indexrelid)
       from pg_catalog.pg_index as index_row
       join pg_catalog.pg_class as index_relation on index_relation.oid = index_row.indexrelid
       join pg_catalog.pg_namespace as index_namespace
         on index_namespace.oid = index_relation.relnamespace
       where index_namespace.nspname = any(array['public', 'private'])

       union all

       select
         'policy'::text,
         pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, policy.polname),
         concat_ws(
           '|', policy.polcmd::text, policy.polpermissive::text, policy.polroles::text,
           coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
           coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '')
         )
       from pg_catalog.pg_policy as policy
       join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = any(array['public', 'private'])
     )
     select kind, identity, definition
     from catalog_items
     order by kind, identity, definition`
  );
  return createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
}

const inspector = new Client(clientConfig("unfiled-storage-contract-concurrency-inspector"));
const blocker = new Client(clientConfig("unfiled-storage-contract-concurrency-blocker"));
const applicant = new Client(clientConfig("unfiled-storage-contract-concurrency-applicant"));
let blockerTransactionOpen = false;
let applicantTransactionOpen = false;

try {
  await Promise.all([inspector.connect(), blocker.connect(), applicant.connect()]);

  const installation = await inspector.query<{
    apply_function: string | null;
    receipt_table: string | null;
  }>(
    `select
       pg_catalog.to_regprocedure(
         'private.apply_encrypted_storage_contract(text,text)'
       )::text as apply_function,
       pg_catalog.to_regclass(
         'private.encrypted_storage_contract_receipts'
       )::text as receipt_table`
  );
  assert.notEqual(
    installation.rows[0]?.apply_function,
    null,
    "Migration 27 is not installed: the contract application function is missing."
  );
  assert.notEqual(
    installation.rows[0]?.receipt_table,
    null,
    "Migration 27 is not installed: the contract receipt table is missing."
  );

  const initialReceiptCount = await receiptCount(inspector);
  assert.equal(
    initialReceiptCount,
    0,
    "The storage-contract concurrency regression requires a precontract database."
  );

  const functionResult = await inspector.query<{ definition: string }>(
    `select pg_catalog.pg_get_functiondef(
       'private.apply_encrypted_storage_contract(text,text)'::regprocedure
     ) as definition`
  );
  const applyDefinition = functionResult.rows[0]?.definition;
  assert(typeof applyDefinition === "string");
  assert.match(applyDefinition, /pg_try_advisory_xact_lock/u);
  assert.match(applyDefinition, /unfiled:encrypted-storage-contract:v1/u);

  const readinessResult = await inspector.query<{ readiness: Readiness }>(
    "select private.encrypted_storage_contract_readiness() as readiness"
  );
  const readiness = readinessResult.rows[0]?.readiness;
  assert(readiness !== undefined);
  assert.equal(readiness.applied, false);
  const readinessDigest = readiness.readinessDigest;
  assert(typeof readinessDigest === "string");
  assert.match(readinessDigest, /^[0-9a-f]{64}$/u);

  const beforeFingerprint = await catalogFingerprint(inspector);
  const blockerPidResult = await blocker.query<{ pid: number }>(
    "select pg_catalog.pg_backend_pid() as pid"
  );
  const blockerPid = blockerPidResult.rows[0]?.pid;
  assert(typeof blockerPid === "number");

  await blocker.query("begin");
  blockerTransactionOpen = true;
  const lockResult = await blocker.query<{ acquired: boolean }>(
    `select pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended($1, 0)
     ) as acquired`,
    [CONTRACT_LOCK_KEY]
  );
  assert.equal(
    lockResult.rows[0]?.acquired,
    true,
    "Another session already holds the encrypted-storage contract lock."
  );

  // Keep the attempted application inside a transaction as a second safety
  // boundary: even a regression in the advisory key cannot commit contraction.
  await applicant.query("begin");
  applicantTransactionOpen = true;
  await applicant.query("set local statement_timeout = '2s'");
  const startedAt = performance.now();
  let applicationError: unknown;
  try {
    await applicant.query("select private.apply_encrypted_storage_contract($1, $2) as result", [
      CONFIRMATION,
      readinessDigest
    ]);
  } catch (error) {
    applicationError = error;
  }
  const failedAfterMilliseconds = performance.now() - startedAt;

  await applicant.query("rollback");
  applicantTransactionOpen = false;
  await blocker.query("rollback");
  blockerTransactionOpen = false;

  const remainingLocks = await inspector.query<{ lock_count: number }>(
    `select count(*)::integer as lock_count
     from pg_catalog.pg_locks
     where pid = $1 and locktype = 'advisory'`,
    [blockerPid]
  );
  assert.equal(remainingLocks.rows[0]?.lock_count, 0, "The blocker advisory lock leaked.");
  assert.equal(
    await receiptCount(inspector),
    initialReceiptCount,
    "A contract receipt was written."
  );
  assert.equal(
    await catalogFingerprint(inspector),
    beforeFingerprint,
    "The failed concurrent application changed the database schema."
  );

  assert.equal(postgresErrorCode(applicationError), "P0001");
  assert(applicationError instanceof Error);
  assert.equal(applicationError.message, "contract_application_in_progress");
  assert(
    failedAfterMilliseconds < 1_000,
    `Contract application did not fail fast (${failedAfterMilliseconds.toFixed(0)} ms).`
  );

  process.stdout.write(
    `encrypted-storage contract contention failed closed in ${failedAfterMilliseconds.toFixed(0)} ms\n`
  );
} finally {
  if (applicantTransactionOpen) await rollback(applicant);
  if (blockerTransactionOpen) await rollback(blocker);
  await Promise.all([close(inspector), close(blocker), close(applicant)]);
}
