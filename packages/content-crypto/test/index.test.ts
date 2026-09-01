import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ContentCryptoError,
  ContentCryptoErrorCode,
  contentCryptoLimits,
  encryptedContentKinds,
  generateKeyEncryptionKey,
  importKeyEncryptionKey,
  openBytes,
  openUtf8,
  openUtf8WithResolver,
  parseContentEnvelope,
  rewrapEnvelope,
  sealBytes,
  sealUtf8,
  serializeContentEnvelope,
  type ContentEnvelopeV1,
  type EncryptionContext
} from "../src/index";

const context: EncryptionContext = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  resourceId: "note_01J7WXYZ1234567890ABCDEFGH",
  recordVersion: 1,
  kind: "note"
};

async function key(keyId = "content-kek-2026-08"): ReturnType<typeof generateKeyEncryptionKey> {
  return generateKeyEncryptionKey(keyId);
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ContentCryptoError && error.code === code;
}

function mutateBase64(value: string): string {
  const first = value.at(0);
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}

function byteView(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

describe("content envelope encryption", () => {
  it("covers every content kind required by the encrypted-library SQL contract", async () => {
    const migration = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../../supabase/migrations/20260830000015_encrypted_library_expansion.sql"
      ),
      "utf8"
    );
    const sqlKinds = new Set(
      [
        ...migration.matchAll(
          /private\.valid_(?:encrypted_field|content_envelope)\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*'([a-z_]+)'/gu
        )
      ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    );
    const expectedSqlKinds = [
      "capture",
      "capture_receipt",
      "generated_block",
      "idempotency_response",
      "note_content",
      "note_mutation",
      "note_rag_index",
      "note_revision",
      "organization_decision",
      "organization_mutation_attempt",
      "review_item",
      "routing_rule",
      "space_display",
      "tag_display"
    ];

    expect([...sqlKinds].sort()).toEqual(expectedSqlKinds);
    expect(encryptedContentKinds).toEqual(expect.arrayContaining(expectedSqlKinds));
  });

  it.each(encryptedContentKinds)("round-trips the canonical %s envelope kind", async (kind) => {
    const encryptionKey = await key();
    const kindContext: EncryptionContext = { ...context, kind };
    const plaintext = `canonical-kind:${kind}`;
    const envelope = await sealUtf8(plaintext, kindContext, encryptionKey);

    expect(envelope.context.kind).toBe(kind);
    await expect(openUtf8(envelope, kindContext, encryptionKey)).resolves.toBe(plaintext);
  });

  it("round-trips UTF-8 content without exposing plaintext in the envelope", async () => {
    const encryptionKey = await key();
    const plaintext = "Roosevelt method: commit first, learn next. 🗂️";
    const envelope = await sealUtf8(plaintext, context, encryptionKey);

    expect(JSON.stringify(envelope)).not.toContain("Roosevelt");
    await expect(openUtf8(envelope, context, encryptionKey)).resolves.toBe(plaintext);
  });

  it("uses a fresh data key and nonce for every seal", async () => {
    const encryptionKey = await key();
    const first = await sealUtf8("same content", context, encryptionKey);
    const second = await sealUtf8("same content", context, encryptionKey);

    expect(first.payload).not.toEqual(second.payload);
    expect(first.wrappedDataKey).not.toEqual(second.wrappedDataKey);
  });

  it("round-trips arbitrary bytes", async () => {
    const encryptionKey = await key();
    const plaintext = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const envelope = await sealBytes(plaintext, { ...context, kind: "outbox" }, encryptionKey);

    await expect(
      openBytes(envelope, { ...context, kind: "outbox" }, encryptionKey)
    ).resolves.toEqual(plaintext);
  });

  it("authenticates ciphertext, wrapped keys, and external context", async () => {
    const encryptionKey = await key();
    const envelope = await sealUtf8("sensitive", context, encryptionKey);
    const tamperedPayload = {
      ...envelope,
      payload: { ...envelope.payload, ciphertext: mutateBase64(envelope.payload.ciphertext) }
    };
    const tamperedDataKey = {
      ...envelope,
      wrappedDataKey: {
        ...envelope.wrappedDataKey,
        ciphertext: mutateBase64(envelope.wrappedDataKey.ciphertext)
      }
    };

    await expect(openUtf8(tamperedPayload, context, encryptionKey)).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.AUTHENTICATION_FAILED)
    );
    await expect(openUtf8(tamperedDataKey, context, encryptionKey)).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.AUTHENTICATION_FAILED)
    );
    await expect(
      openUtf8(envelope, { ...context, resourceId: "note_different" }, encryptionKey)
    ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.AUTHENTICATION_FAILED));
    await expect(
      openUtf8(
        envelope,
        { ...context, tenantId: "22222222-2222-4222-8222-222222222222" },
        encryptionKey
      )
    ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.AUTHENTICATION_FAILED));
    await expect(
      openUtf8(envelope, { ...context, kind: "capture" }, encryptionKey)
    ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.AUTHENTICATION_FAILED));
    await expect(
      openUtf8(envelope, { ...context, recordVersion: 2 }, encryptionKey)
    ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.AUTHENTICATION_FAILED));
  });

  it("rewraps only the data key during key rotation", async () => {
    const oldKey = await key("content-kek-2026-08");
    const newKey = await key("content-kek-2026-09");
    const original = await sealUtf8("survives rotation", context, oldKey);
    const rotated = await rewrapEnvelope(original, context, oldKey, newKey);

    expect(rotated.keyId).toBe(newKey.keyId);
    expect(rotated.payload).toEqual(original.payload);
    expect(rotated.wrappedDataKey).not.toEqual(original.wrappedDataKey);
    await expect(openUtf8(rotated, context, newKey)).resolves.toBe("survives rotation");
    await expect(openUtf8(rotated, context, oldKey)).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.KEY_NOT_FOUND)
    );
  });

  it("resolves keys by authenticated key identifier and never falls back", async () => {
    const encryptionKey = await key();
    const envelope = await sealUtf8("resolved", context, encryptionKey);
    const resolve = vi.fn((keyId: string) =>
      Promise.resolve(keyId === encryptionKey.keyId ? encryptionKey : null)
    );

    await expect(openUtf8WithResolver(envelope, context, resolve)).resolves.toBe("resolved");
    expect(resolve).toHaveBeenCalledWith(encryptionKey.keyId);
    await expect(
      openUtf8WithResolver(envelope, context, () => Promise.resolve(null))
    ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.KEY_NOT_FOUND));
  });

  it("serializes a canonical validated envelope", async () => {
    const encryptionKey = await key();
    const envelope = await sealUtf8("serialize me", context, encryptionKey);
    const serialized = serializeContentEnvelope(envelope);

    expect(parseContentEnvelope(serialized)).toEqual(envelope);
    expect(() => parseContentEnvelope("not json")).toThrow(ContentCryptoError);
    expect(() => serializeContentEnvelope({ ...envelope, extra: true })).toThrow(
      ContentCryptoError
    );
  });

  it("rejects malformed, noncanonical, oversized, and unsupported envelopes", async () => {
    const encryptionKey = await key();
    const envelope = await sealUtf8("valid", context, encryptionKey);
    const malformedCases: unknown[] = [
      null,
      [],
      { ...envelope, version: 2 },
      { ...envelope, suite: "AES-CBC" },
      { ...envelope, keyId: "../../secret" },
      { ...envelope, context: { ...context, kind: "unknown" } },
      { ...envelope, context: { ...context, recordVersion: -1 } },
      { ...envelope, context: { ...context, recordVersion: 1.5 } },
      { ...envelope, context: { ...context, recordVersion: "1" } },
      { ...envelope, payload: { ...envelope.payload, nonce: "A" } },
      { ...envelope, wrappedDataKey: { nonce: 1, ciphertext: 2 } },
      {
        ...envelope,
        payload: { ...envelope.payload, ciphertext: `${envelope.payload.ciphertext}A` }
      }
    ];

    for (const malformed of malformedCases) {
      await expect(openUtf8(malformed, context, encryptionKey)).rejects.toSatisfy(
        expectCode(ContentCryptoErrorCode.INVALID_ENVELOPE)
      );
    }

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const plaintext of [new Uint8Array(), new Uint8Array([0x42])]) {
      const tailEnvelope = await sealBytes(plaintext, context, encryptionKey);
      const ciphertext = tailEnvelope.payload.ciphertext;
      const remainder = ciphertext.length % 4;
      expect(remainder === 2 || remainder === 3).toBe(true);
      const last = alphabet.indexOf(ciphertext.at(-1) ?? "");
      const noncanonicalLast = alphabet[(last & (remainder === 2 ? 0x30 : 0x3c)) | 1];
      if (noncanonicalLast === undefined) throw new Error("expected a base64url tail digit");
      await expect(
        openBytes(
          {
            ...tailEnvelope,
            payload: {
              ...tailEnvelope.payload,
              ciphertext: `${ciphertext.slice(0, -1)}${noncanonicalLast}`
            }
          },
          context,
          encryptionKey
        )
      ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.INVALID_ENVELOPE));
    }

    expect(() =>
      parseContentEnvelope("x".repeat(contentCryptoLimits.maximumSerializedEnvelopeBytes + 1))
    ).toThrow(ContentCryptoError);
    await expect(
      sealBytes(
        new Uint8Array(contentCryptoLimits.maximumPlaintextBytes + 1),
        context,
        encryptionKey
      )
    ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.PLAINTEXT_TOO_LARGE));
    await expect(
      sealUtf8("invalid context", { ...context, recordVersion: -1 }, encryptionKey)
    ).rejects.toSatisfy(expectCode(ContentCryptoErrorCode.INVALID_ENVELOPE));
  });

  it("rejects invalid keys and unavailable runtime support", async () => {
    await expect(importKeyEncryptionKey("valid-key", new Uint8Array(31))).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.INVALID_KEY)
    );
    await expect(generateKeyEncryptionKey("invalid key id")).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.INVALID_ENVELOPE)
    );

    const encryptionKey = await key();
    const envelope = await sealUtf8("valid", context, encryptionKey);
    const invalidKey = {
      keyId: encryptionKey.keyId,
      key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, [
        "encrypt",
        "decrypt"
      ])
    };
    await expect(openUtf8(envelope, context, invalidKey)).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.INVALID_KEY)
    );

    const extractableKey = {
      keyId: encryptionKey.keyId,
      key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt"
      ])
    };
    await expect(openUtf8(envelope, context, extractableKey)).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.INVALID_KEY)
    );

    const unsupported = {} as Crypto;
    await expect(generateKeyEncryptionKey("valid-key", unsupported)).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.UNSUPPORTED_RUNTIME)
    );
  });

  it("keeps the raw-key import copy alive only until Web Crypto resolves", async () => {
    const source = new Uint8Array(32).fill(41);
    const importedKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt"
    ]);
    let importedBytes: Uint8Array = new Uint8Array();
    let resolveImport: ((key: CryptoKey) => void) | undefined;
    const importKey = vi.fn((_format: KeyFormat, keyData: BufferSource) => {
      importedBytes = byteView(keyData);
      return new Promise<CryptoKey>((resolve) => {
        resolveImport = resolve;
      });
    });
    const pending = importKeyEncryptionKey("zeroized-key", source, {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: { importKey }
    } as unknown as Crypto);

    expect(importedBytes).toEqual(new Uint8Array(32).fill(41));
    expect(importedBytes).not.toBe(source);
    source.fill(42);
    expect(importedBytes).toEqual(new Uint8Array(32).fill(41));
    if (resolveImport === undefined) throw new Error("Expected Web Crypto import to start");
    resolveImport(importedKey);

    await expect(pending).resolves.toMatchObject({ keyId: "zeroized-key" });
    expect(importedBytes).toEqual(new Uint8Array(32));
    expect(source).toEqual(new Uint8Array(32).fill(42));
  });

  it("zeroes the raw-key import copy when Web Crypto rejects", async () => {
    const source = new Uint8Array(32).fill(43);
    let importedBytes: Uint8Array = new Uint8Array();
    let rejectImport: ((reason: Error) => void) | undefined;
    const importKey = vi.fn((_format: KeyFormat, keyData: BufferSource) => {
      importedBytes = byteView(keyData);
      return new Promise<CryptoKey>((_resolve, reject) => {
        rejectImport = reject;
      });
    });
    const pending = importKeyEncryptionKey("rejected-key", source, {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: { importKey }
    } as unknown as Crypto);

    expect(importedBytes).toEqual(new Uint8Array(32).fill(43));
    if (rejectImport === undefined) throw new Error("Expected Web Crypto import to start");
    rejectImport(new Error("synthetic import failure"));

    await expect(pending).rejects.toThrow("synthetic import failure");
    expect(importedBytes).toEqual(new Uint8Array(32));
    expect(source).toEqual(new Uint8Array(32).fill(43));
  });

  it("rejects invalid UTF-8 after successful authentication", async () => {
    const encryptionKey = await key();
    const envelope = await sealBytes(new Uint8Array([0xc3, 0x28]), context, encryptionKey);
    await expect(openUtf8(envelope, context, encryptionKey)).rejects.toSatisfy(
      expectCode(ContentCryptoErrorCode.AUTHENTICATION_FAILED)
    );
  });

  it("never leaks plaintext through errors", async () => {
    const encryptionKey = await key();
    const canary = "CANARY_PRIVATE_NOTE_97cb5";
    const envelope = await sealUtf8(canary, context, encryptionKey);
    const broken = {
      ...envelope,
      payload: { ...envelope.payload, ciphertext: mutateBase64(envelope.payload.ciphertext) }
    } as ContentEnvelopeV1;

    try {
      await openUtf8(broken, context, encryptionKey);
      throw new Error("Expected decryption to fail");
    } catch (error: unknown) {
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });
});
