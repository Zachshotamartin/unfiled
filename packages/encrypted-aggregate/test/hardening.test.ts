import { sealBytes } from "@unfiled/content-crypto";
import type { ManagedContentMacKey, ManagedObjectWrappingKey } from "@unfiled/key-management";
import { describe, expect, it } from "vitest";

import {
  EncryptedAggregateError,
  createEncryptedAggregateService,
  type AuthorizedOwnerAccess,
  type LogicalApiRequest,
  type ObjectWrapKeyReference,
  type ObjectWrapReservation
} from "../src/index.js";
import { AI_TRANSITION, IDS, OTHER_IDS, OWNER_A, OWNER_B, createHarness } from "./harness.js";

const notePayload = Object.freeze({
  schemaVersion: 1 as const,
  title: "Private canary title",
  bodyMarkdown: "Private canary body",
  structuredData: { schemaVersion: 1 as const }
});

function activeObjectKey(
  harness: Awaited<ReturnType<typeof createHarness>>,
  ownerId = OWNER_A,
  keyClass: "ai_assisted" | "private_manual" = "ai_assisted"
): ManagedObjectWrappingKey & Readonly<{ reference: ObjectWrapKeyReference }> {
  const key = harness.activeObject.get(`${ownerId}:${keyClass}`);
  if (key === undefined) throw new Error("fixture object key missing");
  return key;
}

async function malformedNoteRecord(
  harness: Awaited<ReturnType<typeof createHarness>>,
  bytes: Uint8Array
) {
  const key = activeObjectKey(harness);
  const context = {
    tenantId: OWNER_A,
    resourceId: IDS.note,
    recordVersion: 1,
    kind: "note_content" as const
  };
  const envelope = await sealBytes(bytes, context, key.key);
  return {
    ownerId: OWNER_A,
    resourceId: IDS.note,
    recordVersion: 1,
    kind: "note_content" as const,
    envelope,
    keyId: key.reference.keyId,
    keyClass: "ai_assisted" as const,
    keyPurpose: "object_wrap" as const,
    keyVersion: key.reference.keyVersion
  };
}

