import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { importKeyEncryptionKey, sealBytes } from "@unfiled/content-crypto";
import {
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  type EncryptedUserSearchMaterial,
  type EncryptedUserSearchResult,
  type EntityId
} from "@unfiled/contracts";
import {
  parseManagedKeyRecord,
  type DecryptOnlyIntermediateKeyCustodian,
  type ManagedKeyRecordV1
} from "@unfiled/key-management";
import type * as KeyManagementModule from "@unfiled/key-management";
import { buildPrivateRagPayloadValue, serializePrivateRagIndexDocument } from "@unfiled/search";
import { Client, Pool, type PoolClient, type PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { NoteRecord, SearchResponse } from "@/lib/product/types";
import {
  createEncryptedUserSearchCapabilityRpcAdapter,
  createEncryptedUserSearchCapabilityRpcClient
} from "../../web/src/server/search/capability-rpc-adapter";
import { runHybridSearch } from "../../web/src/server/product/hybrid-search";
import { createEncryptedUserSearchClient } from "../../web/src/server/search/search-client";
import { SemanticSearchCoordinator } from "../../web/src/server/search/semantic-search-coordinator";
import {
  SEARCH_EMBEDDING_DIMENSIONS,
  SEARCH_EMBEDDING_MODEL_ID,
  type SearchConfig,
  type SearchTrustedSource
} from "../src/config.js";
import {
  SEARCH_IDENTITY_SQL,
  SEARCH_RPC_NAMES,
  SEARCH_RPC_SQL,
  assertSearchSessionRows,
  createEncryptedUserSearchRepository,
  type SearchDatabaseExecutor
} from "../src/database.js";
import { createOpenAISearchEmbeddingProvider } from "../src/embedding-provider.js";
import { createSearchApp, type SearchApp } from "../src/http.js";
import { createSearchKeyManagementAdapter } from "../src/key-management.js";
import { createSearchDatabaseExecutor } from "../src/postgres.js";
import { createEncryptedUserSearchQuery } from "../src/query.js";

const boundaryMocks = vi.hoisted(() => ({
  createCustodian: vi.fn(),
  createTransport: vi.fn(),
  verifyVercelOidcToken: vi.fn()
}));

vi.mock("@unfiled/key-management", async (importOriginal) => ({
  ...(await importOriginal<typeof KeyManagementModule>()),
  createAwsKmsEnvelopeCustodian: boundaryMocks.createCustodian,
  createVercelOidcKmsTransport: boundaryMocks.createTransport
}));
vi.mock("@vercel/oidc", () => ({
  verifyVercelOidcToken: boundaryMocks.verifyVercelOidcToken
}));

const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const OWNER_ID = "f1000000-0000-4000-8000-000000000001";
const NOTE_ID = "note_01ARZ3NDEKTSV4RRFFQ69G5FAA" as EntityId<"note">;
const INDEX_ID = "irw_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const GENERATION_ID = "igen_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const KEY_ID = "f.search.trust-domain.v1";
const ROOT_KEY_ARN = "arn:aws:kms:us-west-2:123456789012:key/f1000000-0000-4000-8000-000000000001";
const SOURCE_TOKEN = "sourceheader012345.sourcepayload012345.sourcesignature012345";
const WORKLOAD_TOKEN = "workloadheader012345.workloadpayload012345.workloadsignature012345";
const PROVIDER_API_KEY = "sk-milestone-f-trust-domain-fixture";
const SUCCESS_QUERY = "that quote about promising first";
const FAILURE_QUERY = "deterministic provider failure";
const PRIVATE_TITLE = "Roosevelt method";
const PRIVATE_BODY = "Tell people you can do it, then work out how.";
const FIXED_KEY_BYTE = 0x51;
const FIXTURE_TIME = "2026-09-02T12:00:00.000Z";

type RunningSearchServer = Readonly<{
  close(): Promise<void>;
  origin: string;
}>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireRedacted(value: string, sensitiveValues: readonly string[]): void {
  if (sensitiveValues.some((sensitive) => sensitive.length > 0 && value.includes(sensitive))) {
    throw new Error("Search diagnostics exposed fixture content or credentials.");
  }
}

function localDatabaseUrl(): string {
  const configured = process.env.UNFILED_TEST_DATABASE_URL?.trim();
  const value =
    configured === undefined || configured.length === 0 ? LOCAL_DATABASE_URL : configured;
  const parsed = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(parsed.hostname)) {
    throw new Error("The Milestone F trust-domain integration is restricted to local PostgreSQL.");
  }
  return value;
}

