const ENVELOPE_VERSION = 1 as const;
const CIPHER_SUITE = "A256GCM" as const;
const AES_KEY_BITS = 256;
const DATA_KEY_BYTES = AES_KEY_BITS / 8;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BITS = 128;
const GCM_TAG_BYTES = GCM_TAG_BITS / 8;
const MAX_PLAINTEXT_BYTES = 1_048_576;
const MAX_SERIALIZED_ENVELOPE_BYTES = 1_500_000;
const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INVALID_BASE64URL_DIGIT = 0xff;
const BASE64URL_DECODE_TABLE = (() => {
  const table = new Uint8Array(128);
  table.fill(INVALID_BASE64URL_DIGIT);
  for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
    table[BASE64URL_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

export const encryptedContentKinds = Object.freeze([
  "capture",
  "note",
  "note_revision",
  "generated_block",
  "mutation_snapshot",
  "review_item",
  "organization_job",
  "draft",
  "outbox",
  "widget_handoff",
  "space_display",
  "tag_display",
  "note_content",
  "organization_decision",
  "note_mutation",
  "routing_rule",
  "organization_mutation_attempt",
  "idempotency_response",
  "capture_receipt",
  "note_rag_index"
] as const);

export type EncryptedContentKind = (typeof encryptedContentKinds)[number];

export type EncryptionContext = Readonly<{
  tenantId: string;
  resourceId: string;
  recordVersion: number;
  kind: EncryptedContentKind;
}>;

export type EncryptedPart = Readonly<{
  nonce: string;
  ciphertext: string;
}>;

export type ContentEnvelopeV1 = Readonly<{
  version: typeof ENVELOPE_VERSION;
  suite: typeof CIPHER_SUITE;
  keyId: string;
  context: EncryptionContext;
  wrappedDataKey: EncryptedPart;
  payload: EncryptedPart;
}>;

export type KeyEncryptionKey = Readonly<{
  keyId: string;
  key: CryptoKey;
}>;

export type ContentKeyResolver = (keyId: string) => Promise<KeyEncryptionKey | null>;

export const ContentCryptoErrorCode = Object.freeze({
  AUTHENTICATION_FAILED: "authentication_failed",
  INVALID_ENVELOPE: "invalid_envelope",
  INVALID_KEY: "invalid_key",
  KEY_NOT_FOUND: "key_not_found",
  PLAINTEXT_TOO_LARGE: "plaintext_too_large",
  UNSUPPORTED_RUNTIME: "unsupported_runtime"
} as const);

export type ContentCryptoErrorCodeValue =
  (typeof ContentCryptoErrorCode)[keyof typeof ContentCryptoErrorCode];

export class ContentCryptoError extends Error {
  readonly code: ContentCryptoErrorCodeValue;

  constructor(code: ContentCryptoErrorCodeValue, message: string) {
    super(message);
    this.name = "ContentCryptoError";
    this.code = code;
  }
}

function fail(code: ContentCryptoErrorCodeValue, message: string): never {
  throw new ContentCryptoError(code, message);
}

function runtimeCrypto(provided?: Crypto): Crypto {
  const implementation =
    (provided as Partial<Crypto> | undefined) ??
    (globalThis as unknown as { crypto?: Partial<Crypto> }).crypto;
  if (
    implementation === undefined ||
    typeof implementation.getRandomValues !== "function" ||
    implementation.subtle === undefined
  ) {
    fail(ContentCryptoErrorCode.UNSUPPORTED_RUNTIME, "A Web Crypto implementation is required");
  }
  return implementation as Crypto;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isContentKind(value: unknown): value is EncryptedContentKind {
  return typeof value === "string" && (encryptedContentKinds as readonly string[]).includes(value);
}

function isRecordVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertIdentifier(value: string, label: string): void {
  if (!isIdentifier(value)) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, `${label} is invalid`);
  }
}

function assertContext(context: EncryptionContext): void {
  assertIdentifier(context.tenantId, "Tenant identifier");
  assertIdentifier(context.resourceId, "Resource identifier");
  if (!isRecordVersion(context.recordVersion)) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Record version is invalid");
  }
  if (!isContentKind(context.kind)) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Content kind is invalid");
  }
}