describe("encrypted aggregate hardening", () => {
  it("accepts a stored projection without the write-only reservation capability", async () => {
    const harness = await createHarness();
    const sealed = await harness.service.sealNoteContent(harness.accessA, {
      noteId: IDS.note,
      currentRevision: 1,
      privacy: "ai_assisted",
      payload: notePayload
    });
    const { reservationId, ...stored } = sealed;
    expect(reservationId).toBe("reservation_1");
    await expect(
      harness.service.openNoteContent(harness.accessA, stored, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted"
      })
    ).resolves.toEqual(notePayload);
  });

  it("consumes one exact reservation capability and rejects reuse or duplicate IDs", async () => {
    const harness = await createHarness();
    const key = activeObjectKey(harness);
    const shared = Object.freeze({
      reservationId: "reservation_shared",
      reference: key.reference
    }) as ObjectWrapReservation;
    harness.setReservationOverride(() => Promise.resolve(shared));
    await harness.service.sealNoteContent(harness.accessA, {
      noteId: IDS.note,
      currentRevision: 1,
      privacy: "ai_assisted",
      payload: notePayload
    });
    await expect(
      harness.service.sealNoteContent(harness.accessA, {
        noteId: IDS.note,
        currentRevision: 2,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "reservation_invalid" });

    const secondHarness = await createHarness();
    const secondKey = activeObjectKey(secondHarness);
    secondHarness.setReservationOverride(() =>
      Promise.resolve({
        reservationId: "reservation_duplicate",
        reference: secondKey.reference
      })
    );
    await secondHarness.service.sealNoteContent(secondHarness.accessA, {
      noteId: IDS.note,
      currentRevision: 1,
      privacy: "ai_assisted",
      payload: notePayload
    });
    await expect(
      secondHarness.service.sealNoteContent(secondHarness.accessA, {
        noteId: IDS.note,
        currentRevision: 2,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "reservation_invalid" });
  });

  it.each(["provider", "shape", "identifier", "owner", "class", "purpose", "version", "missing"])(
    "fails closed for invalid reservation case %s",
    async (variant) => {
      const harness = await createHarness();
      const key = activeObjectKey(harness);
      harness.setReservationOverride(() => {
        if (variant === "provider") {
          return Promise.reject(new Error("reservation backend unavailable"));
        }
        if (variant === "shape") return Promise.resolve({ reservationId: "reservation_bad" });
        return Promise.resolve({
          reservationId: variant === "identifier" ? "bad reservation" : "reservation_bad",
          reference: {
            ...key.reference,
            ...(variant === "owner" ? { ownerId: OWNER_B } : {}),
            ...(variant === "class" ? { keyClass: "private_manual" } : {}),
            ...(variant === "purpose" ? { purpose: "content_mac" } : {}),
            ...(variant === "version" ? { keyVersion: 999 } : {}),
            ...(variant === "missing" ? { keyId: "key_missing_wrap" } : {})
          }
        });
      });
      await expect(
        harness.service.sealNoteContent(harness.accessA, {
          noteId: IDS.note,
          currentRevision: 1,
          privacy: "ai_assisted",
          payload: notePayload
        })
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof EncryptedAggregateError &&
          ["reservation_invalid", "key_unavailable"].includes(error.code)
      );
    }
  );

  it("fails closed when exact object-key lookup rejects, disappears, or returns a mismatched key", async () => {
    const rejectionHarness = await createHarness();
    rejectionHarness.resolveObjectWrappingKey.mockRejectedValueOnce(new Error("KMS unavailable"));
    await expect(
      rejectionHarness.service.sealNoteContent(rejectionHarness.accessA, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "key_unavailable" });

    const missingHarness = await createHarness();
    const key = activeObjectKey(missingHarness);
    missingHarness.objectKeys.delete(`${OWNER_A}:ai_assisted:${key.reference.keyId}`);
    await expect(
      missingHarness.service.sealNoteContent(missingHarness.accessA, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "key_unavailable" });

    const mismatchHarness = await createHarness();
    const mismatchKey = activeObjectKey(mismatchHarness);
    mismatchHarness.objectKeys.set(`${OWNER_A}:ai_assisted:${mismatchKey.reference.keyId}`, {
      ...mismatchKey,
      reference: { ...mismatchKey.reference, keyVersion: 99 }
    });
    await expect(
      mismatchHarness.service.sealNoteContent(mismatchHarness.accessA, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("rejects forged access and invalid public identifiers, versions, or privacy", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.sealNoteContent({} as AuthorizedOwnerAccess, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "authorization_failed" });
    await expect(
      harness.service.sealNoteContent(harness.accessA, {
        noteId: "note_bad",
        currentRevision: 1,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.service.sealNoteContent(harness.accessA, {
        noteId: IDS.note,
        currentRevision: 0,
        privacy: "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.service.sealNoteContent(harness.accessA, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "secret" as "ai_assisted",
        payload: notePayload
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects malformed or substituted encrypted records before decryption", async () => {
    const harness = await createHarness();
    const record = await harness.service.sealNoteContent(harness.accessA, {
      noteId: IDS.note,
      currentRevision: 1,
      privacy: "ai_assisted",
      payload: notePayload
    });
    const expected = { noteId: IDS.note, currentRevision: 1, privacy: "ai_assisted" as const };
    for (const malformed of [
      null,
      { ...record, extra: true },
      { ...record, keyPurpose: "content_mac" },
      { ...record, keyId: "bad key" },
      { ...record, keyVersion: 0 },
      { ...record, reservationId: "bad reservation" },
      { ...record, resourceId: OTHER_IDS.note },
      { ...record, envelope: { ...record.envelope, keyId: "key_other" } },
      {
        ...record,
        envelope: {
          ...record.envelope,
          context: { ...record.envelope.context, recordVersion: 2 }
        }
      }
    ]) {
      await expect(
        harness.service.openNoteContent(harness.accessA, malformed, expected)
      ).rejects.toMatchObject({ code: "invalid_record" });
    }
  });

  it("maps authentication tampering to a content-free decryption error", async () => {
    const harness = await createHarness();
    const record = await harness.service.sealNoteContent(harness.accessA, {
      noteId: IDS.note,
      currentRevision: 1,
      privacy: "ai_assisted",
      payload: notePayload
    });
    const ciphertext = record.envelope.payload.ciphertext;
    const tampered = {
      ...record,
      envelope: {
        ...record.envelope,
        payload: {
          ...record.envelope.payload,
          ciphertext: `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`
        }
      }
    };
    let caught: unknown;
    try {
      await harness.service.openNoteContent(harness.accessA, tampered, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted"
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "decryption_failed" });
    expect(String(caught)).not.toContain(notePayload.title);
    expect(String(caught)).not.toContain(notePayload.bodyMarkdown);
  });

  it("rejects authenticated JSON that is malformed UTF-8 or violates the payload schema", async () => {
    const harness = await createHarness();
    const invalidUtf8 = await malformedNoteRecord(harness, new Uint8Array([0xff]));
    await expect(
      harness.service.openNoteContent(harness.accessA, invalidUtf8, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted"
      })
    ).rejects.toMatchObject({ code: "payload_invalid" });

    const invalidSchema = await malformedNoteRecord(
      harness,
      new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, title: "missing fields" }))
    );
    await expect(
      harness.service.openNoteContent(harness.accessA, invalidSchema, {
        noteId: IDS.note,
        currentRevision: 1,
        privacy: "ai_assisted"
      })
    ).rejects.toMatchObject({ code: "payload_invalid" });
  });

  it("rejects content and semantic MAC substitution", async () => {
    const harness = await createHarness();
    const capture = await harness.service.sealCapture(harness.accessA, {
      captureId: IDS.capture,
      recordVersion: 1,
      privacy: "ai_assisted",
      payload: { schemaVersion: 1, rawContent: "secret capture" }
    });
    const flipped = capture.contentMac.value.startsWith("0") ? "1" : "0";
    await expect(
      harness.service.openCapture(
        harness.accessA,
        {
          ...capture,
          contentMac: {
            ...capture.contentMac,
            value: `${flipped}${capture.contentMac.value.slice(1)}`
          }
        },
        { captureId: IDS.capture, recordVersion: 1, privacy: "ai_assisted" }
      )
    ).rejects.toMatchObject({ code: "integrity_check_failed" });

    const space = await harness.service.sealSpaceDisplay(harness.accessA, {
      spaceId: IDS.space,
      currentRevision: 1,
      payload: { schemaVersion: 1, name: "Home", slug: "home" }
    });
    const tag = await harness.service.sealTagDisplay(harness.accessA, {
      tagId: IDS.tag,
      currentRevision: 1,
      payload: { schemaVersion: 1, name: "home" }
    });
    await expect(
      harness.service.openSpaceDisplay(
        harness.accessA,
        { ...space, contentMac: tag.contentMac },
        { spaceId: IDS.space, currentRevision: 1 }
      )
    ).rejects.toMatchObject({ code: "integrity_check_failed" });
  });

  it("enforces transition provenance inside revision, mutation, attempt, and receipt payloads", async () => {
    const harness = await createHarness();
    const snapshot = {
      spaceId: null,
      type: "generic" as const,
      title: "Private",
      bodyMarkdown: "body",
      structuredData: { schemaVersion: 1 as const },
      isOpen: true,
      pinnedAt: null,
      privacy: "private_manual" as const,
      archivedAt: null,
      deletedAt: null,
      tagIds: [],
      links: []
    };
    await expect(
      harness.service.sealNoteRevision(harness.accessA, {
        revisionId: IDS.revision,
        revision: 2,
        transition: AI_TRANSITION,
        payload: { schemaVersion: 1, snapshot }
      })
    ).rejects.toMatchObject({ code: "key_class_mismatch" });

    const mutation = {
      schemaVersion: 1 as const,
      action: "update" as const,
      beforeRevision: 1,
      afterRevision: 2,
      operations: [{ type: "set_privacy" as const, privacy: "private_manual" as const }],
      inverse: [{ type: "set_privacy" as const, privacy: "ai_assisted" as const }],
      beforeSnapshot: { ...snapshot, privacy: "ai_assisted" as const },
      afterSnapshot: snapshot
    };
    await expect(
      harness.service.sealNoteMutation(harness.accessA, {
        mutationId: IDS.mutation,
        afterRevision: 3,
        payload: mutation
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    const sealedMutation = await harness.service.sealNoteMutation(harness.accessA, {
      mutationId: IDS.mutation,
      afterRevision: 2,
      payload: mutation
    });
    await expect(
      harness.service.openNoteMutation(harness.accessA, sealedMutation, {
        mutationId: IDS.mutation,
        afterRevision: 2,
        transition: AI_TRANSITION
      })
    ).rejects.toMatchObject({ code: "invalid_record" });

    await expect(
      harness.service.sealOrganizationMutationAttempt(harness.accessA, {
        jobId: IDS.job,
        noteId: IDS.note,
        recordVersion: 1,
        payload: {
          schemaVersion: 1,
          operations: [
            {
              type: "restore_snapshot",
              spaceId: null,
              noteType: "generic",
              title: "Private",
              bodyMarkdown: "body",
              structuredData: { schemaVersion: 1 },
              privacy: "private_manual",
              isOpen: true,
              pinnedAt: null,
              archivedAt: null,
              deletedAt: null,
              tagIds: [],
              links: []
            }
          ]
        }
      })
    ).rejects.toMatchObject({ code: "key_class_mismatch" });
  });

  it("rejects a capture receipt whose encrypted identity disagrees with its resource", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.sealCaptureReceipt(harness.accessA, {
        captureId: OTHER_IDS.capture,
        recordVersion: 1,
        sourcePrivacy: "ai_assisted",
        payload: {
          schemaVersion: 1,
          captureId: IDS.capture,
          jobId: IDS.job,
          decisionId: null,
          reviewItemId: null,
          mutationId: null,
          outcome: "kept_in_inbox",
          headline: "Kept in Inbox",
          destination: null,
          insertedContentReferences: [],
          actions: [],
          reasonCodes: ["no_candidate_fit"],
          createdAt: "2026-08-30T20:00:00.000Z"
        }
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it.each([
    ["undefined", undefined],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["bigint", BigInt(1)],
    ["date", new Date("2026-08-30T20:00:00.000Z")]
  ])("rejects non-JSON canonical payload value %s", async (_label, payload) => {
    const harness = await createHarness();
    await expect(
      harness.service.createIdempotencyRequestMac(harness.accessA, {
        idempotencyKey: "invalid-canonical",
        transition: AI_TRANSITION,
        logicalRequest: {
          schemaVersion: 1,
          scope: "test.canonical.v1",
          targetResourceId: null,
          expectedRevision: null,
          payload
        },
        requestCodec: { parse: (value: unknown) => value }
      })
    ).rejects.toMatchObject({ code: "payload_invalid" });
  });

  it("rejects cycles, sparse arrays, accessors, symbols, forbidden keys, and excessive depth", async () => {
    const harness = await createHarness();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = "value";
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => "secret" });
    const symbolObject = { value: "ok", [Symbol("hidden")]: "secret" };
    const forbidden = JSON.parse('{"__proto__":"secret"}') as unknown;
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 70; index += 1) deep = { nested: deep };

    for (const payload of [cyclic, sparse, accessor, symbolObject, forbidden, deep]) {
      await expect(
        harness.service.createIdempotencyRequestMac(harness.accessA, {
          idempotencyKey: "invalid-graph",
          transition: AI_TRANSITION,
          logicalRequest: {
            schemaVersion: 1,
            scope: "test.canonical.v1",
            targetResourceId: null,
            expectedRevision: null,
            payload
          },
          requestCodec: { parse: (value: unknown) => value }
        })
      ).rejects.toMatchObject({ code: "payload_invalid" });
    }
  });

  it("canonicalizes key order and negative zero for stable request MACs", async () => {
    const harness = await createHarness();
    const codec = { parse: (value: unknown) => value as Record<string, unknown> };
    const request = (
      payload: Record<string, unknown>
    ): LogicalApiRequest<Record<string, unknown>> => ({
      schemaVersion: 1,
      scope: "test.canonical.v1",
      targetResourceId: null,
      expectedRevision: null,
      payload
    });
    const first = await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "canonical-order",
      transition: AI_TRANSITION,
      logicalRequest: request({ z: -0, a: true }),
      requestCodec: codec
    });
    const second = await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "canonical-order",
      transition: AI_TRANSITION,
      logicalRequest: request({ a: true, z: 0 }),
      requestCodec: codec
    });
    expect(first.value).toBe(second.value);
  });

  it("fails closed for unsupported crypto and invalid HMAC key material", async () => {
    const harness = await createHarness();
    const service = createEncryptedAggregateService({
      crypto: {} as Crypto,
      keyResolver: harness.resolver,
      objectWrapReservations: { reserveObjectWrappingKey: harness.reserveObjectWrappingKey }
    });
    await expect(
      service.createIdempotencyRequestMac(harness.accessA, {
        idempotencyKey: "no-crypto",
        transition: AI_TRANSITION,
        logicalRequest: {
          schemaVersion: 1,
          scope: "test.crypto.v1",
          targetResourceId: null,
          expectedRevision: null,
          payload: { ok: true }
        },
        requestCodec: { parse: (value: unknown) => value as { ok: boolean } }
      })
    ).rejects.toMatchObject({ code: "unsupported_runtime" });

    const invalidHarness = await createHarness();
    const invalidCryptoKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    const current = invalidHarness.activeMac.get(`${OWNER_A}:ai_assisted`);
    if (current === undefined) throw new Error("fixture MAC key missing");
    const invalidMacKey: ManagedContentMacKey = {
      reference: current.reference,
      key: invalidCryptoKey
    };
    invalidHarness.activeMac.set(`${OWNER_A}:ai_assisted`, invalidMacKey);
    await expect(
      invalidHarness.service.createIdempotencyRequestMac(invalidHarness.accessA, {
        idempotencyKey: "wrong-key-algorithm",
        transition: AI_TRANSITION,
        logicalRequest: {
          schemaVersion: 1,
          scope: "test.crypto.v1",
          targetResourceId: null,
          expectedRevision: null,
          payload: { ok: true }
        },
        requestCodec: { parse: (value: unknown) => value as { ok: boolean } }
      })
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("zeroizes HMAC message buffers and decrypted payload bytes", async () => {
    let signedMessage: ArrayBuffer | undefined;
    let lastDecrypted: ArrayBuffer | undefined;
    const subtle = new Proxy(crypto.subtle, {
      get(target, property) {
        if (property === "sign") {
          return async (...args: Parameters<SubtleCrypto["sign"]>) => {
            signedMessage = args[2] as ArrayBuffer;
            return target.sign(...args);
          };
        }
        if (property === "decrypt") {
          return async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
            const result = await target.decrypt(...args);
            lastDecrypted = result;
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown;
      }
    });
    const observingCrypto = new Proxy(crypto, {
      get(target, property) {
        if (property === "subtle") return subtle;
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown;
      }
    });
    const harness = await createHarness(observingCrypto);
    await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "zeroize-mac",
      transition: AI_TRANSITION,
      logicalRequest: {
        schemaVersion: 1,
        scope: "test.zeroize.v1",
        targetResourceId: null,
        expectedRevision: null,
        payload: { secret: "transient" }
      },
      requestCodec: { parse: (value: unknown) => value as { secret: string } }
    });
    expect(signedMessage).toBeDefined();
    if (signedMessage === undefined) throw new Error("sign observer did not capture a message");
    expect([...new Uint8Array(signedMessage)]).toSatisfy((bytes: number[]) =>
      bytes.every((byte) => byte === 0)
    );

    const record = await harness.service.sealNoteContent(harness.accessA, {
      noteId: IDS.note,
      currentRevision: 1,
      privacy: "ai_assisted",
      payload: notePayload
    });
    await harness.service.openNoteContent(harness.accessA, record, {
      noteId: IDS.note,
      currentRevision: 1,
      privacy: "ai_assisted"
    });
    expect(lastDecrypted).toBeDefined();
    if (lastDecrypted === undefined) throw new Error("decrypt observer did not capture plaintext");
    expect([...new Uint8Array(lastDecrypted)]).toSatisfy((bytes: number[]) =>
      bytes.every((byte) => byte === 0)
    );
  });
});