function trustedSource(): SearchTrustedSource {
  return Object.freeze({
    audience: "https://vercel.com/team-example",
    environment: "production",
    expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
    issuer: "https://oidc.vercel.com/team-example",
    ownerId: "team_owner123",
    projectId: "prj_webexample",
    projectName: "unfiled-web",
    teamSlug: "team-example"
  });
}

function searchConfig(): SearchConfig {
  return Object.freeze({
    invocation: Object.freeze({ kind: "trusted-source" as const, source: trustedSource() }),
    keyBoundary: Object.freeze({
      activeObjectWrapKeyArn: ROOT_KEY_ARN,
      expectedOidcSubject: "owner:team-example:project:unfiled-search:environment:production",
      kind: "aws-oidc" as const,
      region: "us-west-2",
      retiredObjectWrapKeyArns: Object.freeze([]),
      roleArn: "arn:aws:iam::123456789012:role/unfiled-search-production",
      vercelProjectId: "prj_searchexample"
    }),
    maxRequestBytes: 16_384,
    pipeline: Object.freeze({ kind: "disabled" as const }),
    port: 8_791,
    releaseIdentity: Object.freeze({
      commit: "d".repeat(40),
      deployment: `sha256:${"e".repeat(64)}` as const,
      environment: "production" as const
    }),
    requestTimeoutMs: 10_000,
    runtime: "production" as const
  });
}

function searchMaterial(query: string): EncryptedUserSearchMaterial {
  return {
    continuation: null,
    filters: {
      archive: "exclude" as const,
      privacy: "ai_assisted" as const,
      space: { id: null, mode: "any" as const },
      tagIds: [],
      type: null,
      updatedFrom: null,
      updatedTo: null
    },
    hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
    maxResults: 8,
    pageLimit: 30,
    query,
    requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION
  };
}

function deterministicCrypto(seed: string): Crypto {
  let counter = 0;
  return {
    getRandomValues(array: ArrayBufferView): ArrayBufferView {
      const output = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      let offset = 0;
      while (offset < output.byteLength) {
        const digest = createHash("sha256").update(`${seed}:${counter}`).digest();
        counter += 1;
        const length = Math.min(digest.byteLength, output.byteLength - offset);
        output.set(digest.subarray(0, length), offset);
        digest.fill(0);
        offset += length;
      }
      return array;
    },
    randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
      return "00000000-0000-4000-8000-000000000000";
    },
    subtle: globalThis.crypto.subtle
  } as unknown as Crypto;
}

function fixtureKey(): ManagedKeyRecordV1 {
  return parseManagedKeyRecord({
    activatedAt: FIXTURE_TIME,
    createdAt: FIXTURE_TIME,
    encryptedKeyMaterial: Buffer.from("wrapped-search-trust-domain-key").toString("base64url"),
    keyClass: "ai_assisted",
    keyId: KEY_ID,
    keyVersion: 1,
    ownerId: OWNER_ID,
    purpose: "object_wrap",
    retiredAt: null,
    revokedAt: null,
    rootKeyArn: ROOT_KEY_ARN,
    rotation: {
      lastRootRewrappedAt: null,
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0
    },
    schemaVersion: 1,
    status: "active",
    wrapOperationLimit: 16_777_216,
    wrapOperations: 0
  });
}

