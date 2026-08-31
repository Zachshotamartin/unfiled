import {
  ContentCryptoError,
  ContentCryptoErrorCode,
  generateKeyEncryptionKey,
  type KeyEncryptionKey
} from "@unfiled/content-crypto";
import { describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/server/api/errors";

import {
  createCaptureContentProtector,
  loadEnvironmentContentProtectionKeys
} from "./content-protection";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const CAPTURE_ID = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const OTHER_CAPTURE_ID = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y";

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

async function protector(key?: KeyEncryptionKey) {
  const activeKey = key ?? (await generateKeyEncryptionKey("capture-kek-v1"));
  const fingerprintKey = await hmacKey();
  return createCaptureContentProtector(() =>
    Promise.resolve({
      activeKey,
      fingerprintKey,
      resolveKey: (keyId: string) => Promise.resolve(keyId === activeKey.keyId ? activeKey : null)
    })
  );
}

describe("capture content protection", () => {
  it("seals content into a context-bound envelope and verifies the keyed fingerprint", async () => {
    const contentProtector = await protector();
    const plaintext = "Roosevelt method: commit first, learn next";
    const protectedContent = await contentProtector.protectCapture(plaintext, USER_ID, CAPTURE_ID);
    const stored = {
      envelope: protectedContent.contentEnvelope,
      fingerprint: protectedContent.contentFingerprint,
      length: protectedContent.contentLength
    };

    expect(JSON.stringify(stored)).not.toContain("Roosevelt");
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.length).toBe(plaintext.length);
    await expect(contentProtector.openCapture(stored, USER_ID, CAPTURE_ID)).resolves.toBe(
      plaintext
    );
  });

  it("rejects cross-user, cross-capture, fingerprint, length, and wrapper tampering", async () => {
    const contentProtector = await protector();
    const protectedContent = await contentProtector.protectCapture(
      "private capture",
      USER_ID,
      CAPTURE_ID
    );
    const stored = {
      envelope: protectedContent.contentEnvelope,
      fingerprint: protectedContent.contentFingerprint,
      length: protectedContent.contentLength
    };

    await expect(contentProtector.openCapture(stored, OTHER_USER_ID, CAPTURE_ID)).rejects.toThrow(
      ContentCryptoError
    );
    await expect(contentProtector.openCapture(stored, USER_ID, OTHER_CAPTURE_ID)).rejects.toThrow(
      ContentCryptoError
    );
    await expect(
      contentProtector.openCapture({ ...stored, fingerprint: "0".repeat(64) }, USER_ID, CAPTURE_ID)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContentCryptoError &&
        error.code === ContentCryptoErrorCode.AUTHENTICATION_FAILED
    );
    await expect(
      contentProtector.openCapture({ ...stored, length: stored.length + 1 }, USER_ID, CAPTURE_ID)
    ).rejects.toThrow(ContentCryptoError);
    await expect(
      contentProtector.openCapture({ ...stored, extra: true }, USER_ID, CAPTURE_ID)
    ).rejects.toThrow(ContentCryptoError);
  });

  it("never falls back when the envelope key identifier is unavailable", async () => {
    const writer = await protector();
    const protectedContent = await writer.protectCapture("rotation", USER_ID, CAPTURE_ID);
    const otherKey = await generateKeyEncryptionKey("capture-kek-v2");
    const reader = await protector(otherKey);

    await expect(
      reader.openCapture(
        {
          envelope: protectedContent.contentEnvelope,
          fingerprint: protectedContent.contentFingerprint,
          length: protectedContent.contentLength
        },
        USER_ID,
        CAPTURE_ID
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContentCryptoError && error.code === ContentCryptoErrorCode.KEY_NOT_FOUND
    );
  });

  it("retries a transient key-provider failure without caching an unsafe fallback", async () => {
    const activeKey = await generateKeyEncryptionKey("capture-kek-v1");
    const fingerprintKey = await hmacKey();
    const keys = {
      activeKey,
      fingerprintKey,
      resolveKey: (keyId: string) => Promise.resolve(keyId === activeKey.keyId ? activeKey : null)
    };
    const load = vi
      .fn<() => Promise<typeof keys>>()
      .mockRejectedValueOnce(new Error("temporary KMS outage"))
      .mockResolvedValue(keys);
    const contentProtector = createCaptureContentProtector(load);

    await expect(contentProtector.ready()).rejects.toThrow("temporary KMS outage");
    await expect(contentProtector.ready()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds the lifetime of cached unwrapped keys and reloads after expiry", async () => {
    const activeKey = await generateKeyEncryptionKey("capture-kek-v1");
    const fingerprintKey = await hmacKey();
    const keys = {
      activeKey,
      fingerprintKey,
      resolveKey: (keyId: string) => Promise.resolve(keyId === activeKey.keyId ? activeKey : null)
    };
    let now = 1_000;
    const load = vi.fn(() => Promise.resolve(keys));
    const contentProtector = createCaptureContentProtector(load, {
      cacheTtlMs: 50,
      now: () => now
    });

    await contentProtector.ready();
    now += 49;
    await contentProtector.ready();
    expect(load).toHaveBeenCalledOnce();
    now += 1;
    await contentProtector.ready();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("strictly imports active, fingerprint, and retired environment keys", async () => {
    const active = Buffer.alloc(32, 1).toString("base64url");
    const retired = Buffer.alloc(32, 2).toString("base64url");
    const fingerprint = Buffer.alloc(32, 3).toString("base64url");
    const keys = await loadEnvironmentContentProtectionKeys({
      UNFILED_CONTENT_KEK_ID: "capture-kek-v2",
      UNFILED_CONTENT_KEK: active,
      UNFILED_CONTENT_FINGERPRINT_KEY: fingerprint,
      UNFILED_CONTENT_RETIRED_KEKS: JSON.stringify({ "capture-kek-v1": retired })
    });

    await expect(keys.resolveKey("capture-kek-v2")).resolves.toBe(keys.activeKey);
    await expect(keys.resolveKey("capture-kek-v1")).resolves.not.toBeNull();
    await expect(keys.resolveKey("unknown")).resolves.toBeNull();
    expect(keys.fingerprintKey.extractable).toBe(false);
  });

  it("fails closed for absent, malformed, noncanonical, or colliding key configuration", async () => {
    for (const environment of [
      {},
      {
        UNFILED_CONTENT_KEK_ID: "bad key id",
        UNFILED_CONTENT_KEK: Buffer.alloc(32).toString("base64url"),
        UNFILED_CONTENT_FINGERPRINT_KEY: Buffer.alloc(32).toString("base64url")
      },
      {
        UNFILED_CONTENT_KEK_ID: "key-v1",
        UNFILED_CONTENT_KEK: "not-base64url",
        UNFILED_CONTENT_FINGERPRINT_KEY: Buffer.alloc(32).toString("base64url")
      },
      {
        UNFILED_CONTENT_KEK_ID: "key-v1",
        UNFILED_CONTENT_KEK: Buffer.alloc(32).toString("base64url"),
        UNFILED_CONTENT_FINGERPRINT_KEY: Buffer.alloc(32).toString("base64url"),
        UNFILED_CONTENT_RETIRED_KEKS: JSON.stringify({
          "key-v1": Buffer.alloc(32).toString("base64url")
        })
      }
    ]) {
      await expect(loadEnvironmentContentProtectionKeys(environment)).rejects.toBeInstanceOf(
        ConfigurationError
      );
    }
  });
});
