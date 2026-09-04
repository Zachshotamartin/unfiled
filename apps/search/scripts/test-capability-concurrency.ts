import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { Client, type ClientConfig } from "pg";

const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const GENERATION_ID = "igen_95000000000000000000000001";
const SEARCH_ID = "95000000-0000-4000-8000-000000000001";
const CLAIM_SECRET = "unfiled-search-concurrent-claim-secret-0001";
const REQUEST_DIGEST = createHash("sha256")
  .update("unfiled-search-concurrency-request-v1")
  .digest("hex");
const FILTER_DIGEST = createHash("sha256")
  .update("unfiled-search-concurrency-filter-v1")
  .digest("hex");
const CLAIM_SECRET_DIGEST = createHash("sha256").update(CLAIM_SECRET).digest("hex");
const ATTESTATION_DIGEST = createHash("sha256")
  .update("unfiled-search-concurrency-attestation-v1")
  .digest("hex");
const CONTENDER_COUNT = 8;

function databaseUrl(): string {
  const configured = process.env.UNFILED_TEST_DATABASE_URL?.trim();
  const value =
    configured === undefined || configured.length === 0 ? LOCAL_DATABASE_URL : configured;
  const parsed = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(parsed.hostname)) {
    throw new Error(
      "The search-capability concurrency regression is restricted to local PostgreSQL."
    );
  }
  return value;
}

function clientConfig(applicationName: string): ClientConfig {
  return {
    application_name: applicationName,
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000
  };
}

function postgresError(error: unknown): Readonly<{ code?: string; message?: string }> {
  if (error === null || typeof error !== "object") return {};
  return {
    ...(typeof (error as { code?: unknown }).code === "string"
      ? { code: (error as { code: string }).code }
      : {}),
    ...(typeof (error as { message?: unknown }).message === "string"
      ? { message: (error as { message: string }).message }
      : {})
  };
}

async function close(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // Preserve the primary regression failure if PostgreSQL already closed.
  }
}

async function removeFixture(client: Client): Promise<void> {
  await client.query("delete from public.encrypted_user_search_capabilities where id = $1", [
    SEARCH_ID
  ]);
  await client.query("delete from public.rag_index_generations where id = $1", [GENERATION_ID]);
}

const inspector = new Client(clientConfig("unfiled-search-capability-concurrency-inspector"));
const contenders = Array.from(
  { length: CONTENDER_COUNT },
  (_, index) => new Client(clientConfig(`unfiled-search-capability-contender-${index + 1}`))
);
let inspectorConnected = false;

type ClaimResult = Readonly<Record<string, unknown>>;
type ClaimOutcome =
  Readonly<{ ok: true; result: ClaimResult }> | Readonly<{ error: unknown; ok: false }>;

try {
  await inspector.connect();
  inspectorConnected = true;
  await Promise.all(contenders.map(async (client) => client.connect()));
  await removeFixture(inspector);

  await inspector.query(
    `insert into public.rag_index_generations (
       id, user_id, embedding_model_id, embedding_dimensions,
       envelope_schema_version, state, expected_note_count,
       indexed_note_count, revision_token
     ) values ($1, $2, 'text-embedding-3-small', 1536, 1, 'building', 0, 0, 1)`,
    [GENERATION_ID, OWNER_ID]
  );
  await inspector.query(
    `insert into public.encrypted_user_search_capabilities (
       id, user_id, request_digest, filter_digest, claim_secret_digest,
       generation_id, generation_revision_token, embedding_model_id,
       embedding_dimensions, envelope_schema_version,
       generation_attestation_digest, created_at, claim_expires_at
     ) values (
       $1, $2, $3, $4, $5, $6, 1, 'text-embedding-3-small',
       1536, 1, $7, now(), now() + interval '30 seconds'
     )`,
    [
      SEARCH_ID,
      OWNER_ID,
      REQUEST_DIGEST,
      FILTER_DIGEST,
      CLAIM_SECRET_DIGEST,
      GENERATION_ID,
      ATTESTATION_DIGEST
    ]
  );

  const outcomes = await Promise.all<ClaimOutcome>(
    contenders.map(async (client) => {
      try {
        const response = await client.query<{ result: ClaimResult }>(
          `select private.claim_encrypted_user_search_impl(
             $1::uuid, $2::text, $3::text
           ) as result`,
          [SEARCH_ID, CLAIM_SECRET, REQUEST_DIGEST]
        );
        const result = response.rows[0]?.result;
        assert(result !== undefined);
        return { ok: true, result };
      } catch (error) {
        return { error, ok: false };
      }
    })
  );
  const fulfilled = outcomes.filter(
    (outcome): outcome is Extract<ClaimOutcome, { ok: true }> => outcome.ok
  );
  const rejected = outcomes.filter(
    (outcome): outcome is Extract<ClaimOutcome, { ok: false }> => !outcome.ok
  );

  assert.equal(fulfilled.length, 1, "Exactly one concurrent claim must win.");
  assert.equal(rejected.length, CONTENDER_COUNT - 1, "Every losing claim must fail closed.");
  for (const outcome of rejected) {
    const error = postgresError(outcome.error);
    assert.equal(error.code, "42501");
    assert.equal(error.message, "invalid_or_expired_search_capability");
  }

  const winningResult = fulfilled[0]?.result;
  assert(winningResult !== undefined);
  assert.equal(winningResult.searchId, SEARCH_ID);
  assert.equal(winningResult.ownerId, OWNER_ID);
  assert.equal(winningResult.requestDigest, REQUEST_DIGEST);
  assert.equal(typeof winningResult.leaseToken, "string");

  const persisted = await inspector.query<{
    claim_secret_digest: string | null;
    lease_secret_digest: string | null;
    state: string;
  }>(
    `select state, claim_secret_digest, lease_secret_digest
     from public.encrypted_user_search_capabilities
     where id = $1`,
    [SEARCH_ID]
  );
  const persistedRow = persisted.rows[0];
  assert(persistedRow !== undefined);
  assert.equal(persistedRow.state, "leased");
  assert.equal(persistedRow.claim_secret_digest, null);
  assert.match(persistedRow.lease_secret_digest ?? "", /^[0-9a-f]{64}$/u);

  process.stdout.write(
    `Search capability concurrency passed: 1 winner, ${CONTENDER_COUNT - 1} denied.\n`
  );
} finally {
  try {
    if (inspectorConnected) await removeFixture(inspector);
  } finally {
    await Promise.all([close(inspector), ...contenders.map(close)]);
  }
}