async function encryptedFixture(): Promise<
  Readonly<{
    indexEnvelope: Awaited<ReturnType<typeof sealBytes>>;
    indexEncryptedBytes: number;
    key: ManagedKeyRecordV1;
    noteEnvelope: Awaited<ReturnType<typeof sealBytes>>;
  }>
> {
  const key = fixtureKey();
  const rawKey = new Uint8Array(32).fill(FIXED_KEY_BYTE);
  const imported = await importKeyEncryptionKey(KEY_ID, rawKey);
  rawKey.fill(0);
  const notePlaintext = new TextEncoder().encode("encrypted owner note fixture");
  const indexPlaintext = serializePrivateRagIndexDocument(
    buildPrivateRagPayloadValue({
      embedding: (() => {
        const vector = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS);
        vector[0] = 1;
        return vector;
      })(),
      headings: Object.freeze([]),
      indexedRevision: 1,
      isOpen: true,
      latestSnippet: PRIVATE_BODY,
      modelId: SEARCH_EMBEDDING_MODEL_ID,
      noteId: NOTE_ID,
      noteType: "principle",
      pinned: false,
      searchableText: `${PRIVATE_TITLE}\n${PRIVATE_BODY}`,
      spaceId: null,
      title: PRIVATE_TITLE,
      updatedAt: FIXTURE_TIME
    }),
    {
      dimensions: SEARCH_EMBEDDING_DIMENSIONS,
      indexedRevision: 1,
      modelId: SEARCH_EMBEDDING_MODEL_ID,
      noteId: NOTE_ID
    }
  );
  try {
    const [noteEnvelope, indexEnvelope] = await Promise.all([
      sealBytes(
        notePlaintext,
        { kind: "note_content", recordVersion: 1, resourceId: NOTE_ID, tenantId: OWNER_ID },
        imported,
        deterministicCrypto("note")
      ),
      sealBytes(
        indexPlaintext,
        { kind: "note_rag_index", recordVersion: 1, resourceId: INDEX_ID, tenantId: OWNER_ID },
        imported,
        deterministicCrypto("index")
      )
    ]);
    return Object.freeze({
      indexEnvelope,
      indexEncryptedBytes: Buffer.from(indexEnvelope.payload.ciphertext, "base64url").byteLength,
      key,
      noteEnvelope
    });
  } finally {
    notePlaintext.fill(0);
    indexPlaintext.fill(0);
  }
}

async function removeOwner(admin: Client): Promise<void> {
  await admin.query("delete from auth.users where id = $1", [OWNER_ID]);
}