function sameContext(left: EncryptionContext, right: EncryptionContext): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.resourceId === right.resourceId &&
    left.recordVersion === right.recordVersion &&
    left.kind === right.kind
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64URL_ALPHABET.charAt((block >>> 18) & 63);
    encoded += BASE64URL_ALPHABET.charAt((block >>> 12) & 63);
    if (second !== undefined) encoded += BASE64URL_ALPHABET.charAt((block >>> 6) & 63);
    if (third !== undefined) encoded += BASE64URL_ALPHABET.charAt(block & 63);
  }
  return encoded;
}

function base64UrlDigit(value: string, index: number): number {
  const code = value.charCodeAt(index);
  return code < BASE64URL_DECODE_TABLE.length
    ? (BASE64URL_DECODE_TABLE[code] ?? INVALID_BASE64URL_DIGIT)
    : INVALID_BASE64URL_DIGIT;
}

function base64UrlByteLength(
  value: string,
  maximumBytes: number,
  validateCharacters: boolean
): number {
  if (
    value.length === 0 ||
    value.length > Math.ceil((maximumBytes * 4) / 3) ||
    value.length % 4 === 1
  ) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Envelope encoding is invalid");
  }

  const remainder = value.length % 4;
  const finalSextet = base64UrlDigit(value, value.length - 1);
  if (
    finalSextet === INVALID_BASE64URL_DIGIT ||
    (remainder === 2 && (finalSextet & 0x0f) !== 0) ||
    (remainder === 3 && (finalSextet & 0x03) !== 0)
  ) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Envelope encoding is not canonical");
  }
  const outputLength = Math.floor((value.length * 6) / 8);
  if (outputLength > maximumBytes) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Envelope encoding is invalid");
  }
  if (validateCharacters) {
    for (let index = 0; index < value.length; index += 1) {
      if (base64UrlDigit(value, index) === INVALID_BASE64URL_DIGIT) {
        fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Envelope encoding is invalid");
      }
    }
  }
  return outputLength;
}

function decodeBase64Url(value: string, maximumBytes: number): Uint8Array {
  const outputLength = base64UrlByteLength(value, maximumBytes, false);
  const output = new Uint8Array(outputLength);
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;

  for (let inputIndex = 0; inputIndex < value.length; inputIndex += 1) {
    const digit = base64UrlDigit(value, inputIndex);
    if (digit === INVALID_BASE64URL_DIGIT) {
      output.fill(0);
      fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Envelope encoding is invalid");
    }
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (accumulator >>> bits) & 0xff;
      outputIndex += 1;
    }
  }

  if (outputIndex !== output.length) {
    output.fill(0);
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Envelope encoding is not canonical");
  }
  return output;
}

function parseEncryptedPart(
  value: unknown,
  expectedCiphertextBytes?: number,
  validateEncoding = true
): EncryptedPart {
  if (!isRecord(value) || !hasExactKeys(value, ["nonce", "ciphertext"])) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Encrypted part is invalid");
  }
  if (typeof value.nonce !== "string" || typeof value.ciphertext !== "string") {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Encrypted part is invalid");
  }
  const maximumCiphertextBytes = expectedCiphertextBytes ?? MAX_PLAINTEXT_BYTES + GCM_TAG_BYTES;
  const nonceLength = base64UrlByteLength(value.nonce, GCM_NONCE_BYTES, validateEncoding);
  const ciphertextLength = base64UrlByteLength(
    value.ciphertext,
    maximumCiphertextBytes,
    validateEncoding
  );
  if (
    nonceLength !== GCM_NONCE_BYTES ||
    ciphertextLength < GCM_TAG_BYTES ||
    (expectedCiphertextBytes !== undefined && ciphertextLength !== expectedCiphertextBytes)
  ) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Encrypted part has an invalid length");
  }
  return Object.freeze({ nonce: value.nonce, ciphertext: value.ciphertext });
}

function parseContext(value: unknown): EncryptionContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tenantId", "resourceId", "recordVersion", "kind"])
  ) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Encryption context is invalid");
  }
  if (
    !isIdentifier(value.tenantId) ||
    !isIdentifier(value.resourceId) ||
    !isRecordVersion(value.recordVersion) ||
    !isContentKind(value.kind)
  ) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Encryption context is invalid");
  }
  return Object.freeze({
    tenantId: value.tenantId,
    resourceId: value.resourceId,
    recordVersion: value.recordVersion,
    kind: value.kind
  });
}

