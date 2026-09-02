import { DecryptCommand, KMSClient, type KMSClientConfig } from "@aws-sdk/client-kms";
import { importKeyEncryptionKey, type KeyEncryptionKey } from "@unfiled/content-crypto";
import {
  assertCanonicalEncryptedKeyMaterial,
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  kmsEncryptionContextForKey,
  parseManagedKeyRecordV1,
  parseManagedKeyRecordV2,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser,
  type ManagedKeyRecordV1,
  type ManagedKeyRecordV2
} from "@unfiled/key-management";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

import type {
  AwsVerifierKmsConfig,
  VerifierKmsConfig,
  VercelSensitiveEnvironmentVerifierKeyConfig
} from "./config.js";
import { GenerationVerificationError, VerifierUnavailableError } from "./errors.js";
import {
  isVerifiedVerifierInvocation,
  type VerifiedVerifierInvocation
} from "./invocation-auth.js";

const INTERMEDIATE_KEY_BYTES = 32;
const MAX_KMS_CIPHERTEXT_BYTES = 8_192;

export type VerifierKmsClient = Readonly<{
  destroy(): void;
  send(command: unknown, options?: Readonly<{ abortSignal?: AbortSignal }>): Promise<unknown>;
}>;

export type VerifierKeySession = Readonly<{
  keyFor(record: ManagedKeyRecord, signal: AbortSignal): Promise<KeyEncryptionKey>;
}>;

export type VerifierKmsAdapter = Readonly<{
  withKeySession<Result>(
    config: VerifierKmsConfig,
    proof: Readonly<{
      invocation: VerifiedVerifierInvocation;
      requestId: string;
      runtime: "preview" | "production";
    }>,
    signal: AbortSignal,
    use: (session: VerifierKeySession) => Promise<Result>
  ): Promise<Result>;
}>;

type VerifierKmsProof = Readonly<{
  invocation: VerifiedVerifierInvocation;
  requestId: string;
  runtime: "preview" | "production";
}>;

type KmsClientFactory = (configuration: KMSClientConfig) => VerifierKmsClient;

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new VerifierUnavailableError();
}

function keyIdentity(record: ManagedKeyRecord): string {
  return `${record.ownerId}:${record.keyId}:${record.keyVersion}`;
}

function keyCryptographicFingerprint(record: ManagedKeyRecord): string {
  return JSON.stringify([
    record.ownerId,
    record.keyClass,
    record.purpose,
    record.keyId,
    record.keyVersion,
    record.schemaVersion === 1 ? record.rootKeyArn : record.rootKeyId,
    record.encryptedKeyMaterial
  ]);
}

function decodeEncryptedKeyMaterial(record: ManagedKeyRecordV1): Uint8Array {
  const bytes = Buffer.from(record.encryptedKeyMaterial, "base64url");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_KMS_CIPHERTEXT_BYTES ||
    bytes.toString("base64url") !== record.encryptedKeyMaterial
  ) {
    bytes.fill(0);
    throw new GenerationVerificationError();
  }
  return bytes;
}

function allowedRoot(config: AwsVerifierKmsConfig, rootKeyArn: string): boolean {
  return (
    rootKeyArn === config.activeObjectWrapRootArn ||
    config.retiredObjectWrapRootArns.includes(rootKeyArn)
  );
}

function isInvalidCiphertextError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "InvalidCiphertextException"
  );
}

function parseVerifierKeyRecord(
  value: ManagedKeyRecord,
  config: AwsVerifierKmsConfig
): ManagedKeyRecordV1 {
  let record: ManagedKeyRecordV1;
  try {
    record = parseManagedKeyRecordV1(value);
  } catch {
    try {
      assertCanonicalEncryptedKeyMaterial(value.encryptedKeyMaterial);
    } catch {
      throw new GenerationVerificationError();
    }
    throw new VerifierUnavailableError();
  }
  if (
    record.keyClass !== "ai_assisted" ||
    record.purpose !== "object_wrap" ||
    (record.status !== "active" && record.status !== "retired") ||
    !allowedRoot(config, record.rootKeyArn)
  ) {
    throw new VerifierUnavailableError();
  }
  return record;
}

export function managedKeyRecordParserForVerifierConfig(
  config: VerifierKmsConfig
): ManagedKeyRecordParser {
  return config.kind === "vercel-sensitive-env-v1"
    ? parseManagedKeyRecordV2
    : parseManagedKeyRecordV1;
}

function parseSensitiveVerifierKeyRecord(
  value: ManagedKeyRecord,
  config: VercelSensitiveEnvironmentVerifierKeyConfig
): ManagedKeyRecordV2 {
  let record: ManagedKeyRecordV2;
  try {
    record = parseManagedKeyRecordV2(value);
  } catch {
    throw new VerifierUnavailableError();
  }
  if (
    record.keyClass !== "ai_assisted" ||
    record.purpose !== "object_wrap" ||
    (record.status !== "active" && record.status !== "retired") ||
    (record.rootKeyId !== config.activeObjectWrapRootKeyId &&
      !config.retiredObjectWrapRootKeyIds.includes(record.rootKeyId))
  ) {
    throw new VerifierUnavailableError();
  }
  return record;
}

