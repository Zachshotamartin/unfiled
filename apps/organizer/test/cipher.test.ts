import {
  materializeAuthorizedOrganizationPlan,
  type MaterializedOrganizationCommand,
  type StableOrganizationIds
} from "@unfiled/ai-routing";
import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  jsonPayloadCodec,
  type AggregateContentKind,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type EncryptedFieldRpcValue,
  type JsonValue,
  type KeyedMacRecord,
  type KeyedMacRpcValue,
  type ObjectWrapReservation
} from "@unfiled/encrypted-aggregate";
import {
  createManagedKeyResolver,
  parseManagedKeyRecord,
  type IntermediateKeyCustodian,
  type ManagedKeyRecordV1,
  type ManagedKeyStore
} from "@unfiled/key-management";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createProductionOrganizerCipher } from "../src/cipher.js";
import type {
  AtomicOrganizerCommand,
  ClaimedOrganizerJob,
  EncryptedCandidate,
  EncryptedProjection,
  OrganizerPreparation
} from "../src/drain.js";
import { OrganizerUnavailableError } from "../src/errors.js";
import type * as OrganizerKeyManagementModule from "../src/key-management.js";
import type {
  DecryptedCandidate,
  DecryptedCapture,
  OrganizerCaptureControls
} from "../src/planner.js";

const keyManagementMocks = vi.hoisted(() => ({
  custodianForOrganizerAuthority: vi.fn()
}));

vi.mock("../src/key-management.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OrganizerKeyManagementModule>()),
  custodianForOrganizerAuthority: keyManagementMocks.custodianForOrganizerAuthority
}));

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER_ID = "33333333-3333-4333-8333-333333333333";
const OCCURRED_AT = "2026-08-31T19:58:00.000Z";
const AUTHORITY = Object.freeze({}) as OrganizerKeyManagementModule.OrganizerKeyAuthority;
const SIGNAL = new AbortController().signal;
const AUTO_ROUTING_DECISION = Object.freeze({
  autoApply: true,
  band: "auto" as const,
  failClosed: false,
  margin: 1,
  reasons: Object.freeze(["automatic_threshold_met" as const]),
  score: 1
});
const IDS = Object.freeze({
  block: "blk_01ARZ3NDEKTSV4RRFFQ69G5FAJ",
  candidate: "note_01ARZ3NDEKTSV4RRFFQ69G5FAB",
  candidateTwo: "note_01ARZ3NDEKTSV4RRFFQ69G5FAK",
  candidateNote: "note_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  candidateNoteTwo: "note_01ARZ3NDEKTSV4RRFFQ69G5FAM",
  capture: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  createdNote: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  decision: "dec_01ARZ3NDEKTSV4RRFFQ69G5FAC",
  job: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  mutation: "mut_01ARZ3NDEKTSV4RRFFQ69G5FAD",
  review: "rvw_01ARZ3NDEKTSV4RRFFQ69G5FAE",
  revision: "rev_01ARZ3NDEKTSV4RRFFQ69G5FAF",
  space: "spc_01ARZ3NDEKTSV4RRFFQ69G5FAG",
  tag: "tag_01ARZ3NDEKTSV4RRFFQ69G5FAH"
} as const);
const RESERVATIONS = Object.freeze({
  decision: "11111111-1111-4111-8111-111111111111",
  generatedBlock: "11111111-1111-4111-8111-111111111115",
  noteWrite: "11111111-1111-4111-8111-111111111112",
  receipt: "11111111-1111-4111-8111-111111111113",
  review: "11111111-1111-4111-8111-111111111114"
});
const CONTROLS: OrganizerCaptureControls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: null
});

