import { describe, expect, it } from "vitest";

import { generateKeyEncryptionKey } from "@unfiled/content-crypto";

import { generation, buildingItem, testKey } from "./fixtures";
import { createStrictIndexDocumentOpener } from "../src/index-crypto";

describe("strict encrypted index opening", () => {
  it("authenticates the envelope and validates the canonical payload and finite vector", async () => {
    const key = await testKey();
    const item = await buildingItem(key);
    await expect(
      createStrictIndexDocumentOpener().validate(
        item.keyRecord.ownerId,
        generation,
        item,
        { keyFor: () => Promise.resolve(key) },
        new AbortController().signal
      )
    ).resolves.toBeUndefined();
  });

  it.each([
    ["model", { ...generation, embeddingModelId: "other-model" }],
    ["dimensions", { ...generation, embeddingDimensions: 4 }]
  ])("rejects %s mismatch", async (_label, changedGeneration) => {
    const key = await testKey();
    const item = await buildingItem(key);
    await expect(
      createStrictIndexDocumentOpener().validate(
        item.keyRecord.ownerId,
        changedGeneration,
        item,
        { keyFor: () => Promise.resolve(key) },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "generation_invalid" });
  });

  it("rejects ciphertext tamper and key-reference mismatch", async () => {
    const key = await testKey();
    const item = await buildingItem(key);
    const ciphertext = item.cipher.envelope.payload.ciphertext;
    const replacement = ciphertext.endsWith("A") ? "B" : "A";
    const tampered = {
      ...item,
      cipher: {
        ...item.cipher,
        envelope: {
          ...item.cipher.envelope,
          payload: {
            ...item.cipher.envelope.payload,
            ciphertext: `${ciphertext.slice(0, -1)}${replacement}`
          }
        }
      }
    };
    await expect(
      createStrictIndexDocumentOpener().validate(
        item.keyRecord.ownerId,
        generation,
        tampered,
        { keyFor: () => Promise.resolve(key) },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "generation_invalid" });

    const wrongKey = await generateKeyEncryptionKey("other-key");
    await expect(
      createStrictIndexDocumentOpener().validate(
        item.keyRecord.ownerId,
        generation,
        item,
        { keyFor: () => Promise.resolve(wrongKey) },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "generation_invalid" });
  });

  it("preserves redacted KMS unavailability and rejects pre-aborted work", async () => {
    const item = await buildingItem();
    await expect(
      createStrictIndexDocumentOpener().validate(
        item.keyRecord.ownerId,
        generation,
        item,
        { keyFor: () => Promise.reject(new Error("kms-secret-canary")) },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "generation_invalid" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      createStrictIndexDocumentOpener().validate(
        item.keyRecord.ownerId,
        generation,
        item,
        { keyFor: () => Promise.reject(new Error("unused")) },
        controller.signal
      )
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