function parseEnvelopeValue(value: unknown, validateEncoding = true): ContentEnvelopeV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "suite", "keyId", "context", "wrappedDataKey", "payload"]) ||
    value.version !== ENVELOPE_VERSION ||
    value.suite !== CIPHER_SUITE ||
    !isIdentifier(value.keyId)
  ) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Content envelope is invalid or unsupported");
  }
  return Object.freeze({
    version: ENVELOPE_VERSION,
    suite: CIPHER_SUITE,
    keyId: value.keyId,
    context: parseContext(value.context),
    wrappedDataKey: parseEncryptedPart(
      value.wrappedDataKey,
      DATA_KEY_BYTES + GCM_TAG_BYTES,
      validateEncoding
    ),
    payload: parseEncryptedPart(value.payload, undefined, validateEncoding)
  });
}

function aad(
  context: EncryptionContext,
  purpose: "content" | "data-key",
  keyId?: string
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      "unfiled-content-envelope",
      ENVELOPE_VERSION,
      CIPHER_SUITE,
      purpose,
      context.tenantId,
      context.resourceId,
      context.recordVersion,
      context.kind,
      ...(keyId === undefined ? [] : [keyId])
    ])
  );
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function gcmParameters(nonce: Uint8Array, additionalData: Uint8Array): AesGcmParams {
  return {
    name: "AES-GCM",
    iv: copiedBuffer(nonce),
    additionalData: copiedBuffer(additionalData),
    tagLength: GCM_TAG_BITS
  };
}

function assertKeyEncryptionKey(value: KeyEncryptionKey, requiredUsage: KeyUsage): void {
  assertIdentifier(value.keyId, "Key identifier");
  const algorithm = value.key.algorithm;
  if (
    algorithm.name !== "AES-GCM" ||
    !("length" in algorithm) ||
    algorithm.length !== AES_KEY_BITS ||
    value.key.extractable ||
    !value.key.usages.includes(requiredUsage)
  ) {
    fail(ContentCryptoErrorCode.INVALID_KEY, "A non-extractable AES-256-GCM key is required");
  }
}

function randomBytes(length: number, implementation: Crypto): Uint8Array {
  return implementation.getRandomValues(new Uint8Array(length));
}

async function importDataKey(raw: Uint8Array, implementation: Crypto): Promise<CryptoKey> {
  return importRawKey(raw, implementation, { name: "AES-GCM", length: AES_KEY_BITS }, [
    "encrypt",
    "decrypt"
  ]);
}

async function importRawKey(
  raw: Uint8Array,
  implementation: Crypto,
  algorithm: AesKeyAlgorithm,
  usages: readonly KeyUsage[]
): Promise<CryptoKey> {
  const importBytes = Uint8Array.from(raw);
  try {
    return await implementation.subtle.importKey("raw", importBytes, algorithm, false, usages);
  } finally {
    importBytes.fill(0);
  }
}

async function decryptDataKey(
  envelope: ContentEnvelopeV1,
  keyEncryptionKey: KeyEncryptionKey,
  implementation: Crypto
): Promise<Uint8Array> {
  if (envelope.keyId !== keyEncryptionKey.keyId) {
    fail(ContentCryptoErrorCode.KEY_NOT_FOUND, "The envelope key is unavailable");
  }
  const wrappedNonce = decodeBase64Url(envelope.wrappedDataKey.nonce, GCM_NONCE_BYTES);
  const wrappedCiphertext = decodeBase64Url(
    envelope.wrappedDataKey.ciphertext,
    DATA_KEY_BYTES + GCM_TAG_BYTES
  );
  try {
    const decrypted = await implementation.subtle.decrypt(
      gcmParameters(wrappedNonce, aad(envelope.context, "data-key", envelope.keyId)),
      keyEncryptionKey.key,
      copiedBuffer(wrappedCiphertext)
    );
    const dataKey = new Uint8Array(decrypted);
    if (dataKey.length !== DATA_KEY_BYTES) {
      dataKey.fill(0);
      fail(
        ContentCryptoErrorCode.AUTHENTICATION_FAILED,
        "Encrypted content could not be authenticated"
      );
    }
    return dataKey;
  } catch (error: unknown) {
    if (error instanceof ContentCryptoError) throw error;
    fail(
      ContentCryptoErrorCode.AUTHENTICATION_FAILED,
      "Encrypted content could not be authenticated"
    );
  }
}

