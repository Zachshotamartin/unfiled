import {
  ContentCryptoError,
  ContentCryptoErrorCode,
  importKeyEncryptionKey,
  openUtf8WithResolver,
  sealUtf8,
  type ContentEnvelopeV1,
  type ContentKeyResolver,
  type EncryptionContext,
  type KeyEncryptionKey
} from "@unfiled/content-crypto";
import { timingSafeEqual } from "node:crypto";

import { ConfigurationError } from "@/server/api/errors";

const KEY_BYTES = 32;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_DOMAIN = "unfiled:capture-fingerprint:v1";
const DEFAULT_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

export type ProtectedCaptureContent = Readonly<{
  contentEnvelope: ContentEnvelopeV1;
  contentFingerprint: string;
  contentLength: number;
}>;

export type CaptureContentProtector = Readonly<{
  openCapture(protectedContent: unknown, userId: string, captureId: string): Promise<string>;
  protectCapture(
    content: string,
    userId: string,
    captureId: string
  ): Promise<ProtectedCaptureContent>;
  ready(): Promise<void>;
}>;

export type CaptureContentProtectionKeys = Readonly<{
  activeKey: KeyEncryptionKey;
  fingerprintKey: CryptoKey;
  resolveKey: ContentKeyResolver;
}>;

function captureContext(userId: string, captureId: string): EncryptionContext {
  return {
    tenantId: userId,
    resourceId: captureId,
    recordVersion: 1,
    kind: "capture"
  };
}

function fingerprintMessage(userId: string, captureId: string, content: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([FINGERPRINT_DOMAIN, userId, captureId, content]));
}

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function protectedContentFields(value: unknown): Readonly<{
  envelope: unknown;
  fingerprint: string;
  length: number;
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentCryptoError(
      ContentCryptoErrorCode.INVALID_ENVELOPE,
      "Protected content is invalid"
    );
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    !("envelope" in row) ||
    typeof row.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.fingerprint) ||
    typeof row.length !== "number" ||
    !Number.isInteger(row.length) ||
    row.length < 1 ||
    row.length > 10_000
  ) {
    throw new ContentCryptoError(
      ContentCryptoErrorCode.INVALID_ENVELOPE,
      "Protected content is invalid"
    );
  }
  return { envelope: row.envelope, fingerprint: row.fingerprint, length: row.length };
}

async function calculateFingerprint(
  key: CryptoKey,
  content: string,
  userId: string,
  captureId: string
): Promise<string> {
  const message = fingerprintMessage(userId, captureId, content);
  try {
    return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, copiedBuffer(message))));
  } finally {
    message.fill(0);
  }
}

export function createCaptureContentProtector(
  loadKeys: () => Promise<CaptureContentProtectionKeys>,
  options: Readonly<{
    cacheTtlMs?: number;
    now?: () => number;
  }> = {}
): CaptureContentProtector {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_KEY_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: Readonly<{ expiresAt: number; keys: CaptureContentProtectionKeys }> | undefined;
  let loading: Promise<CaptureContentProtectionKeys> | undefined;
  const keys = (): Promise<CaptureContentProtectionKeys> => {
    const instant = now();
    if (cached !== undefined && instant < cached.expiresAt) return Promise.resolve(cached.keys);
    loading ??= loadKeys()
      .then((loaded) => {
        cached = { expiresAt: now() + cacheTtlMs, keys: loaded };
        loading = undefined;
        return loaded;
      })
      .catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
    return loading;
  };

  return Object.freeze({
    async openCapture(
      protectedContent: unknown,
      userId: string,
      captureId: string
    ): Promise<string> {
      const loaded = await keys();
      const fields = protectedContentFields(protectedContent);
      const plaintext = await openUtf8WithResolver(
        fields.envelope,
        captureContext(userId, captureId),
        loaded.resolveKey
      );
      const fingerprint = await calculateFingerprint(
        loaded.fingerprintKey,
        plaintext,
        userId,
        captureId
      );
      const expected = Buffer.from(fields.fingerprint, "hex");
      const actual = Buffer.from(fingerprint, "hex");
      if (
        plaintext.length !== fields.length ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        throw new ContentCryptoError(
          ContentCryptoErrorCode.AUTHENTICATION_FAILED,
          "Encrypted content could not be authenticated"
        );
      }
      return plaintext;
    },

    async protectCapture(
      content: string,
      userId: string,
      captureId: string
    ): Promise<ProtectedCaptureContent> {
      const loaded = await keys();
      const [contentEnvelope, contentFingerprint] = await Promise.all([
        sealUtf8(content, captureContext(userId, captureId), loaded.activeKey),
        calculateFingerprint(loaded.fingerprintKey, content, userId, captureId)
      ]);
      return { contentEnvelope, contentFingerprint, contentLength: content.length };
    },

    async ready(): Promise<void> {
      await keys();
    }
  });
}