function managedKey(
  purpose: "content_mac" | "object_wrap",
  ownerId = OWNER_ID
): ManagedKeyRecordV1 {
  return parseManagedKeyRecord({
    activatedAt: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T12:00:00.000Z",
    encryptedKeyMaterial: "AQIDBA",
    keyClass: "ai_assisted",
    keyId: `key.ai.${purpose}.v1`,
    keyVersion: 1,
    ownerId,
    purpose,
    retiredAt: null,
    revokedAt: null,
    rootKeyArn:
      purpose === "object_wrap"
        ? "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111"
        : "arn:aws:kms:us-west-2:123456789012:key/22222222-2222-4222-8222-222222222222",
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

const OBJECT_KEY = managedKey("object_wrap");
const CONTENT_MAC_KEY = managedKey("content_mac");

function keyStore(records: readonly ManagedKeyRecordV1[]): ManagedKeyStore {
  return Object.freeze({
    findActive(binding) {
      return Promise.resolve(
        records.find(
          (record) =>
            record.status === "active" &&
            record.ownerId === binding.ownerId &&
            record.keyClass === binding.keyClass &&
            record.purpose === binding.purpose
        ) ?? null
      );
    },
    findById(selector) {
      return Promise.resolve(
        records.find(
          (record) =>
            record.ownerId === selector.ownerId &&
            record.keyClass === selector.keyClass &&
            record.purpose === selector.purpose &&
            record.keyId === selector.keyId &&
            (record.status === "active" || record.status === "retired")
        ) ?? null
      );
    }
  });
}

function testCustodian(): IntermediateKeyCustodian {
  return Object.freeze({
    withGeneratedIntermediateKey() {
      return Promise.reject(new Error("test sealing uses prepared managed keys"));
    },
    async withUnwrappedIntermediateKey(recordValue, use, options) {
      if (options?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      const record = parseManagedKeyRecord(recordValue);
      const bytes = new Uint8Array(32).fill(record.purpose === "object_wrap" ? 17 : 29);
      try {
        return await use(bytes, record);
      } finally {
        bytes.fill(0);
      }
    }
  });
}

type TestCrypto = Readonly<{
  aggregate: EncryptedAggregateService;
  access: ReturnType<typeof authorizeAggregateOwner>;
}>;

function testCrypto(custodian: IntermediateKeyCustodian): TestCrypto {
  const records = [OBJECT_KEY, CONTENT_MAC_KEY];
  const resolver = createManagedKeyResolver({
    custodian,
    store: keyStore(records),
    workload: "organization_worker"
  });
  let reservationIndex = 0;
  const aggregate = createEncryptedAggregateService({
    keyResolver: resolver,
    objectWrapReservations: {
      reserveObjectWrappingKey(): Promise<ObjectWrapReservation> {
        reservationIndex += 1;
        return Promise.resolve(
          Object.freeze({
            reference: Object.freeze({
              keyClass: OBJECT_KEY.keyClass,
              keyId: OBJECT_KEY.keyId,
              keyVersion: OBJECT_KEY.keyVersion,
              ownerId: OBJECT_KEY.ownerId,
              purpose: "object_wrap" as const
            }),
            reservationId: `fixture-reservation-${reservationIndex}`
          })
        );
      }
    }
  });
  return Object.freeze({
    aggregate,
    access: authorizeAggregateOwner({
      authenticatedOwnerId: OWNER_ID,
      resourceOwnerId: OWNER_ID
    })
  });
}

function encryptedProjection<Kind extends AggregateContentKind>(
  record: EncryptedAggregateRecord<Kind>
): EncryptedProjection {
  return Object.freeze({
    cipher: Object.freeze({
      envelope: record.envelope,
      keyClass: record.keyClass,
      keyId: record.keyId,
      keyPurpose: record.keyPurpose,
      keyVersion: record.keyVersion
    }),
    key: OBJECT_KEY,
    recordVersion: record.recordVersion,
    resourceId: record.resourceId
  });
}

function job(
  source: EncryptedProjection = encryptedProjectionPlaceholder(),
  commandProjection: ClaimedOrganizerJob["commandProjection"] = "encrypted_only"
): ClaimedOrganizerJob {
  return Object.freeze({
    accountCaptureOrdinal: 6,
    attempt: 1,
    captureId: IDS.capture,
    clientTimezone: "America/Los_Angeles",
    controls: CONTROLS,
    jobId: IDS.job,
    leaseExpiresAt: "2026-08-31T20:00:00.000Z",
    leaseToken: "44444444-4444-4444-8444-444444444444",
    modelId: "gpt-5.4-mini-2026-03-17",
    occurredAt: OCCURRED_AT,
    ownerId: OWNER_ID,
    promptVersion: "routing-v1",
    replanCount: 0,
    routingEffort: "standard",
    routingMode: "balanced",
    schemaVersion: 1,
    source,
    expansionStyle: "brief",
    commandProjection
  });
}

function encryptedProjectionPlaceholder(): EncryptedProjection {
  return Object.freeze({
    cipher: Object.freeze({}),
    key: Object.freeze({}),
    recordVersion: 1,
    resourceId: IDS.capture
  });
}

function preparation(mode: "append" | "create", expectedRevision: number | null) {
  return Object.freeze({
    expectedRevision,
    ids: Object.freeze({
      decisionId: IDS.decision,
      generatedBlockId: IDS.block,
      mutationId: IDS.mutation,
      reviewItemId: IDS.review,
      revisionId: IDS.revision
    }),
    jobId: IDS.job,
    keys: Object.freeze({ contentMac: CONTENT_MAC_KEY, objectWrap: OBJECT_KEY }),
    mode,
    noteId: mode === "append" ? IDS.candidateNote : IDS.createdNote,
    replanCount: 0,
    replayed: false,
    reservations: Object.freeze({
      decision: Object.freeze({ operationCount: 1 as const, reservationId: RESERVATIONS.decision }),
      generatedBlock: Object.freeze({
        operationCount: 1 as const,
        reservationId: RESERVATIONS.generatedBlock
      }),
      noteWrite: Object.freeze({
        operationCount: 4 as const,
        reservationId: RESERVATIONS.noteWrite
      }),
      receipt: Object.freeze({ operationCount: 1 as const, reservationId: RESERVATIONS.receipt }),
      review: Object.freeze({ operationCount: 1 as const, reservationId: RESERVATIONS.review })
    }),
    targetRevision: (expectedRevision ?? 0) + 1
  } satisfies OrganizerPreparation);
}

function stableIds(
  kind: "append" | "create" | "review",
  generatedExpansion = false
): StableOrganizationIds {
  return Object.freeze({
    createdNoteId: kind === "create" ? IDS.createdNote : null,
    decisionId: IDS.decision,
    generatedBlockId: generatedExpansion ? IDS.block : null,
    mutationId: kind === "review" ? null : IDS.mutation,
    reviewItemId: kind === "review" || generatedExpansion ? IDS.review : null,
    revisionId: kind === "review" ? null : IDS.revision
  });
}

function manifest(...candidates: readonly DecryptedCandidate[]) {
  return Object.freeze({
    authorizedSpaceIds: [IDS.space],
    authorizedTagIds: [IDS.tag],
    candidates: candidates.map((candidate) =>
      Object.freeze({
        candidateId: candidate.candidateId,
        isOpen: candidate.isOpen,
        noteId: candidate.noteId,
        noteType: candidate.noteType,
        revision: candidate.revision
      })
    ),
    controls: CONTROLS,
    schemaVersion: 1 as const
  });
}

function createPlan(rawContent: string): MaterializedOrganizationCommand {
  return materializeAuthorizedOrganizationPlan({
    captureText: rawContent,
    manifest: manifest(),
    plan: {
      alternatives: [],
      captureKind: "freeform",
      decision: "create_note",
      destination: {
        candidateId: null,
        newNote: {
          noteType: "generic",
          spaceCandidateId: IDS.space,
          title: "Cipher canary title"
        }
      },
      generatedExpansion: null,
      operations: [{ content: rawContent, type: "append_raw" }],
      reasonCodes: ["no_candidate_fit"],
      schemaVersion: 1
    },
    stableIds: stableIds("create")
  });
}

function appendPlan(
  rawContent: string,
  candidate: DecryptedCandidate,
  generatedExpansion: Readonly<{
    kind: "summary" | "interpretation" | "suggestion" | "label";
    text: string;
  }> | null = null
): MaterializedOrganizationCommand {
  return materializeAuthorizedOrganizationPlan({
    captureText: rawContent,
    manifest: manifest(candidate),
    plan: {
      alternatives: [],
      captureKind: "freeform",
      decision: "append_to_note",
      destination: { candidateId: candidate.candidateId, newNote: null },
      generatedExpansion,
      operations: [{ content: rawContent, type: "append_raw" }],
      reasonCodes: ["semantic_match", "type_match"],
      schemaVersion: 1
    },
    stableIds: stableIds("append", generatedExpansion !== null)
  });
}

function reviewPlan(rawContent: string): MaterializedOrganizationCommand {
  return materializeAuthorizedOrganizationPlan({
    captureText: rawContent,
    manifest: manifest(),
    plan: {
      alternatives: [],
      captureKind: "freeform",
      decision: "needs_review",
      destination: { candidateId: null, newNote: null },
      generatedExpansion: null,
      operations: [{ content: rawContent, type: "append_raw" }],
      reasonCodes: ["ambiguous_intent"],
      schemaVersion: 1
    },
    stableIds: stableIds("review")
  });
}

function capture(rawContent: string): DecryptedCapture {
  return Object.freeze({ controls: CONTROLS, rawContent });
}

function rpcRecord<Kind extends AggregateContentKind>(
  field: EncryptedFieldRpcValue<Kind>,
  coordinates: Readonly<{
    kind: Kind;
    ownerId?: string;
    recordVersion: number;
    resourceId: string;
  }>
): EncryptedAggregateRecord<Kind> {
  return Object.freeze({
    envelope: field.envelope,
    keyClass: field.keyClass,
    keyId: field.keyId,
    keyPurpose: field.keyPurpose,
    keyVersion: field.keyVersion,
    kind: coordinates.kind,
    ownerId: coordinates.ownerId ?? OWNER_ID,
    recordVersion: coordinates.recordVersion,
    resourceId: coordinates.resourceId
  });
}

function macRecord(field: KeyedMacRpcValue): KeyedMacRecord {
  return Object.freeze({
    keyClass: field.keyClass,
    keyId: field.keyId,
    keyPurpose: field.keyPurpose,
    keyVersion: field.keyVersion,
    value: field.mac
  });
}

type RoutedWrite = Readonly<{
  mutation: Readonly<{
    cipher: EncryptedFieldRpcValue<"note_mutation">;
    id: typeof IDS.mutation;
    inverse: unknown;
    operations: unknown;
  }>;
  noteCipher: EncryptedFieldRpcValue<"note_content">;
  noteState: Readonly<Record<string, unknown>>;
  requestMac: KeyedMacRpcValue;
  responseCipher: EncryptedFieldRpcValue<"idempotency_response">;
  revision: Readonly<{
    actor: string;
    cipher: EncryptedFieldRpcValue<"note_revision">;
    id: typeof IDS.revision;
    mac: KeyedMacRpcValue;
    source: string;
  }>;
  verification: Readonly<{
    idempotencyResponse: KeyedMacRpcValue;
    noteContent: KeyedMacRpcValue;
    noteMutation: KeyedMacRpcValue;
  }>;
}>;

type SealedSurface<Kind extends AggregateContentKind> = Readonly<{
  cipher: EncryptedFieldRpcValue<Kind>;
  verificationMac: KeyedMacRpcValue;
}>;

type SealCommandInput = Parameters<
  ReturnType<typeof createProductionOrganizerCipher>["sealCommand"]
>[0];

function routedWrite(command: AtomicOrganizerCommand): RoutedWrite {
  expect(command.noteWrite).not.toBeNull();
  return command.noteWrite as RoutedWrite;
}

function sealedSurface<Kind extends AggregateContentKind>(value: unknown): SealedSurface<Kind> {
  expect(value).not.toBeNull();
  return value as SealedSurface<Kind>;
}

async function candidateFixture(
  crypto: TestCrypto,
  values: Partial<EncryptedCandidate> = {}
): Promise<EncryptedCandidate> {
  const revision = values.revision ?? 2;
  const noteId = values.noteId ?? IDS.candidateNote;
  const sealed = await crypto.aggregate.sealNoteContent(crypto.access, {
    currentRevision: revision,
    noteId,
    payload: {
      bodyMarkdown: "Existing exact source.",
      schemaVersion: 1,
      structuredData: { schemaVersion: 1 },
      title: "Existing canary title"
    },
    privacy: "ai_assisted"
  });
  return Object.freeze({
    archivedAt: null,
    candidateId: IDS.candidate,
    dailyDate: "2026-08-31",
    deletedAt: null,
    isOpen: true,
    links: Object.freeze([]),
    noteId,
    noteType: "generic",
    pinnedAt: null,
    revision,
    source: encryptedProjection(sealed),
    spaceId: null,
    tagIds: Object.freeze([]),
    updatedAt: "2026-08-31T19:00:00.000Z",
    ...values
  });
}

async function captureProjection(
  crypto: TestCrypto,
  rawContent: string
): Promise<EncryptedProjection> {
  const sealed = await crypto.aggregate.sealCapture(crypto.access, {
    captureId: IDS.capture,
    payload: { rawContent, schemaVersion: 1 },
    privacy: "ai_assisted",
    recordVersion: 1
  });
  return Object.freeze({
    ...encryptedProjection(sealed.encrypted),
    contentMac: Object.freeze({
      keyClass: sealed.contentMac.keyClass,
      keyId: sealed.contentMac.keyId,
      keyPurpose: sealed.contentMac.keyPurpose,
      keyVersion: sealed.contentMac.keyVersion,
      value: sealed.contentMac.value
    }),
    contentMacKey: CONTENT_MAC_KEY
  });
}

async function openRoutedPayloads(
  crypto: TestCrypto,
  command: AtomicOrganizerCommand,
  expected: Readonly<{
    mode: "append" | "create";
    noteId: typeof IDS.candidateNote | typeof IDS.createdNote;
  }>
) {
  const write = routedWrite(command);
  const revision = expected.mode === "create" ? 1 : 3;
  const transition = Object.freeze({
    after: "ai_assisted" as const,
    before: expected.mode === "create" ? null : ("ai_assisted" as const)
  });
  const noteContent = await crypto.aggregate.openNoteContent(
    crypto.access,
    rpcRecord(write.noteCipher, {
      kind: "note_content",
      recordVersion: revision,
      resourceId: expected.noteId
    }),
    { currentRevision: revision, noteId: expected.noteId, privacy: "ai_assisted" }
  );
  const noteRevision = await crypto.aggregate.openNoteRevision(
    crypto.access,
    {
      contentMac: macRecord(write.revision.mac),
      encrypted: rpcRecord(write.revision.cipher, {
        kind: "note_revision",
        recordVersion: revision,
        resourceId: IDS.revision
      })
    },
    { revision, revisionId: IDS.revision, transition }
  );
  const noteMutation = await crypto.aggregate.openNoteMutation(
    crypto.access,
    rpcRecord(write.mutation.cipher, {
      kind: "note_mutation",
      recordVersion: revision,
      resourceId: IDS.mutation
    }),
    { afterRevision: revision, mutationId: IDS.mutation, transition }
  );
  const responseCodec = jsonPayloadCodec<
    Readonly<{
      jobId: string;
      mutationId: string;
      noteId: string;
      revision: number;
      schemaVersion: 1;
    }> &
      JsonValue
  >();
  const requestCodec = jsonPayloadCodec<
    Readonly<{ captureId: string; decisionId: string; jobId: string }> & JsonValue
  >();
  const idempotencyRecord = Object.freeze({
    idempotencyKey: `organizer:${IDS.job}`,
    keyClass: "ai_assisted" as const,
    ownerId: OWNER_ID,
    requestMac: macRecord(write.requestMac),
    response: rpcRecord(write.responseCipher, {
      kind: "idempotency_response",
      recordVersion: 1,
      resourceId: `idempotency:organizer:${IDS.job}`
    })
  });
  await expect(
    crypto.aggregate.verifyIdempotencyRequest(crypto.access, idempotencyRecord, {
      idempotencyKey: `organizer:${IDS.job}`,
      logicalRequest: {
        expectedRevision: expected.mode === "create" ? null : 2,
        payload: { captureId: IDS.capture, decisionId: IDS.decision, jobId: IDS.job },
        schemaVersion: 1,
        scope:
          expected.mode === "create" ? "create_encrypted_note" : "apply_encrypted_note_mutation",
        targetResourceId: expected.noteId
      },
      requestCodec,
      transition
    })
  ).resolves.toBe(true);
  const response = await crypto.aggregate.openIdempotencyResponseForVerification(
    crypto.access,
    idempotencyRecord,
    { idempotencyKey: `organizer:${IDS.job}`, responseCodec }
  );
  const verified = await Promise.all([
    crypto.aggregate.verifyAggregateVerificationMac(
      crypto.access,
      macRecord(write.verification.noteContent),
      {
        noteId: expected.noteId,
        payload: noteContent,
        privacy: "ai_assisted",
        recordVersion: revision,
        surface: "note_content"
      }
    ),
    crypto.aggregate.verifyAggregateVerificationMac(
      crypto.access,
      macRecord(write.verification.noteMutation),
      {
        mutationId: IDS.mutation,
        payload: noteMutation,
        recordVersion: revision,
        surface: "note_mutation"
      }
    ),
    crypto.aggregate.verifyAggregateVerificationMac(
      crypto.access,
      macRecord(write.verification.idempotencyResponse),
      {
        idempotencyKey: `organizer:${IDS.job}`,
        payload: response,
        payloadCodec: responseCodec,
        surface: "idempotency_response",
        transition
      }
    )
  ]);
  expect(verified).toEqual([true, true, true]);
  return Object.freeze({ noteContent, noteMutation, noteRevision, response });
}

describe("production organizer cipher", () => {
  let crypto: TestCrypto;

  beforeEach(() => {
    const custodian = testCustodian();
    crypto = testCrypto(custodian);
    keyManagementMocks.custodianForOrganizerAuthority.mockReset();
    keyManagementMocks.custodianForOrganizerAuthority.mockReturnValue(custodian);
  });

  it("opens an authenticated encrypted capture exactly and rejects ciphertext and MAC tampering", async () => {
    const rawContent = "  Exact capture canary.\nKeep both spaces.  ";
    const source = await captureProjection(crypto, rawContent);
    const cipher = createProductionOrganizerCipher();
    await expect(
      cipher.openCapture({ authority: AUTHORITY, job: job(source), signal: SIGNAL })
    ).resolves.toEqual({ controls: CONTROLS, rawContent });

    const sourceCipher = source.cipher as Readonly<{
      envelope: ContentEnvelopeV1;
      keyClass: string;
      keyId: string;
      keyPurpose: string;
      keyVersion: number;
    }>;
    const ciphertext = sourceCipher.envelope.payload.ciphertext;
    const replacement = ciphertext.endsWith("A") ? "B" : "A";
    const tamperedCipher: EncryptedProjection = Object.freeze({
      ...source,
      cipher: Object.freeze({
        ...sourceCipher,
        envelope: Object.freeze({
          ...sourceCipher.envelope,
          payload: Object.freeze({
            ...sourceCipher.envelope.payload,
            ciphertext: `${ciphertext.slice(0, -1)}${replacement}`
          })
        })
      })
    });
    await expect(
      cipher.openCapture({ authority: AUTHORITY, job: job(tamperedCipher), signal: SIGNAL })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);

    const contentMac = source.contentMac as Readonly<{ value: string }>;
    const macReplacement = contentMac.value.endsWith("a") ? "b" : "a";
    const tamperedMac: EncryptedProjection = Object.freeze({
      ...source,
      contentMac: Object.freeze({
        ...(source.contentMac as Readonly<Record<string, unknown>>),
        value: `${contentMac.value.slice(0, -1)}${macReplacement}`
      })
    });
    await expect(
      cipher.openCapture({ authority: AUTHORITY, job: job(tamperedMac), signal: SIGNAL })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    await expect(
      cipher.openCapture({
        authority: AUTHORITY,
        job: Object.freeze({ ...job(source), ownerId: OTHER_OWNER_ID }),
        signal: SIGNAL
      })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
  });

  it("opens an encrypted candidate with exact content and rejects tampering and owner substitution", async () => {
    const encrypted = await candidateFixture(crypto);
    const cipher = createProductionOrganizerCipher();
    await expect(
      cipher.openCandidate({
        authority: AUTHORITY,
        candidate: encrypted,
        ownerId: OWNER_ID,
        signal: SIGNAL
      })
    ).resolves.toEqual({
      bodyMarkdown: "Existing exact source.",
      candidateId: IDS.candidate,
      isOpen: true,
      noteId: IDS.candidateNote,
      noteType: "generic",
      revision: 2,
      structuredData: { schemaVersion: 1 },
      title: "Existing canary title"
    });

    const source = encrypted.source;
    const sourceCipher = source.cipher as Readonly<{
      envelope: ContentEnvelopeV1;
      keyClass: string;
      keyId: string;
      keyPurpose: string;
      keyVersion: number;
    }>;
    const ciphertext = sourceCipher.envelope.payload.ciphertext;
    const replacement = ciphertext.endsWith("A") ? "B" : "A";
    const tampered: EncryptedCandidate = Object.freeze({
      ...encrypted,
      source: Object.freeze({
        ...source,
        cipher: Object.freeze({
          ...sourceCipher,
          envelope: Object.freeze({
            ...sourceCipher.envelope,
            payload: Object.freeze({
              ...sourceCipher.envelope.payload,
              ciphertext: `${ciphertext.slice(0, -1)}${replacement}`
            })
          })
        })
      })
    });
    await expect(
      cipher.openCandidate({
        authority: AUTHORITY,
        candidate: tampered,
        ownerId: OWNER_ID,
        signal: SIGNAL
      })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    await expect(
      cipher.openCandidate({
        authority: AUTHORITY,
        candidate: encrypted,
        ownerId: OTHER_OWNER_ID,
        signal: SIGNAL
      })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
  });

  it("seals create with exact source preservation, grouped reservation IDs, and content-free projections", async () => {
    const rawContent = "  Cipher create canary.\nSecond exact line.  ";
    const inputJob = job();
    const plan = createPlan(rawContent);
    const command = await createProductionOrganizerCipher().sealCommand({
      activeReplanCount: 0,
      authority: AUTHORITY,
      candidates: [],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: null,
      job: inputJob,
      plan,
      preparation: preparation("create", null),
      ragGenerationId: null,
      reviewReason: null,
      routingDecision: AUTO_ROUTING_DECISION,
      signal: SIGNAL,
      stableIds: stableIds("create")
    });

    expect(command).toMatchObject({ outcome: "created", review: null, reviewReason: null });
    const write = routedWrite(command);
    expect(write.revision).toMatchObject({
      actor: "organization:organizer",
      source: "organization"
    });
    expect(write.revision.actor).toMatch(/^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
    expect([
      write.noteCipher.reservationId,
      write.revision.cipher.reservationId,
      write.mutation.cipher.reservationId,
      write.responseCipher.reservationId
    ]).toEqual(new Array(4).fill(RESERVATIONS.noteWrite));
    expect(sealedSurface<"organization_decision">(command.decision).cipher.reservationId).toBe(
      RESERVATIONS.decision
    );
    expect(sealedSurface<"capture_receipt">(command.receipt).cipher.reservationId).toBe(
      RESERVATIONS.receipt
    );
    expect(write.noteState).toEqual({
      archivedAt: null,
      bodyMarkdown: "",
      dailyDate: null,
      deletedAt: null,
      isOpen: true,
      links: [],
      pinnedAt: null,
      privacy: "ai_assisted",
      spaceId: IDS.space,
      structuredData: { schemaVersion: 1 },
      tagIds: [],
      title: `e-${IDS.createdNote.toLowerCase()}`,
      type: "generic"
    });
    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain(rawContent);
    expect(serialized).not.toContain("Cipher create canary");
    expect(serialized).not.toContain("Cipher canary title");

    const opened = await openRoutedPayloads(crypto, command, {
      mode: "create",
      noteId: IDS.createdNote
    });
    expect(opened.noteContent).toEqual({
      bodyMarkdown: rawContent,
      schemaVersion: 1,
      structuredData: { schemaVersion: 1 },
      title: "Cipher canary title"
    });
    expect(opened.noteRevision.snapshot.bodyMarkdown).toBe(rawContent);
    expect(opened.noteMutation).toMatchObject({
      action: "create",
      afterRevision: 1,
      beforeRevision: 0,
      beforeSnapshot: null
    });
    expect(opened.noteMutation.afterSnapshot.bodyMarkdown).toBe(rawContent);
    expect(opened.response).toEqual({
      jobId: IDS.job,
      mutationId: IDS.mutation,
      noteId: IDS.createdNote,
      revision: 1,
      schemaVersion: 1
    });

    const decision = sealedSurface<"organization_decision">(command.decision);
    await expect(
      crypto.aggregate.openOrganizationDecision(
        crypto.access,
        rpcRecord(decision.cipher, {
          kind: "organization_decision",
          recordVersion: 1,
          resourceId: IDS.decision
        }),
        { decisionId: IDS.decision }
      )
    ).resolves.toMatchObject({
      band: "auto",
      validatedPlan: { operations: [{ content: rawContent, type: "append_raw" }] }
    });
    const receipt = sealedSurface<"capture_receipt">(command.receipt);
    await expect(
      crypto.aggregate.openCaptureReceipt(
        crypto.access,
        rpcRecord(receipt.cipher, {
          kind: "capture_receipt",
          recordVersion: 1,
          resourceId: IDS.capture
        }),
        { captureId: IDS.capture, recordVersion: 1, sourcePrivacy: "ai_assisted" }
      )
    ).resolves.toMatchObject({
      destination: { noteId: IDS.createdNote, title: "Cipher canary title" },
      outcome: "created_note"
    });
  });

  it("keeps rollback-compatible plaintext projections for a legacy command", async () => {
    const rawContent = "  Transitional compatibility source.  ";
    const command = await createProductionOrganizerCipher().sealCommand({
      activeReplanCount: 0,
      authority: AUTHORITY,
      candidates: [],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: null,
      job: job(encryptedProjectionPlaceholder(), "legacy"),
      plan: createPlan(rawContent),
      preparation: preparation("create", null),
      ragGenerationId: null,
      reviewReason: null,
      routingDecision: AUTO_ROUTING_DECISION,
      signal: SIGNAL,
      stableIds: stableIds("create")
    });

    expect(routedWrite(command).noteState).toMatchObject({
      bodyMarkdown: rawContent,
      structuredData: { schemaVersion: 1 },
      title: "Cipher canary title"
    });
  });

  it("uses the content-free sentinel once storage is encrypted-only", async () => {
    const rawContent = "Encrypted-only source must not enter legacy columns.";
    const command = await createProductionOrganizerCipher().sealCommand({
      activeReplanCount: 0,
      authority: AUTHORITY,
      candidates: [],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: null,
      job: job(encryptedProjectionPlaceholder(), "encrypted_only"),
      plan: createPlan(rawContent),
      preparation: preparation("create", null),
      ragGenerationId: null,
      reviewReason: null,
      routingDecision: AUTO_ROUTING_DECISION,
      signal: SIGNAL,
      stableIds: stableIds("create")
    });

    const noteState = routedWrite(command).noteState;
    expect(noteState).toMatchObject({
      bodyMarkdown: "",
      structuredData: { schemaVersion: 1 },
      title: `e-${IDS.createdNote.toLowerCase()}`
    });
    expect(JSON.stringify(noteState)).not.toContain(rawContent);
  });

  it("decrypts, binds, and appends to the selected encrypted candidate", async () => {
    const rawContent = "Append cipher canary exactly.  ";
    const encrypted = await candidateFixture(crypto);
    const cipher = createProductionOrganizerCipher();
    const decrypted = await cipher.openCandidate({
      authority: AUTHORITY,
      candidate: encrypted,
      ownerId: OWNER_ID,
      signal: SIGNAL
    });
    const command = await cipher.sealCommand({
      activeReplanCount: 0,
      authority: AUTHORITY,
      candidates: [Object.freeze({ decrypted, encrypted })],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: Object.freeze({ decrypted, encrypted }),
      job: job(),
      plan: appendPlan(rawContent, decrypted),
      preparation: preparation("append", 2),
      ragGenerationId: "rag-generation-v1",
      reviewReason: null,
      routingDecision: AUTO_ROUTING_DECISION,
      signal: SIGNAL,
      stableIds: stableIds("append")
    });

    expect(command).toMatchObject({ outcome: "appended", review: null, reviewReason: null });
    const write = routedWrite(command);
    expect([
      write.noteCipher.reservationId,
      write.revision.cipher.reservationId,
      write.mutation.cipher.reservationId,
      write.responseCipher.reservationId
    ]).toEqual(new Array(4).fill(RESERVATIONS.noteWrite));
    expect(write.noteState.dailyDate).toBe("2026-08-31");
    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain(rawContent);
    expect(serialized).not.toContain("Existing exact source");
    expect(serialized).not.toContain("Existing canary title");

    const opened = await openRoutedPayloads(crypto, command, {
      mode: "append",
      noteId: IDS.candidateNote
    });
    const expectedBody = `Existing exact source.\n\n${rawContent}`;
    expect(opened.noteContent.bodyMarkdown).toBe(expectedBody);
    expect(opened.noteMutation).toMatchObject({
      action: "update",
      afterRevision: 3,
      beforeRevision: 2,
      beforeSnapshot: { bodyMarkdown: "Existing exact source." },
      afterSnapshot: { bodyMarkdown: expectedBody }
    });
    expect(opened.noteRevision.snapshot.bodyMarkdown).toBe(expectedBody);
    expect(opened.response).toMatchObject({ noteId: IDS.candidateNote, revision: 3 });
    const decision = sealedSurface<"organization_decision">(command.decision);
    await expect(
      crypto.aggregate.openOrganizationDecision(
        crypto.access,
        rpcRecord(decision.cipher, {
          kind: "organization_decision",
          recordVersion: 1,
          resourceId: IDS.decision
        }),
        { decisionId: IDS.decision }
      )
    ).resolves.toMatchObject({
      candidateManifest: {
        generationId: "rag-generation-v1",
        candidates: [
          {
            noteId: IDS.candidateNote,
            revision: 2,
            title: "Existing canary title"
          }
        ]
      },
      signals: {
        policyMargin: 1,
        policyReasons: ["automatic_threshold_met"],
        policyScore: 1
      }
    });
  });

  it("seals a routed expansion as a separate encrypted block and bound Review proposal", async () => {
    const rawContent = "Append the original capture without generated prose.";
    const expansionText = "Consider grouping this with the weekly plan.";
    const encrypted = await candidateFixture(crypto);
    const cipher = createProductionOrganizerCipher();
    const decrypted = await cipher.openCandidate({
      authority: AUTHORITY,
      candidate: encrypted,
      ownerId: OWNER_ID,
      signal: SIGNAL
    });
    const plan = appendPlan(rawContent, decrypted, {
      kind: "suggestion",
      text: expansionText
    });
    const command = await cipher.sealCommand({
      activeReplanCount: 0,
      authority: AUTHORITY,
      candidates: [Object.freeze({ decrypted, encrypted })],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: Object.freeze({ decrypted, encrypted }),
      job: job(),
      plan,
      preparation: preparation("append", 2),
      ragGenerationId: "rag-generation-v1",
      reviewReason: "expansion_pending",
      routingDecision: AUTO_ROUTING_DECISION,
      signal: SIGNAL,
      stableIds: stableIds("append", true)
    });

    expect(command).toMatchObject({
      outcome: "appended",
      reviewReason: "expansion_pending",
      generatedBlock: {
        kind: "suggestion",
        modelId: "gpt-5.4-mini-2026-03-17",
        promptVersion: "routing-v1"
      },
      review: { type: "pending_expansion" }
    });
    const block = sealedSurface<"generated_block">(command.generatedBlock);
    const review = sealedSurface<"review_item">(command.review);
    const receipt = sealedSurface<"capture_receipt">(command.receipt);
    expect(block.cipher.reservationId).toBe(RESERVATIONS.generatedBlock);
    expect(review.cipher.reservationId).toBe(RESERVATIONS.review);
    expect(JSON.stringify(command)).not.toContain(expansionText);

    const openedBlock = await crypto.aggregate.openGeneratedBlock(
      crypto.access,
      rpcRecord(block.cipher, {
        kind: "generated_block",
        recordVersion: 1,
        resourceId: IDS.block
      }),
      { blockId: IDS.block }
    );
    expect(openedBlock).toEqual({ content: expansionText, schemaVersion: 1 });
    await expect(
      crypto.aggregate.verifyAggregateVerificationMac(
        crypto.access,
        macRecord(block.verificationMac),
        { blockId: IDS.block, payload: openedBlock, surface: "generated_block" }
      )
    ).resolves.toBe(true);
    await expect(
      crypto.aggregate.openReview(
        crypto.access,
        rpcRecord(review.cipher, {
          kind: "review_item",
          recordVersion: 1,
          resourceId: IDS.review
        }),
        { recordVersion: 1, reviewId: IDS.review, sourcePrivacy: "ai_assisted" }
      )
    ).resolves.toMatchObject({
      proposal: { blockId: IDS.block, type: "generated_block" },
      resolution: null,
      state: "open"
    });
    const openedReceipt = await crypto.aggregate.openCaptureReceipt(
      crypto.access,
      rpcRecord(receipt.cipher, {
        kind: "capture_receipt",
        recordVersion: 1,
        resourceId: IDS.capture
      }),
      { captureId: IDS.capture, recordVersion: 1, sourcePrivacy: "ai_assisted" }
    );
    expect(openedReceipt.reviewItemId).toBe(IDS.review);
    expect(openedReceipt.insertedContentReferences).toContainEqual({
      blockId: IDS.block,
      type: "ai_generated"
    });
    const decision = sealedSurface<"organization_decision">(command.decision);
    await expect(
      crypto.aggregate.openOrganizationDecision(
        crypto.access,
        rpcRecord(decision.cipher, {
          kind: "organization_decision",
          recordVersion: 1,
          resourceId: IDS.decision
        }),
        { decisionId: IDS.decision }
      )
    ).resolves.toMatchObject({
      signals: { generatedBlockId: IDS.block },
      validatedPlan: { generatedExpansion: null }
    });
  });

  it("seals review without a note write and keeps review content encrypted", async () => {
    const rawContent = "Review cipher canary remains encrypted.";
    const command = await createProductionOrganizerCipher().sealCommand({
      activeReplanCount: 0,
      authority: AUTHORITY,
      candidates: [],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: null,
      job: job(),
      plan: reviewPlan(rawContent),
      preparation: preparation("create", null),
      ragGenerationId: null,
      reviewReason: "planner_ambiguity",
      routingDecision: null,
      signal: SIGNAL,
      stableIds: stableIds("review")
    });

    expect(command).toMatchObject({
      noteWrite: null,
      outcome: "review",
      reviewReason: "planner_ambiguity"
    });
    const decision = sealedSurface<"organization_decision">(command.decision);
    const review = sealedSurface<"review_item">(command.review);
    const receipt = sealedSurface<"capture_receipt">(command.receipt);
    expect(decision.cipher.reservationId).toBe(RESERVATIONS.decision);
    expect(review.cipher.reservationId).toBe(RESERVATIONS.review);
    expect(receipt.cipher.reservationId).toBe(RESERVATIONS.receipt);
    expect(command.review).toMatchObject({ type: "low_confidence" });
    expect(JSON.stringify(command)).not.toContain(rawContent);

    await expect(
      crypto.aggregate.openOrganizationDecision(
        crypto.access,
        rpcRecord(decision.cipher, {
          kind: "organization_decision",
          recordVersion: 1,
          resourceId: IDS.decision
        }),
        { decisionId: IDS.decision }
      )
    ).resolves.toMatchObject({
      band: "review",
      validatedPlan: { operations: [{ content: rawContent, type: "append_raw" }] }
    });
    await expect(
      crypto.aggregate.openReview(
        crypto.access,
        rpcRecord(review.cipher, {
          kind: "review_item",
          recordVersion: 1,
          resourceId: IDS.review
        }),
        { recordVersion: 1, reviewId: IDS.review, sourcePrivacy: "ai_assisted" }
      )
    ).resolves.toEqual({
      proposal: { type: "route_capture", plan: reviewPlan(rawContent).validatedPlan },
      resolution: null,
      schemaVersion: 2,
      state: "open"
    });
    await expect(
      crypto.aggregate.openCaptureReceipt(
        crypto.access,
        rpcRecord(receipt.cipher, {
          kind: "capture_receipt",
          recordVersion: 1,
          resourceId: IDS.capture
        }),
        { captureId: IDS.capture, recordVersion: 1, sourcePrivacy: "ai_assisted" }
      )
    ).resolves.toMatchObject({ outcome: "needs_review", reviewItemId: IDS.review });
  });

  it("seals duplicate suspicion as a non-destructive encrypted two-note proposal", async () => {
    const rawContent = "Potential duplicate capture stays unchanged.";
    const firstEncrypted = await candidateFixture(crypto);
    const secondEncrypted = await candidateFixture(crypto, {
      candidateId: IDS.candidateTwo,
      noteId: IDS.candidateNoteTwo,
      revision: 4
    });
    const cipher = createProductionOrganizerCipher();
    const first = await cipher.openCandidate({
      authority: AUTHORITY,
      candidate: firstEncrypted,
      ownerId: OWNER_ID,
      signal: SIGNAL
    });
    const second = await cipher.openCandidate({
      authority: AUTHORITY,
      candidate: secondEncrypted,
      ownerId: OWNER_ID,
      signal: SIGNAL
    });
    const plan = materializeAuthorizedOrganizationPlan({
      captureText: rawContent,
      manifest: manifest(first, second),
      plan: {
        alternatives: [first.candidateId, second.candidateId],
        captureKind: "freeform",
        decision: "needs_review",
        destination: { candidateId: null, newNote: null },
        generatedExpansion: null,
        operations: [{ content: rawContent, type: "append_raw" }],
        reasonCodes: ["ambiguous_intent", "duplicate_suspected"],
        schemaVersion: 1
      },
      stableIds: stableIds("review")
    });
    const command = await cipher.sealCommand({
      activeReplanCount: 0,
      authority: AUTHORITY,
      candidates: [
        Object.freeze({ decrypted: first, encrypted: firstEncrypted }),
        Object.freeze({ decrypted: second, encrypted: secondEncrypted })
      ],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: null,
      job: job(),
      plan,
      preparation: preparation("create", null),
      ragGenerationId: null,
      reviewReason: "duplicate_suggestion",
      routingDecision: null,
      signal: SIGNAL,
      stableIds: stableIds("review")
    });

    expect(command).toMatchObject({
      generatedBlock: null,
      noteWrite: null,
      outcome: "review",
      review: { type: "duplicate_suggestion" },
      reviewReason: "duplicate_suggestion"
    });
    expect(JSON.stringify(command)).not.toContain("Keep both leaves every note unchanged");
    const review = sealedSurface<"review_item">(command.review);
    const openedReview = await crypto.aggregate.openReview(
      crypto.access,
      rpcRecord(review.cipher, {
        kind: "review_item",
        recordVersion: 1,
        resourceId: IDS.review
      }),
      { recordVersion: 1, reviewId: IDS.review, sourcePrivacy: "ai_assisted" }
    );
    expect(openedReview).toMatchObject({
      proposal: {
        explanation:
          "This capture may overlap with these notes. Keep both leaves every note unchanged.",
        notes: [
          { noteId: IDS.candidateNote, revision: 2 },
          { noteId: IDS.candidateNoteTwo, revision: 4 }
        ],
        type: "duplicate_notes"
      },
      resolution: null,
      state: "open"
    });
  });

  it.each([
    ["revision_conflict", "revision_conflict", { type: "conflict", reason: "revision" }],
    [
      "explicit_destination_unavailable",
      "structure_conflict",
      { type: "conflict", reason: "candidate_eligibility" }
    ],
    ["expansion_pending", "pending_expansion", { type: "conflict", reason: "consent_controls" }]
  ] as const)(
    "writes typed v2 Review payloads for %s",
    async (reviewReason, reviewType, proposal) => {
      const rawContent = `Typed review payload for ${reviewReason}.`;
      const command = await createProductionOrganizerCipher().sealCommand({
        activeReplanCount: 0,
        authority: AUTHORITY,
        candidates: [],
        capture: capture(rawContent),
        controls: CONTROLS,
        destination: null,
        job: job(),
        plan: reviewPlan(rawContent),
        preparation: preparation("create", null),
        ragGenerationId: null,
        reviewReason,
        routingDecision: null,
        signal: SIGNAL,
        stableIds: stableIds("review")
      });
      expect(command.review).toMatchObject({ type: reviewType });
      const sealed = sealedSurface<"review_item">(command.review);
      await expect(
        crypto.aggregate.openReview(
          crypto.access,
          rpcRecord(sealed.cipher, {
            kind: "review_item",
            recordVersion: 1,
            resourceId: IDS.review
          }),
          { recordVersion: 1, reviewId: IDS.review, sourcePrivacy: "ai_assisted" }
        )
      ).resolves.toEqual({ proposal, resolution: null, schemaVersion: 2, state: "open" });
    }
  );

  it("rejects stale or cross-bound preparation, stable-ID, control, and generation inputs before custody", async () => {
    const rawContent = "Preparation binding canary.";
    const base = Object.freeze({
      activeReplanCount: 0 as const,
      authority: AUTHORITY,
      candidates: [],
      capture: capture(rawContent),
      controls: CONTROLS,
      destination: null,
      job: job(),
      plan: createPlan(rawContent),
      preparation: preparation("create", null),
      ragGenerationId: null,
      reviewReason: null,
      routingDecision: AUTO_ROUTING_DECISION,
      signal: SIGNAL,
      stableIds: stableIds("create")
    }) satisfies SealCommandInput;
    const invalidInputs: readonly SealCommandInput[] = [
      Object.freeze({
        ...base,
        preparation: Object.freeze({
          ...base.preparation,
          jobId: "job_01ARZ3NDEKTSV4RRFFQ69G5FAA"
        })
      }),
      Object.freeze({ ...base, activeReplanCount: 1 }),
      Object.freeze({ ...base, ragGenerationId: "invalid generation id" }),
      Object.freeze({ ...base, routingDecision: null }),
      Object.freeze({
        ...base,
        preparation: Object.freeze({ ...base.preparation, mode: "append" as const })
      }),
      Object.freeze({
        ...base,
        preparation: Object.freeze({ ...base.preparation, expectedRevision: 1 })
      }),
      Object.freeze({
        ...base,
        stableIds: Object.freeze({
          ...base.stableIds,
          decisionId: "dec_01ARZ3NDEKTSV4RRFFQ69G5FAA" as const
        })
      }),
      Object.freeze({
        ...base,
        controls: Object.freeze({ ...CONTROLS, expansionDisabled: true })
      }),
      Object.freeze({
        ...base,
        controls: Object.freeze({
          ...CONTROLS,
          ruleMatch: Object.freeze({
            destinationId: IDS.candidateNote,
            destinationKind: "note" as const,
            matched: true as const,
            priority: 500,
            ruleId: "rule_01ARZ3NDEKTSV4RRFFQ69G5FAE" as const,
            ruleRevision: 2
          })
        })
      })
    ];

    const cipher = createProductionOrganizerCipher();
    for (const invalid of invalidInputs) {
      await expect(cipher.sealCommand(invalid)).rejects.toBeInstanceOf(OrganizerUnavailableError);
    }
    expect(keyManagementMocks.custodianForOrganizerAuthority).not.toHaveBeenCalled();
  });

  it("fails closed for aborts, stale destination bindings, and malformed reservation groups", async () => {
    const encrypted = await candidateFixture(crypto);
    const cipher = createProductionOrganizerCipher();
    const decrypted = await cipher.openCandidate({
      authority: AUTHORITY,
      candidate: encrypted,
      ownerId: OWNER_ID,
      signal: SIGNAL
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      cipher.openCandidate({
        authority: AUTHORITY,
        candidate: encrypted,
        ownerId: OWNER_ID,
        signal: aborted.signal
      })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);

    const rawContent = "Fail-closed canary.";
    await expect(
      cipher.sealCommand({
        activeReplanCount: 0,
        authority: AUTHORITY,
        candidates: [Object.freeze({ decrypted, encrypted })],
        capture: capture(rawContent),
        controls: CONTROLS,
        destination: Object.freeze({
          decrypted: Object.freeze({ ...decrypted, revision: 1 }),
          encrypted
        }),
        job: job(),
        plan: appendPlan(rawContent, decrypted),
        preparation: preparation("append", 2),
        ragGenerationId: null,
        reviewReason: null,
        routingDecision: AUTO_ROUTING_DECISION,
        signal: SIGNAL,
        stableIds: stableIds("append")
      })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);

    const evidence = Object.freeze({ decrypted, encrypted });
    await expect(
      cipher.sealCommand({
        activeReplanCount: 0,
        authority: AUTHORITY,
        candidates: [evidence, evidence],
        capture: capture(rawContent),
        controls: CONTROLS,
        destination: evidence,
        job: job(),
        plan: appendPlan(rawContent, decrypted),
        preparation: preparation("append", 2),
        ragGenerationId: null,
        reviewReason: null,
        routingDecision: AUTO_ROUTING_DECISION,
        signal: SIGNAL,
        stableIds: stableIds("append")
      })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);

    const malformed = {
      ...preparation("create", null),
      reservations: {
        ...preparation("create", null).reservations,
        noteWrite: {
          operationCount: 3,
          reservationId: RESERVATIONS.noteWrite
        }
      }
    } as unknown as OrganizerPreparation;
    await expect(
      cipher.sealCommand({
        activeReplanCount: 0,
        authority: AUTHORITY,
        candidates: [],
        capture: capture(rawContent),
        controls: CONTROLS,
        destination: null,
        job: job(),
        plan: createPlan(rawContent),
        preparation: malformed,
        ragGenerationId: null,
        reviewReason: null,
        routingDecision: AUTO_ROUTING_DECISION,
        signal: SIGNAL,
        stableIds: stableIds("create")
      })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
  });
});