async function withSensitiveKeySession<Result>(
  config: VercelSensitiveEnvironmentVerifierKeyConfig,
  proof: VerifierKmsProof,
  signal: AbortSignal,
  use: (session: VerifierKeySession) => Promise<Result>
): Promise<Result> {
  if (
    signal.aborted ||
    config.deploymentEnvironment !== proof.runtime ||
    !isVerifiedVerifierInvocation(proof.invocation, {
      requestId: proof.requestId,
      runtime: proof.runtime
    })
  ) {
    throw new VerifierUnavailableError();
  }
  let transport:
    Awaited<ReturnType<typeof createVercelSensitiveEnvironmentKmsTransport>> | undefined;
  const cache = new Map<string, Promise<KeyEncryptionKey>>();
  const fingerprints = new Map<string, string>();
  let open = true;
  try {
    transport = await createVercelSensitiveEnvironmentKmsTransport({
      expectedRootKeyIds: [config.activeObjectWrapRootKeyId, ...config.retiredObjectWrapRootKeyIds]
    });
    assertNotAborted(signal);
    const custodian = createVercelSensitiveEnvironmentEnvelopeCustodian({
      activeRoots: {
        ai_assisted: { object_wrap: config.activeObjectWrapRootKeyId }
      },
      deploymentEnvironment: config.deploymentEnvironment,
      retiredRoots: {
        ai_assisted: { object_wrap: config.retiredObjectWrapRootKeyIds }
      },
      transport,
      workload: "search_worker"
    });
    const session: VerifierKeySession = Object.freeze({
      keyFor(value, operationSignal) {
        if (!open || signal.aborted || operationSignal.aborted) {
          return Promise.reject(new VerifierUnavailableError());
        }
        let record: ManagedKeyRecordV2;
        try {
          record = parseSensitiveVerifierKeyRecord(value, config);
        } catch {
          return Promise.reject(new VerifierUnavailableError());
        }
        const identity = keyIdentity(record);
        const fingerprint = keyCryptographicFingerprint(record);
        const knownFingerprint = fingerprints.get(identity);
        if (knownFingerprint !== undefined && knownFingerprint !== fingerprint) {
          return Promise.reject(new VerifierUnavailableError());
        }
        const existing = cache.get(identity);
        if (existing !== undefined) return existing;
        if (cache.size >= config.maxKeyRecords) {
          return Promise.reject(new GenerationVerificationError());
        }
        fingerprints.set(identity, fingerprint);
        const combinedSignal = AbortSignal.any([
          signal,
          operationSignal,
          AbortSignal.timeout(config.timeoutMs)
        ]);
        const pending = custodian.withUnwrappedIntermediateKey(
          record,
          async (bytes) => {
            if (combinedSignal.aborted || bytes.byteLength !== INTERMEDIATE_KEY_BYTES) {
              throw new VerifierUnavailableError();
            }
            const copy = new Uint8Array(bytes);
            try {
              return await importKeyEncryptionKey(record.keyId, copy);
            } finally {
              copy.fill(0);
            }
          },
          { signal: combinedSignal }
        );
        cache.set(identity, pending);
        return pending;
      }
    });
    return await use(session);
  } catch (error: unknown) {
    if (error instanceof GenerationVerificationError || error instanceof VerifierUnavailableError) {
      throw error;
    }
    throw new VerifierUnavailableError();
  } finally {
    open = false;
    cache.clear();
    fingerprints.clear();
    transport?.destroy();
  }
}

function defaultKmsClientFactory(configuration: KMSClientConfig): VerifierKmsClient {
  return new KMSClient(configuration);
}

function abortableKmsOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  disposeLateValue: (value: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new VerifierUnavailableError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error: unknown) {
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new VerifierUnavailableError());
      return;
    }
    void pending.then(
      (value) => {
        if (settled) {
          disposeLateValue(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new VerifierUnavailableError());
      }
    );
  });
}

function wipeKmsPlaintext(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "Plaintext" in value &&
    value.Plaintext instanceof Uint8Array
  ) {
    value.Plaintext.fill(0);
  }
}

