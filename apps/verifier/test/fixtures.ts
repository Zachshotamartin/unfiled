import {
  generateKeyEncryptionKey,
  sealBytes,
  type ContentEnvelopeV1,
  type KeyEncryptionKey
} from "@unfiled/content-crypto";
import type { ManagedKeyRecordV1 } from "@unfiled/key-management";
import { buildPrivateRagIndexDocument, serializePrivateRagIndexDocument } from "@unfiled/search";

import type {
  BuildingGeneration,
  BuildingGenerationPage,
  BuildingIndexItem,
  GenerationVerificationAttestation,
  VerifiedGeneration
} from "../src/database";

export const OWNER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const GENERATION_ID = "igen_01J6M9Q7G4BMKB33GSG3NJ6D1X";
export const INDEX_ID = "irw_01J6M9Q7G4BMKB33GSG3NJ6D1X";
export const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
export const KEY_ID = "key-ai-object-wrap-1";
export const ROOT_ARN =
  "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555";
export const RETIRED_ROOT_ARN =
  "arn:aws:kms:us-west-2:123456789012:key/66666666-7777-4888-9999-aaaaaaaaaaaa";
export const ATTESTATION_DIGEST = "a".repeat(64);

export const generation: BuildingGeneration = Object.freeze({
  generationId: GENERATION_ID,
  state: "building",
  embeddingModelId: "text-embedding-3-small",
  embeddingDimensions: 3,
  envelopeSchemaVersion: 1,
  expectedNoteCount: 1,
  indexedNoteCount: 1,
  revisionToken: "4"
});

export const verification: GenerationVerificationAttestation = Object.freeze({
  domain: "unfiled.rag-generation-verification.v1",
  attestationDigest: ATTESTATION_DIGEST
});

export function keyRecord(overrides: Partial<ManagedKeyRecordV1> = {}): ManagedKeyRecordV1 {
  return Object.freeze({
    schemaVersion: 1,
    ownerId: OWNER_ID,
    keyClass: "ai_assisted",
    purpose: "object_wrap",
    keyId: KEY_ID,
    keyVersion: 1,
    status: "active",
    encryptedKeyMaterial: Buffer.alloc(48, 7).toString("base64url"),
    rootKeyArn: ROOT_ARN,
    createdAt: "2026-08-30T12:00:00.000Z",
    activatedAt: "2026-08-30T12:01:00.000Z",
    retiredAt: null,
    revokedAt: null,
    wrapOperations: 1,
    wrapOperationLimit: 16_777_216,
    rotation: Object.freeze({
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0,
      lastRootRewrappedAt: null
    }),
    ...overrides
  });
}

export async function testKey(): Promise<KeyEncryptionKey> {
  return generateKeyEncryptionKey(KEY_ID);
}

export async function indexEnvelope(
  key: KeyEncryptionKey,
  input: Readonly<{
    indexId?: string;
    noteId?: string;
    revision?: number;
  }> = {}
): Promise<ContentEnvelopeV1> {
  const indexId = input.indexId ?? INDEX_ID;
  const noteId = input.noteId ?? NOTE_ID;
  const revision = input.revision ?? 1;
  const document = buildPrivateRagIndexDocument({
    noteId,
    indexedRevision: revision,
    noteType: "generic",
    spaceId: null,
    title: "Groceries",
    headings: ["Produce"],
    latestSnippet: "Buy apples",
    isOpen: true,
    pinned: false,
    updatedAt: "2026-08-30T12:00:00.000Z",
    searchableText: "Buy apples and oats",
    modelId: generation.embeddingModelId,
    embedding: new Float32Array([0.25, -0.5, 0.75])
  });
  const bytes = serializePrivateRagIndexDocument(document, {
    noteId,
    indexedRevision: revision,
    modelId: generation.embeddingModelId,
    dimensions: generation.embeddingDimensions
  });
  try {
    return await sealBytes(
      bytes,
      { tenantId: OWNER_ID, resourceId: indexId, recordVersion: revision, kind: "note_rag_index" },
      key
    );
  } finally {
    bytes.fill(0);
  }
}

export async function buildingItem(key?: KeyEncryptionKey): Promise<BuildingIndexItem> {
  const resolvedKey = key ?? (await testKey());
  const envelope = await indexEnvelope(resolvedKey);
  return Object.freeze({
    cipher: Object.freeze({
      envelope,
      keyClass: "ai_assisted",
      keyId: KEY_ID,
      keyPurpose: "object_wrap",
      keyVersion: 1
    }),
    encryptedByteLength: Buffer.from(envelope.payload.ciphertext, "base64url").byteLength,
    indexId: INDEX_ID,
    indexedRevision: 1,
    keyRecord: keyRecord(),
    noteId: NOTE_ID
  });
}

export async function buildingPage(key?: KeyEncryptionKey): Promise<BuildingGenerationPage> {
  const item = await buildingItem(key);
  return Object.freeze({
    generation,
    items: Object.freeze([item]),
    ownerId: OWNER_ID,
    page: Object.freeze({
      ciphertextByteBudget: 8_388_608,
      ciphertextBytes: item.encryptedByteLength,
      hasMore: false,
      limit: 50,
      nextCursor: null,
      returnedCount: 1
    }),
    verification
  });
}

export function verifiedGeneration(): VerifiedGeneration {
  return Object.freeze({
    generationId: GENERATION_ID,
    revisionToken: "4",
    verifiedNoteCount: 1,
    attestationDomain: "unfiled.rag-generation-attestation.v1",
    attestationDigest: ATTESTATION_DIGEST,
    embeddingModelId: generation.embeddingModelId,
    embeddingDimensions: generation.embeddingDimensions,
    envelopeSchemaVersion: 1,
    verified: true
  });
}

export function databasePageJson(page: BuildingGenerationPage): unknown {
  const keys = [
    ...new Map(page.items.map((item) => [item.keyRecord.keyId, item.keyRecord])).values()
  ];
  return {
    ownerId: page.ownerId,
    generation: page.generation,
    items: page.items.map((item) => {
      const result: Record<string, unknown> = { ...item };
      delete result.keyRecord;
      return result;
    }),
    keys,
    page: page.page,
    verification: page.verification
  };
}