export async function importKeyEncryptionKey(
  keyId: string,
  rawKey: Uint8Array,
  cryptoImplementation?: Crypto
): Promise<KeyEncryptionKey> {
  assertIdentifier(keyId, "Key identifier");
  if (rawKey.length !== DATA_KEY_BYTES) {
    fail(ContentCryptoErrorCode.INVALID_KEY, "A 32-byte key-encryption key is required");
  }
  const implementation = runtimeCrypto(cryptoImplementation);
  const key = await importRawKey(
    rawKey,
    implementation,
    { name: "AES-GCM", length: AES_KEY_BITS },
    ["encrypt", "decrypt"]
  );
  return Object.freeze({ keyId, key });
}

export async function generateKeyEncryptionKey(
  keyId: string,
  cryptoImplementation?: Crypto
): Promise<KeyEncryptionKey> {
  const implementation = runtimeCrypto(cryptoImplementation);
  const raw = randomBytes(DATA_KEY_BYTES, implementation);
  try {
    return await importKeyEncryptionKey(keyId, raw, implementation);
  } finally {
    raw.fill(0);
  }
}

export async function sealBytes(
  plaintext: Uint8Array,
  context: EncryptionContext,
  keyEncryptionKey: KeyEncryptionKey,
  cryptoImplementation?: Crypto
): Promise<ContentEnvelopeV1> {
  assertContext(context);
  assertKeyEncryptionKey(keyEncryptionKey, "encrypt");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    fail(ContentCryptoErrorCode.PLAINTEXT_TOO_LARGE, "Content exceeds the encryption size limit");
  }
  const implementation = runtimeCrypto(cryptoImplementation);
  const rawDataKey = randomBytes(DATA_KEY_BYTES, implementation);
  const payloadNonce = randomBytes(GCM_NONCE_BYTES, implementation);
  const wrappedKeyNonce = randomBytes(GCM_NONCE_BYTES, implementation);

  try {
    const dataKey = await importDataKey(rawDataKey, implementation);
    const [payloadCiphertext, wrappedDataKeyCiphertext] = await Promise.all([
      implementation.subtle.encrypt(
        gcmParameters(payloadNonce, aad(context, "content")),
        dataKey,
        copiedBuffer(plaintext)
      ),
      implementation.subtle.encrypt(
        gcmParameters(wrappedKeyNonce, aad(context, "data-key", keyEncryptionKey.keyId)),
        keyEncryptionKey.key,
        copiedBuffer(rawDataKey)
      )
    ]);
    return Object.freeze({
      version: ENVELOPE_VERSION,
      suite: CIPHER_SUITE,
      keyId: keyEncryptionKey.keyId,
      context: Object.freeze({ ...context }),
      wrappedDataKey: Object.freeze({
        nonce: encodeBase64Url(wrappedKeyNonce),
        ciphertext: encodeBase64Url(new Uint8Array(wrappedDataKeyCiphertext))
      }),
      payload: Object.freeze({
        nonce: encodeBase64Url(payloadNonce),
        ciphertext: encodeBase64Url(new Uint8Array(payloadCiphertext))
      })
    });
  } finally {
    rawDataKey.fill(0);
  }
}

export async function sealUtf8(
  plaintext: string,
  context: EncryptionContext,
  keyEncryptionKey: KeyEncryptionKey,
  cryptoImplementation?: Crypto
): Promise<ContentEnvelopeV1> {
  const bytes = new TextEncoder().encode(plaintext);
  try {
    return await sealBytes(bytes, context, keyEncryptionKey, cryptoImplementation);
  } finally {
    bytes.fill(0);
  }
}