export function createVerifierKmsAdapter(
  kmsClientFactory: KmsClientFactory = defaultKmsClientFactory
): VerifierKmsAdapter {
  return Object.freeze({
    async withKeySession<Result>(
      config: VerifierKmsConfig,
      proof: VerifierKmsProof,
      signal: AbortSignal,
      use: (session: VerifierKeySession) => Promise<Result>
    ): Promise<Result> {
      if (config.kind === "vercel-sensitive-env-v1") {
        return withSensitiveKeySession(config, proof, signal, use);
      }
      const boundaryEnvironment =
        /^owner:[^:]+:project:[^:]+:environment:(preview|production)$/u.exec(
          config.expectedOidcSubject
        )?.[1];
      if (
        signal.aborted ||
        boundaryEnvironment !== proof.runtime ||
        !isVerifiedVerifierInvocation(proof.invocation, {
          requestId: proof.requestId,
          runtime: proof.runtime
        })
      ) {
        throw new VerifierUnavailableError();
      }
      let client: VerifierKmsClient;
      try {
        client = kmsClientFactory({
          credentials: awsCredentialsProvider({
            audience: config.oidcAudience,
            roleArn: config.roleArn,
            roleSessionName: "unfiled-rag-verifier"
          }),
          maxAttempts: 3,
          region: config.region
        });
      } catch {
        throw new VerifierUnavailableError();
      }
      const revocation = new AbortController();
      const cache = new Map<string, Promise<KeyEncryptionKey>>();
      const cryptographicFingerprints = new Map<string, string>();
      const inFlight = new Set<Promise<KeyEncryptionKey>>();
      let open = true;
      const sessionIsOpen = (): boolean => open;
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closing !== undefined) return closing;
        open = false;
        revocation.abort();
        cache.clear();
        cryptographicFingerprints.clear();
        const operations = [...inFlight];
        closing = (async (): Promise<void> => {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          const boundedDrain = new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, config.timeoutMs);
          });
          await Promise.race([Promise.allSettled(operations).then(() => undefined), boundedDrain]);
          if (drainTimer !== undefined) clearTimeout(drainTimer);
          client.destroy();
        })();
        return closing;
      };
      const closeOnAbort = (): void => {
        void close();
      };
      signal.addEventListener("abort", closeOnAbort, { once: true });

      const keyFor = async (
        value: ManagedKeyRecord,
        operationSignal: AbortSignal
      ): Promise<KeyEncryptionKey> => {
        if (!open || signal.aborted || operationSignal.aborted) {
          throw new VerifierUnavailableError();
        }
        const record = parseVerifierKeyRecord(value, config);
        const identity = keyIdentity(record);
        const cryptographicFingerprint = keyCryptographicFingerprint(record);
        const existingFingerprint = cryptographicFingerprints.get(identity);
        if (existingFingerprint !== undefined && existingFingerprint !== cryptographicFingerprint) {
          throw new VerifierUnavailableError();
        }
        const existing = cache.get(identity);
        if (existing !== undefined) return existing;
        if (cache.size >= config.maxKeyRecords) throw new GenerationVerificationError();
        cryptographicFingerprints.set(identity, cryptographicFingerprint);
        const pending = (async (): Promise<KeyEncryptionKey> => {
          const ciphertext = decodeEncryptedKeyMaterial(record);
          const timeout = AbortSignal.timeout(config.timeoutMs);
          const combinedSignal = AbortSignal.any([
            signal,
            operationSignal,
            revocation.signal,
            timeout
          ]);
          try {
            const response = (await abortableKmsOperation(
              () =>
                client.send(
                  new DecryptCommand({
                    CiphertextBlob: ciphertext,
                    EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                    EncryptionContext: kmsEncryptionContextForKey(record),
                    KeyId: record.rootKeyArn
                  }),
                  { abortSignal: combinedSignal }
                ),
              combinedSignal,
              wipeKmsPlaintext
            )) as Readonly<{ KeyId?: string; Plaintext?: Uint8Array }>;
            const plaintext = response.Plaintext;
            if (!sessionIsOpen() || combinedSignal.aborted) {
              plaintext?.fill(0);
              throw new VerifierUnavailableError();
            }
            if (
              response.KeyId !== record.rootKeyArn ||
              !(plaintext instanceof Uint8Array) ||
              plaintext.byteLength !== INTERMEDIATE_KEY_BYTES
            ) {
              plaintext?.fill(0);
              throw new GenerationVerificationError();
            }
            const copy = new Uint8Array(plaintext);
            plaintext.fill(0);
            try {
              return await importKeyEncryptionKey(record.keyId, copy);
            } finally {
              copy.fill(0);
            }
          } catch (error: unknown) {
            if (
              error instanceof VerifierUnavailableError ||
              error instanceof GenerationVerificationError
            ) {
              throw error;
            }
            if (!sessionIsOpen() || combinedSignal.aborted) {
              throw new VerifierUnavailableError();
            }
            if (isInvalidCiphertextError(error)) throw new GenerationVerificationError();
            throw new VerifierUnavailableError();
          } finally {
            ciphertext.fill(0);
          }
        })();
        cache.set(identity, pending);
        inFlight.add(pending);
        void pending.then(
          () => {
            inFlight.delete(pending);
          },
          () => {
            inFlight.delete(pending);
          }
        );
        return pending;
      };

      const session: VerifierKeySession = Object.freeze({ keyFor });
      try {
        return await use(session);
      } finally {
        signal.removeEventListener("abort", closeOnAbort);
        await close();
      }
    }
  });
}

export const unconfiguredVerifierKmsAdapter: VerifierKmsAdapter = Object.freeze({
  withKeySession(): Promise<never> {
    return Promise.reject(new VerifierUnavailableError());
  }
});