async function installFixture(admin: Client): Promise<ManagedKeyRecordV1> {
  const fixture = await encryptedFixture();
  await removeOwner(admin);
  await admin.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     ) values (
       '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
       'milestone-f-trust-domain@unfiled.local', '', clock_timestamp(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"display_name":"Milestone F trust-domain fixture"}'::jsonb,
       clock_timestamp(), clock_timestamp()
     )`,
    [OWNER_ID]
  );
  await admin.query(
    `insert into public.user_content_keys (
       user_id, key_id, key_class, key_purpose, key_version, schema_version,
       kms_key_id, wrapped_intermediate_key, state, wrap_operations,
       wrap_operation_limit, created_at, activated_at
     ) values ($1, $2, 'ai_assisted', 'object_wrap', 1, 1, $3, $4, 'active', 0, 16777216, $5, $5)`,
    [
      OWNER_ID,
      KEY_ID,
      ROOT_KEY_ARN,
      Buffer.from(fixture.key.encryptedKeyMaterial, "base64url"),
      FIXTURE_TIME
    ]
  );
  await admin.query(
    `insert into public.notes (
       id, user_id, type, title, body_markdown, structured_data, current_revision,
       privacy, created_at, updated_at, content_envelope, content_key_id,
       content_key_class, content_key_purpose, content_key_version
     ) values ($1, $2, 'principle', '[encrypted]', '[encrypted]', '{"schemaVersion":1}'::jsonb, 1,
       'ai_assisted', $3, $3, $4::jsonb, $5, 'ai_assisted', 'object_wrap', 1)`,
    [NOTE_ID, OWNER_ID, FIXTURE_TIME, JSON.stringify(fixture.noteEnvelope), KEY_ID]
  );
  await admin.query(
    `insert into public.rag_index_generations (
       id, user_id, embedding_model_id, embedding_dimensions, envelope_schema_version,
       state, expected_note_count, indexed_note_count, revision_token, activated_at
     ) values ($1, $2, $3, $4, 1, 'active', 1, 1, 1, $5)`,
    [GENERATION_ID, OWNER_ID, SEARCH_EMBEDDING_MODEL_ID, SEARCH_EMBEDDING_DIMENSIONS, FIXTURE_TIME]
  );
  await admin.query(
    `insert into public.note_rag_index (
       id, user_id, note_id, generation_id, indexed_revision, index_envelope,
       index_key_id, index_key_class, index_key_purpose, index_key_version,
       encrypted_byte_length
     ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, 'ai_assisted', 'object_wrap', 1, $7)`,
    [
      INDEX_ID,
      OWNER_ID,
      NOTE_ID,
      GENERATION_ID,
      JSON.stringify(fixture.indexEnvelope),
      KEY_ID,
      fixture.indexEncryptedBytes
    ]
  );
  await admin.query(
    `insert into public.rag_index_generation_verifications (
       user_id, generation_id, revision_token, verified_note_count, attestation,
       attestation_digest, attestation_domain, embedding_model_id,
       embedding_dimensions, envelope_schema_version
     )
     select generation.user_id, generation.id, generation.revision_token,
       generation.indexed_note_count, attestation.value,
       private.request_hash(attestation.value),
       'unfiled.rag-generation-attestation.v1', generation.embedding_model_id,
       generation.embedding_dimensions, generation.envelope_schema_version
     from public.rag_index_generations as generation
     cross join lateral (
       select private.rag_generation_attestation(
         generation.user_id, generation.id, generation.revision_token
       ) as value
     ) as attestation
     where generation.user_id = $1 and generation.id = $2`,
    [OWNER_ID, GENERATION_ID]
  );
  return fixture.key;
}

async function requestBody(incoming: IncomingMessage): Promise<Buffer | undefined> {
  if (incoming.method === "GET" || incoming.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const value of incoming) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const part of value) headers.append(name, part);
    else headers.set(name, value);
  }
  return headers;
}

async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  const body = Buffer.from(await response.arrayBuffer());
  try {
    outgoing.end(body);
  } finally {
    body.fill(0);
  }
}

async function startSearchServer(app: SearchApp): Promise<RunningSearchServer> {
  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const body = await requestBody(incoming);
      try {
        const request = new Request(
          new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`),
          {
            ...(body === undefined ? {} : { body: body.toString("utf8") }),
            headers: requestHeaders(incoming),
            method: incoming.method ?? "GET"
          }
        );
        await sendResponse(await app(request), outgoing);
      } finally {
        body?.fill(0);
      }
    })().catch(() => {
      outgoing.writeHead(500, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8"
      });
      outgoing.end('{"code":"provider_unavailable"}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Search server did not bind.");
  return Object.freeze({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    origin: `http://127.0.0.1:${address.port}`
  });
}

function ownerNote(): NoteRecord {
  return Object.freeze({
    archivedAt: null,
    bodyMarkdown: PRIVATE_BODY,
    createdAt: FIXTURE_TIME,
    currentRevision: 1,
    deletedAt: null,
    id: NOTE_ID,
    isOpen: true,
    links: [],
    pinnedAt: null,
    privacy: "ai_assisted",
    spaceId: null,
    spacePath: null,
    structuredData: { schemaVersion: 1 as const },
    tagIds: [],
    tags: [],
    title: PRIVATE_TITLE,
    type: "principle",
    updatedAt: FIXTURE_TIME
  });
}

function searchRolePool(databaseUrl: string, password: string): Pool {
  const adminUrl = new URL(databaseUrl);
  const config: PoolConfig = {
    application_name: "unfiled-search-trust-domain-integration",
    database: adminUrl.pathname.slice(1),
    host: adminUrl.hostname,
    max: 2,
    password,
    port: Number(adminUrl.port),
    query_timeout: 5_000,
    statement_timeout: 4_000,
    user: "unfiled_search_worker",
    verify(client: PoolClient, done: (error?: Error) => void): void {
      client
        .query({ text: SEARCH_IDENTITY_SQL, values: [] })
        .then((result) => {
          try {
            assertSearchSessionRows(result.rows);
            done();
          } catch {
            done(new Error("Dedicated search identity was denied."));
          }
        })
        .catch(() => done(new Error("Dedicated search identity was denied.")));
    }
  };
  return new Pool(config);
}

describe("Milestone F semantic trust-domain composition", () => {
  it("crosses the real ticket, isolated HTTP, five-RPC, decrypt, rank, and owner-hydration boundaries", async () => {
    const admin = new Client({
      application_name: "unfiled-search-trust-domain-fixture",
      connectionString: localDatabaseUrl(),
      connectionTimeoutMillis: 3_000,
      query_timeout: 5_000
    });
    let rolePool: Pool | undefined;
    let database: ReturnType<typeof createSearchDatabaseExecutor> | undefined;
    let server: RunningSearchServer | undefined;
    let adminConnected = false;
    try {
      await admin.connect();
      adminConnected = true;
      const fixture = await installFixture(admin);

      const rolePassword = randomBytes(24).toString("hex");
      requireCondition(
        /^[0-9a-f]{48}$/u.test(rolePassword),
        "Could not create a bounded search-role test credential."
      );
      await admin.query(`alter role unfiled_search_worker login password '${rolePassword}'`);
      rolePool = searchRolePool(localDatabaseUrl(), rolePassword);
      const identityClient = await rolePool.connect();
      try {
        const identity = await identityClient.query({ text: SEARCH_IDENTITY_SQL, values: [] });
        expect(() => assertSearchSessionRows(identity.rows)).not.toThrow();
      } finally {
        identityClient.release();
      }

      const observedSql: string[] = [];
      const rpcErrors: Readonly<{ code: string | null; label: string }>[] = [];
      database = createSearchDatabaseExecutor(rolePool);
      const executor: SearchDatabaseExecutor = Object.freeze({
        async query(input) {
          observedSql.push(input.text);
          try {
            const result = await (database?.executor.query(input) ??
              Promise.reject(new Error("database closed")));
            return result;
          } catch (error: unknown) {
            const failure = error as Readonly<{ code?: unknown }>;
            rpcErrors.push({
              code: typeof failure.code === "string" ? failure.code : null,
              label:
                Object.entries(SEARCH_RPC_SQL).find(([, sql]) => sql === input.text)?.[0] ??
                "unknown"
            });
            throw error;
          }
        }
      });

      const issuedKeyBytes: Uint8Array[] = [];
      const custodian: DecryptOnlyIntermediateKeyCustodian = Object.freeze({
        async withUnwrappedIntermediateKey(record, use, options) {
          if (options?.signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
          const parsed = parseManagedKeyRecord(record);
          requireCondition(
            JSON.stringify(parsed) === JSON.stringify(fixture),
            "The decrypt-only custodian received the wrong managed key record."
          );
          const keyBytes = new Uint8Array(32).fill(FIXED_KEY_BYTE);
          issuedKeyBytes.push(keyBytes);
          try {
            return await use(keyBytes, parsed);
          } finally {
            keyBytes.fill(0);
          }
        }
      });
      const destroyedTransports: ReturnType<typeof vi.fn>[] = [];
      boundaryMocks.createTransport.mockImplementation(() => {
        const destroy = vi.fn();
        destroyedTransports.push(destroy);
        return Promise.resolve(Object.freeze({ destroy }));
      });
      boundaryMocks.createCustodian.mockReturnValue(custodian);
      boundaryMocks.verifyVercelOidcToken.mockImplementation(() => {
        const source = trustedSource();
        const now = Math.floor(Date.now() / 1_000);
        return Promise.resolve({
          payload: {
            aud: source.audience,
            environment: source.environment,
            exp: now + 300,
            iat: now,
            iss: source.issuer,
            nbf: now,
            owner: source.teamSlug,
            owner_id: source.ownerId,
            project: source.projectName,
            project_id: source.projectId,
            sub: source.expectedSubject
          },
          protectedHeader: { alg: "RS256" }
        });
      });

      const providerCalls: string[] = [];
      const providerFetch: typeof fetch = (_url, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        const parsed = JSON.parse(body) as Readonly<{ input?: unknown }>;
        const query = typeof parsed.input === "string" ? parsed.input : "";
        providerCalls.push(query);
        if (query === FAILURE_QUERY) {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        const embedding = new Array<number>(SEARCH_EMBEDDING_DIMENSIONS).fill(0);
        embedding[0] = 1;
        return Promise.resolve(
          Response.json({
            data: [{ embedding, index: 0, object: "embedding" }],
            model: SEARCH_EMBEDDING_MODEL_ID,
            object: "list",
            usage: { prompt_tokens: 1, total_tokens: 1 }
          })
        );
      };

      const repository = createEncryptedUserSearchRepository(executor);
      const query = createEncryptedUserSearchQuery({
        embeddingProvider: createOpenAISearchEmbeddingProvider({
          apiKey: PROVIDER_API_KEY,
          fetchImplementation: providerFetch
        }),
        repository
      });
      const searchLogs: unknown[] = [];
      const app = createSearchApp({
        config: searchConfig(),
        keyManagement: createSearchKeyManagementAdapter(),
        logger: Object.freeze({ log: (event: unknown) => searchLogs.push(event) }),
        query
      });
      server = await startSearchServer(app);

      const claimSecrets: string[] = [];
      const forwardedBodies: string[] = [];
      const platformFetch: typeof fetch = async (input, init) => {
        const sourceUrl = new URL(input instanceof Request ? input.url : input.toString());
        expect(sourceUrl.origin).toBe("https://unfiled-search-gate.vercel.app");
        expect(sourceUrl.pathname).toBe("/internal/query");
        const headers = new Headers(init?.headers);
        requireCondition(
          headers.get("x-unfiled-trusted-oidc-idp-token") === SOURCE_TOKEN,
          "The web invocation did not carry its trusted-source identity."
        );
        expect(headers.has("x-vercel-oidc-token")).toBe(false);
        const serialized = typeof init?.body === "string" ? init.body : "";
        const invocation = JSON.parse(serialized) as Readonly<Record<string, unknown>>;
        expect(Object.keys(invocation).sort()).toEqual([
          "claimSecret",
          "material",
          "requestDigest",
          "searchId"
        ]);
        requireCondition(
          typeof invocation.claimSecret === "string" && invocation.claimSecret.length > 0,
          "The web invocation omitted its one-use claim secret."
        );
        claimSecrets.push(invocation.claimSecret);
        requireCondition(
          !serialized.includes(OWNER_ID),
          "The web invocation exposed the owner identifier."
        );
        forwardedBodies.push(serialized);
        headers.set("x-vercel-oidc-token", WORKLOAD_TOKEN);
        return fetch(`${server?.origin ?? ""}/internal/query`, { ...init, headers });
      };
      const client = createEncryptedUserSearchClient({
        fetchImplementation: platformFetch,
        getOidcToken: () => Promise.resolve(SOURCE_TOKEN),
        origin: "https://unfiled-search-gate.vercel.app",
        timeoutMs: 10_000
      });
      const capabilityStatuses: number[] = [];
      const rawCapability = createEncryptedUserSearchCapabilityRpcAdapter(
        createEncryptedUserSearchCapabilityRpcClient({
          environment: {
            NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
            NODE_ENV: "test",
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
          },
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            capabilityStatuses.push(response.status);
            return response;
          }
        })
      );
      let secretSeed = 1;
      const coordinator = new SemanticSearchCoordinator({
        capability: rawCapability,
        client,
        ownerId: OWNER_ID,
        randomBytes(size) {
          const result = Buffer.alloc(size, secretSeed);
          secretSeed += 1;
          return result;
        }
      });

      const hydrated = ownerNote();
      const getNote = vi.fn((context: Readonly<{ userId: string }>, noteId: string) => {
        expect(context.userId).toBe(OWNER_ID);
        expect(noteId).toBe(NOTE_ID);
        return Promise.resolve(hydrated);
      });
      const lexical = vi.fn((): Promise<SearchResponse> =>
        Promise.resolve(Object.freeze({ query: SUCCESS_QUERY, results: Object.freeze([]) }))
      );
      let semanticReferences: EncryptedUserSearchResult | undefined;
      const hybrid = await runHybridSearch({
        context: { accessToken: "synthetic-owner-session", userId: OWNER_ID },
        material: searchMaterial(SUCCESS_QUERY),
        options: { archived: "exclude", privacy: "ai_assisted" },
        query: SUCCESS_QUERY,
        repository: { getNote, search: lexical },
        semantic: () => ({
          async search(material, signal) {
            semanticReferences = await coordinator.search(material, signal);
            return semanticReferences;
          }
        })
      });

      if (hybrid.semanticStatus !== "used") {
        const rpcLabels = Object.entries(SEARCH_RPC_SQL).flatMap(([name, sql]) =>
          observedSql.includes(sql) ? [name] : []
        );
        const persistedStates = await admin.query<{ count: string; state: string }>(
          `select state, count(*)::text as count
           from public.encrypted_user_search_capabilities
           where user_id = $1 group by state order by state`,
          [OWNER_ID]
        );
        throw new Error(
          `Semantic composition failed: ${JSON.stringify({
            capabilityStatuses,
            forwardedRequestCount: forwardedBodies.length,
            hydratedNoteCount: getNote.mock.calls.length,
            kmsSessionCount: boundaryMocks.createTransport.mock.calls.length,
            providerCallCount: providerCalls.length,
            rpcErrors,
            rpcLabels,
            searchLogCount: searchLogs.length,
            ticketStates: persistedStates.rows
          })}`
        );
      }
      expect(hybrid.semanticStatus).toBe("used");
      expect(hybrid.response.results).toHaveLength(1);
      requireCondition(
        hybrid.response.results[0]?.note === hydrated,
        "The semantic reference was not hydrated through the owner repository."
      );
      requireCondition(
        hybrid.response.results[0].snippet.includes(PRIVATE_BODY),
        "Owner-side hydration did not produce the expected private snippet."
      );
      expect(getNote).toHaveBeenCalledOnce();
      expect(semanticReferences?.items).toHaveLength(1);
      expect(Object.keys(semanticReferences?.items[0] ?? {}).sort()).toEqual([
        "indexedRevision",
        "noteId",
        "score"
      ]);
      requireRedacted(JSON.stringify(semanticReferences), [PRIVATE_TITLE, PRIVATE_BODY]);

      const successfulInvocation = forwardedBodies[0];
      if (successfulInvocation === undefined) throw new Error("Missing successful invocation.");
      const replay = await fetch(`${server.origin}/internal/query`, {
        body: successfulInvocation,
        headers: {
          "content-type": "application/json",
          "x-vercel-oidc-token": WORKLOAD_TOKEN,
          "x-unfiled-trusted-oidc-idp-token": SOURCE_TOKEN
        },
        method: "POST"
      });
      expect(replay.status).toBe(503);
      expect(await replay.json()).toMatchObject({ code: "provider_unavailable" });

      const failureLexical = vi
        .fn<() => Promise<SearchResponse>>()
        .mockResolvedValueOnce(Object.freeze({ query: FAILURE_QUERY, results: Object.freeze([]) }))
        .mockResolvedValueOnce(
          Object.freeze({
            query: FAILURE_QUERY,
            results: Object.freeze([
              Object.freeze({ note: hydrated, score: 0.4, snippet: "fresh lexical fixture" })
            ])
          })
        );
      const fallback = await runHybridSearch({
        context: { accessToken: "synthetic-owner-session", userId: OWNER_ID },
        material: searchMaterial(FAILURE_QUERY),
        options: { archived: "exclude", privacy: "ai_assisted" },
        query: FAILURE_QUERY,
        repository: { getNote, search: failureLexical },
        semantic: () => ({ search: (material, signal) => coordinator.search(material, signal) })
      });
      expect(fallback.semanticStatus).toBe("fallback");
      expect(fallback.semanticContinuation).toBeNull();
      expect(fallback.response.results).toHaveLength(1);
      expect(fallback.response.results[0]?.note.id).toBe(NOTE_ID);
      expect(failureLexical).toHaveBeenCalledTimes(2);

      const states = await admin.query<{
        claim_secret_digest: string | null;
        failure_code: string | null;
        lease_secret_digest: string | null;
        state: string;
      }>(
        `select state, claim_secret_digest, lease_secret_digest, failure_code
         from public.encrypted_user_search_capabilities
         where user_id = $1 order by state`,
        [OWNER_ID]
      );
      expect(states.rows).toEqual([
        {
          claim_secret_digest: null,
          failure_code: null,
          lease_secret_digest: null,
          state: "completed"
        },
        {
          claim_secret_digest: null,
          failure_code: "provider_unavailable",
          lease_secret_digest: null,
          state: "failed"
        }
      ]);

      expect(new Set(observedSql)).toEqual(new Set(Object.values(SEARCH_RPC_SQL)));
      expect(SEARCH_RPC_NAMES).toHaveLength(5);
      const allowedSql = new Set<string>(Object.values(SEARCH_RPC_SQL));
      expect(observedSql.every((sql) => allowedSql.has(sql))).toBe(true);
      requireCondition(
        providerCalls.length === 3 &&
          providerCalls[0] === SUCCESS_QUERY &&
          providerCalls[1] === FAILURE_QUERY &&
          providerCalls[2] === FAILURE_QUERY,
        "The deterministic provider call sequence drifted."
      );
      expect(boundaryMocks.verifyVercelOidcToken).toHaveBeenCalledTimes(3);
      requireCondition(
        boundaryMocks.verifyVercelOidcToken.mock.calls.every(
          (call) => call[0] === SOURCE_TOKEN && call[1] !== null && typeof call[1] === "object"
        ),
        "The target did not independently verify the trusted-source token."
      );
      expect(boundaryMocks.createTransport).toHaveBeenCalledTimes(3);
      expect(boundaryMocks.createCustodian).toHaveBeenCalledTimes(3);
      expect(issuedKeyBytes).toHaveLength(1);
      expect(issuedKeyBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(destroyedTransports).toHaveLength(3);
      expect(destroyedTransports.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
      requireRedacted(JSON.stringify(searchLogs), [
        SUCCESS_QUERY,
        FAILURE_QUERY,
        PRIVATE_TITLE,
        PRIVATE_BODY,
        PROVIDER_API_KEY,
        SOURCE_TOKEN,
        WORKLOAD_TOKEN,
        OWNER_ID,
        fixture.encryptedKeyMaterial,
        rolePassword,
        ...claimSecrets
      ]);
      expect(SOURCE_TOKEN).not.toBe(WORKLOAD_TOKEN);
    } finally {
      await server?.close().catch(() => undefined);
      await database?.close().catch(() => undefined);
      if (adminConnected) {
        await removeOwner(admin).catch(() => undefined);
        await admin
          .query("alter role unfiled_search_worker nologin password null")
          .catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    }
  }, 60_000);
});