export async function openBytes(
  envelopeValue: unknown,
  expectedContext: EncryptionContext,
  keyEncryptionKey: KeyEncryptionKey,
  cryptoImplementation?: Crypto
): Promise<Uint8Array> {
  // The decode operations below perform the full alphabet and canonical-tail validation once.
  // Avoid scanning maximum-sized ciphertext a second time while constructing the envelope view.
  const envelope = parseEnvelopeValue(envelopeValue, false);
  assertContext(expectedContext);
  assertKeyEncryptionKey(keyEncryptionKey, "decrypt");
  if (!sameContext(envelope.context, expectedContext)) {
    fail(
      ContentCryptoErrorCode.AUTHENTICATION_FAILED,
      "Encrypted content could not be authenticated"
    );
  }
  const implementation = runtimeCrypto(cryptoImplementation);
  const rawDataKey = await decryptDataKey(envelope, keyEncryptionKey, implementation);
  try {
    const dataKey = await importDataKey(rawDataKey, implementation);
    const payloadNonce = decodeBase64Url(envelope.payload.nonce, GCM_NONCE_BYTES);
    const payloadCiphertext = decodeBase64Url(
      envelope.payload.ciphertext,
      MAX_PLAINTEXT_BYTES + GCM_TAG_BYTES
    );
    try {
      const plaintext = await implementation.subtle.decrypt(
        gcmParameters(payloadNonce, aad(expectedContext, "content")),
        dataKey,
        copiedBuffer(payloadCiphertext)
      );
      return new Uint8Array(plaintext);
    } catch {
      fail(
        ContentCryptoErrorCode.AUTHENTICATION_FAILED,
        "Encrypted content could not be authenticated"
      );
    }
  } finally {
    rawDataKey.fill(0);
  }
}

export async function openUtf8(
  envelopeValue: unknown,
  expectedContext: EncryptionContext,
  keyEncryptionKey: KeyEncryptionKey,
  cryptoImplementation?: Crypto
): Promise<string> {
  const plaintext = await openBytes(
    envelopeValue,
    expectedContext,
    keyEncryptionKey,
    cryptoImplementation
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    fail(
      ContentCryptoErrorCode.AUTHENTICATION_FAILED,
      "Encrypted content could not be authenticated"
    );
  } finally {
    plaintext.fill(0);
  }
}

export async function openUtf8WithResolver(
  envelopeValue: unknown,
  expectedContext: EncryptionContext,
  resolveKey: ContentKeyResolver,
  cryptoImplementation?: Crypto
): Promise<string> {
  const envelope = parseEnvelopeValue(envelopeValue);
  const key = await resolveKey(envelope.keyId);
  if (key?.keyId !== envelope.keyId) {
    fail(ContentCryptoErrorCode.KEY_NOT_FOUND, "The envelope key is unavailable");
  }
  return openUtf8(envelope, expectedContext, key, cryptoImplementation);
}

export async function rewrapEnvelope(
  envelopeValue: unknown,
  expectedContext: EncryptionContext,
  currentKey: KeyEncryptionKey,
  replacementKey: KeyEncryptionKey,
  cryptoImplementation?: Crypto
): Promise<ContentEnvelopeV1> {
  const envelope = parseEnvelopeValue(envelopeValue);
  assertContext(expectedContext);
  assertKeyEncryptionKey(currentKey, "decrypt");
  assertKeyEncryptionKey(replacementKey, "encrypt");
  if (!sameContext(envelope.context, expectedContext)) {
    fail(
      ContentCryptoErrorCode.AUTHENTICATION_FAILED,
      "Encrypted content could not be authenticated"
    );
  }
  const implementation = runtimeCrypto(cryptoImplementation);
  const rawDataKey = await decryptDataKey(envelope, currentKey, implementation);
  const nonce = randomBytes(GCM_NONCE_BYTES, implementation);
  try {
    const ciphertext = await implementation.subtle.encrypt(
      gcmParameters(nonce, aad(expectedContext, "data-key", replacementKey.keyId)),
      replacementKey.key,
      copiedBuffer(rawDataKey)
    );
    return Object.freeze({
      ...envelope,
      keyId: replacementKey.keyId,
      wrappedDataKey: Object.freeze({
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext))
      })
    });
  } finally {
    rawDataKey.fill(0);
  }
}

export function parseContentEnvelope(serialized: string): ContentEnvelopeV1 {
  if (new TextEncoder().encode(serialized).length > MAX_SERIALIZED_ENVELOPE_BYTES) {
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Serialized envelope exceeds the size limit");
  }
  try {
    return parseEnvelopeValue(JSON.parse(serialized) as unknown);
  } catch (error: unknown) {
    if (error instanceof ContentCryptoError) throw error;
    fail(ContentCryptoErrorCode.INVALID_ENVELOPE, "Serialized envelope is invalid");
  }
}

export function serializeContentEnvelope(envelopeValue: unknown): string {
  return JSON.stringify(parseEnvelopeValue(envelopeValue));
}

export const contentCryptoLimits = Object.freeze({
  maximumPlaintextBytes: MAX_PLAINTEXT_BYTES,
  maximumSerializedEnvelopeBytes: MAX_SERIALIZED_ENVELOPE_BYTES
});