function decodeSecret(value: string | undefined): Uint8Array {
  if (value === undefined || !BASE64URL_KEY_PATTERN.test(value)) throw new ConfigurationError();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== KEY_BYTES || bytes.toString("base64url") !== value) {
    bytes.fill(0);
    throw new ConfigurationError();
  }
  return bytes;
}

function parseRetiredKeys(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || value.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("invalid key ring");
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (
      entries.length > 20 ||
      entries.some(([keyId, secret]) => !KEY_ID_PATTERN.test(keyId) || typeof secret !== "string")
    ) {
      throw new TypeError("invalid key ring");
    }
    return Object.fromEntries(entries) as Readonly<Record<string, string>>;
  } catch {
    throw new ConfigurationError();
  }
}

export async function loadEnvironmentContentProtectionKeys(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<CaptureContentProtectionKeys> {
  const activeKeyId = environment.UNFILED_CONTENT_KEK_ID;
  if (activeKeyId === undefined || !KEY_ID_PATTERN.test(activeKeyId)) {
    throw new ConfigurationError();
  }

  const retiredValues = parseRetiredKeys(environment.UNFILED_CONTENT_RETIRED_KEKS);
  const activeBytes = decodeSecret(environment.UNFILED_CONTENT_KEK);
  let fingerprintBytes: Uint8Array;
  try {
    fingerprintBytes = decodeSecret(environment.UNFILED_CONTENT_FINGERPRINT_KEY);
  } catch (error: unknown) {
    activeBytes.fill(0);
    throw error;
  }
  if (Object.hasOwn(retiredValues, activeKeyId)) {
    activeBytes.fill(0);
    fingerprintBytes.fill(0);
    throw new ConfigurationError();
  }

  const imported = new Map<string, KeyEncryptionKey>();
  try {
    const activeKey = await importKeyEncryptionKey(activeKeyId, activeBytes);
    imported.set(activeKeyId, activeKey);
    for (const [keyId, encoded] of Object.entries(retiredValues)) {
      const retiredBytes = decodeSecret(encoded);
      try {
        imported.set(keyId, await importKeyEncryptionKey(keyId, retiredBytes));
      } finally {
        retiredBytes.fill(0);
      }
    }
    const fingerprintKey = await crypto.subtle.importKey(
      "raw",
      copiedBuffer(fingerprintBytes),
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"]
    );
    return Object.freeze({
      activeKey,
      fingerprintKey,
      resolveKey: (keyId: string) => Promise.resolve(imported.get(keyId) ?? null)
    });
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof ContentCryptoError) {
      const cryptoError: ContentCryptoError = error;
      if (
        cryptoError.code === ContentCryptoErrorCode.INVALID_KEY ||
        cryptoError.code === ContentCryptoErrorCode.INVALID_ENVELOPE ||
        cryptoError.code === ContentCryptoErrorCode.UNSUPPORTED_RUNTIME
      ) {
        throw new ConfigurationError();
      }
    }
    throw new ConfigurationError();
  } finally {
    activeBytes.fill(0);
    fingerprintBytes.fill(0);
  }
}

export const environmentCaptureContentProtector = createCaptureContentProtector(() =>
  loadEnvironmentContentProtectionKeys()
);
