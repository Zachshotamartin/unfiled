import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  encryptedIdempotencyForRpc,
  jsonPayloadCodec,
  type ContentMacKeyReference,
  type LogicalApiRequest
} from "../src/index.js";
import {
  AI_TRANSITION,
  IDS,
  OWNER_A,
  OWNER_B,
  PRIVATE_TRANSITION,
  createHarness
} from "./harness.js";

const requestCodec = z.strictObject({ title: z.string().min(1), body: z.string() });
const responseCodec = z.strictObject({
  noteId: z.string(),
  revision: z.number().int().positive(),
  generatedAt: z.string()
});

const logicalRequest = Object.freeze({
  schemaVersion: 1 as const,
  scope: "notes.create.v1",
  targetResourceId: null,
  expectedRevision: 0,
  payload: { title: "Groceries", body: "milk" }
});

const responseOne = Object.freeze({
  noteId: IDS.note,
  revision: 1,
  generatedAt: "2026-08-30T20:00:00.000Z"
});

const responseTwo = Object.freeze({
  noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  revision: 1,
  generatedAt: "2026-08-30T20:01:00.000Z"
});

describe("idempotency request MAC and encrypted response", () => {
  it("prepares a request MAC without a response or object-wrap reservation", async () => {
    const harness = await createHarness();
    const requestMac = await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "create-note-1",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec
    });

    expect(requestMac).toMatchObject({
      keyClass: "ai_assisted",
      keyPurpose: "content_mac",
      keyVersion: 2
    });
    expect(requestMac.value).toMatch(/^[0-9a-f]{64}$/u);
    expect(harness.reserveObjectWrappingKey).not.toHaveBeenCalled();
  });

  it("seals a response separately and forwards the exact reservation to the RPC shape", async () => {
    const harness = await createHarness();
    const response = await harness.service.sealIdempotencyResponse(harness.accessA, {
      idempotencyKey: "create-note-1",
      transition: AI_TRANSITION,
      response: responseOne,
      responseCodec
    });
    expect(response).toMatchObject({
      resourceId: "idempotency:create-note-1",
      kind: "idempotency_response",
      keyClass: "ai_assisted",
      reservationId: "reservation_1"
    });
  });

  it("keeps request identity stable when generated response IDs and times change", async () => {
    const harness = await createHarness();
    const first = await harness.service.sealIdempotencyRecord(harness.accessA, {
      idempotencyKey: "same-logical-request",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      response: responseOne,
      responseCodec
    });
    const second = await harness.service.sealIdempotencyRecord(harness.accessA, {
      idempotencyKey: "same-logical-request",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      response: responseTwo,
      responseCodec
    });

    expect(first.requestMac.value).toBe(second.requestMac.value);
    expect(first.response.envelope.payload.ciphertext).not.toBe(
      second.response.envelope.payload.ciphertext
    );
    expect(JSON.stringify(first)).not.toContain(responseOne.noteId);
    const rpc = encryptedIdempotencyForRpc(first);
    expect(Object.keys(rpc.response).sort()).toEqual([
      "envelope",
      "keyClass",
      "keyId",
      "keyPurpose",
      "keyVersion",
      "reservationId"
    ]);
    expect(Object.keys(rpc.requestMac).sort()).toEqual([
      "keyClass",
      "keyId",
      "keyPurpose",
      "keyVersion",
      "mac"
    ]);
  });

  it("verifies and opens with destructured methods", async () => {
    const harness = await createHarness();
    const record = await harness.service.sealIdempotencyRecord(harness.accessA, {
      idempotencyKey: "destructured-call",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      response: responseOne,
      responseCodec
    });
    const { verifyIdempotencyRequest, openIdempotencyResponse } = harness.service;
    const verifyInput = {
      idempotencyKey: "destructured-call",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec
    };
    await expect(verifyIdempotencyRequest(harness.accessA, record, verifyInput)).resolves.toBe(
      true
    );
    await expect(
      openIdempotencyResponse(harness.accessA, record, { ...verifyInput, responseCodec })
    ).resolves.toEqual(responseOne);
  });

  it("opens a stored response for verification without verifying or authorizing a request", async () => {
    const harness = await createHarness();
    const record = await harness.service.sealIdempotencyRecord(harness.accessA, {
      idempotencyKey: "verification-only",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      response: responseOne,
      responseCodec
    });
    harness.resolveContentMacKey.mockClear();
    const { openIdempotencyResponseForVerification } = harness.service;

    await expect(
      openIdempotencyResponseForVerification(harness.accessA, record, {
        idempotencyKey: "verification-only",
        responseCodec
      })
    ).resolves.toEqual(responseOne);
    expect(harness.resolveContentMacKey).not.toHaveBeenCalled();
  });

  it("fails verification-only opening on owner, class, context, or ciphertext tampering", async () => {
    const harness = await createHarness();
    const record = await harness.service.sealIdempotencyRecord(harness.accessA, {
      idempotencyKey: "verification-tamper",
      transition: PRIVATE_TRANSITION,
      logicalRequest,
      requestCodec,
      response: responseOne,
      responseCodec
    });
    const open = (candidate: unknown, access = harness.accessA) =>
      harness.service.openIdempotencyResponseForVerification(access, candidate, {
        idempotencyKey: "verification-tamper",
        responseCodec
      });

    await expect(open(record, harness.accessB)).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      open({ ...record, requestMac: { ...record.requestMac, keyClass: "ai_assisted" } })
    ).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      open({ ...record, response: { ...record.response, keyClass: "ai_assisted" } })
    ).rejects.toMatchObject({ code: "invalid_record" });
    await expect(
      open({
        ...record,
        response: {
          ...record.response,
          envelope: {
            ...record.response.envelope,
            context: { ...record.response.envelope.context, recordVersion: 2 }
          }
        }
      })
    ).rejects.toMatchObject({ code: "invalid_record" });

    const ciphertext = record.response.envelope.payload.ciphertext;
    await expect(
      open({
        ...record,
        response: {
          ...record.response,
          envelope: {
            ...record.response.envelope,
            payload: {
              ...record.response.envelope.payload,
              ciphertext: `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`
            }
          }
        }
      })
    ).rejects.toMatchObject({ code: "decryption_failed" });
  });

  it("recomputes with an exact retired key reference after active-key rotation", async () => {
    const harness = await createHarness();
    const retired = harness.contentMacReference(OWNER_A, "ai_assisted", "retired");
    const original = await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "retired-key-replay",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      keyReference: retired
    });
    const recomputed = await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "retired-key-replay",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      keyReference: retired
    });
    const active = await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "retired-key-replay",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec
    });

    expect(original).toEqual(recomputed);
    expect(original.keyVersion).toBe(1);
    expect(active.keyVersion).toBe(2);
    expect(active.value).not.toBe(original.value);
    expect(harness.resolveContentMacKey).toHaveBeenCalledWith({
      ownerId: OWNER_A,
      keyClass: "ai_assisted",
      keyId: retired.keyId
    });
  });

  it("verifies a stored retired MAC without consulting the active key", async () => {
    const harness = await createHarness();
    const retired = harness.contentMacReference(OWNER_A, "private_manual", "retired");
    const requestMac = await harness.service.createIdempotencyRequestMac(harness.accessA, {
      idempotencyKey: "stored-retired",
      transition: PRIVATE_TRANSITION,
      logicalRequest,
      requestCodec,
      keyReference: retired
    });
    const response = await harness.service.sealIdempotencyResponse(harness.accessA, {
      idempotencyKey: "stored-retired",
      transition: PRIVATE_TRANSITION,
      response: responseOne,
      responseCodec
    });
    harness.activeContentMacKey.mockClear();
    const record = {
      ownerId: OWNER_A,
      idempotencyKey: "stored-retired",
      keyClass: "private_manual" as const,
      requestMac,
      response
    };
    await expect(
      harness.service.verifyIdempotencyRequest(harness.accessA, record, {
        idempotencyKey: "stored-retired",
        transition: PRIVATE_TRANSITION,
        logicalRequest,
        requestCodec
      })
    ).resolves.toBe(true);
    expect(harness.activeContentMacKey).not.toHaveBeenCalled();
  });

  it.each([
    ["scope", { ...logicalRequest, scope: "notes.update.v1" }],
    ["target", { ...logicalRequest, targetResourceId: IDS.note }],
    ["revision", { ...logicalRequest, expectedRevision: 1 }],
    ["payload", { ...logicalRequest, payload: { ...logicalRequest.payload, body: "oat milk" } }]
  ])("rejects a replay with a different logical %s", async (_label, changed) => {
    const harness = await createHarness();
    const record = await harness.service.sealIdempotencyRecord(harness.accessA, {
      idempotencyKey: "different-request",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      response: responseOne,
      responseCodec
    });
    const input = {
      idempotencyKey: "different-request",
      transition: AI_TRANSITION,
      logicalRequest: changed as LogicalApiRequest<{ title: string; body: string }>,
      requestCodec
    };
    await expect(
      harness.service.verifyIdempotencyRequest(harness.accessA, record, input)
    ).resolves.toBe(false);
    await expect(
      harness.service.openIdempotencyResponse(harness.accessA, record, {
        ...input,
        responseCodec
      })
    ).rejects.toMatchObject({ code: "replay_mismatch" });
  });

  it.each(["owner", "class", "version", "purpose", "missing"])(
    "rejects an unusable exact MAC key reference: %s",
    async (variant) => {
      const harness = await createHarness();
      const retired = harness.contentMacReference(OWNER_A, "ai_assisted", "retired");
      const reference = {
        ...retired,
        ...(variant === "owner" ? { ownerId: OWNER_B } : {}),
        ...(variant === "class" ? { keyClass: "private_manual" } : {}),
        ...(variant === "version" ? { keyVersion: 999 } : {}),
        ...(variant === "purpose" ? { purpose: "object_wrap" } : {}),
        ...(variant === "missing" ? { keyId: "key_missing_mac" } : {})
      } as ContentMacKeyReference;
      await expect(
        harness.service.createIdempotencyRequestMac(harness.accessA, {
          idempotencyKey: "bad-reference",
          transition: AI_TRANSITION,
          logicalRequest,
          requestCodec,
          keyReference: reference
        })
      ).rejects.toMatchObject({ code: "key_unavailable" });
    }
  );

  it("fails closed when the exact stored MAC key has been revoked", async () => {
    const harness = await createHarness();
    const retired = harness.contentMacReference(OWNER_A, "ai_assisted", "retired");
    const selector = `${OWNER_A}:ai_assisted:${retired.keyId}`;
    harness.macKeys.delete(selector);
    await expect(
      harness.service.createIdempotencyRequestMac(harness.accessA, {
        idempotencyKey: "revoked-key",
        transition: AI_TRANSITION,
        logicalRequest,
        requestCodec,
        keyReference: retired
      })
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("rejects tampered MAC references and response ciphertext before returning plaintext", async () => {
    const harness = await createHarness();
    const record = await harness.service.sealIdempotencyRecord(harness.accessA, {
      idempotencyKey: "tamper-test",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      response: responseOne,
      responseCodec
    });
    const input = {
      idempotencyKey: "tamper-test",
      transition: AI_TRANSITION,
      logicalRequest,
      requestCodec,
      responseCodec
    };
    await expect(
      harness.service.openIdempotencyResponse(
        harness.accessA,
        {
          ...record,
          requestMac: { ...record.requestMac, keyVersion: record.requestMac.keyVersion + 1 }
        },
        input
      )
    ).rejects.toMatchObject({ code: "key_unavailable" });

    const ciphertext = record.response.envelope.payload.ciphertext;
    const replacement = ciphertext.endsWith("A") ? "B" : "A";
    await expect(
      harness.service.openIdempotencyResponse(
        harness.accessA,
        {
          ...record,
          response: {
            ...record.response,
            envelope: {
              ...record.response.envelope,
              payload: {
                ...record.response.envelope.payload,
                ciphertext: `${ciphertext.slice(0, -1)}${replacement}`
              }
            }
          }
        },
        input
      )
    ).rejects.toMatchObject({ code: "decryption_failed" });
  });

  it("enforces the exact 1-80 idempotency contract and strict logical-request shape", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.createIdempotencyRequestMac(harness.accessA, {
        idempotencyKey: "x".repeat(80),
        transition: AI_TRANSITION,
        logicalRequest,
        requestCodec
      })
    ).resolves.toMatchObject({ keyPurpose: "content_mac" });
    for (const idempotencyKey of ["", "x".repeat(81), "contains spaces"]) {
      await expect(
        harness.service.createIdempotencyRequestMac(harness.accessA, {
          idempotencyKey,
          transition: AI_TRANSITION,
          logicalRequest,
          requestCodec
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      harness.service.createIdempotencyRequestMac(harness.accessA, {
        idempotencyKey: "bad-scope",
        transition: AI_TRANSITION,
        logicalRequest: { ...logicalRequest, scope: "Bad Scope" },
        requestCodec
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.service.createIdempotencyRequestMac(harness.accessA, {
        idempotencyKey: "extra-execution-data",
        transition: AI_TRANSITION,
        logicalRequest: {
          ...logicalRequest,
          generatedAt: "2026-08-30T20:00:00.000Z"
        } as typeof logicalRequest,
        requestCodec
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("supports explicitly JSON-typed response codecs", async () => {
    const harness = await createHarness();
    const codec = jsonPayloadCodec<{ ok: boolean; values: number[] }>();
    const response = await harness.service.sealIdempotencyResponse(harness.accessA, {
      idempotencyKey: "json-codec",
      transition: AI_TRANSITION,
      response: { ok: true, values: [1, 2, 3] },
      responseCodec: codec
    });
    expect(response.envelope.context.kind).toBe("idempotency_response");
  });
});
