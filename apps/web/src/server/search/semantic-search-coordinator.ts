import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import {
  EncryptedUserSearchMaterialSchema,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  serializeEncryptedUserSearchMaterial,
  type EncryptedUserSearchMaterial,
  type EncryptedUserSearchResult
} from "@unfiled/contracts";

import type { EncryptedUserSearchCapabilityRpcAdapter } from "./capability-rpc-adapter";
import { encryptedUserSearchFailure, EncryptedUserSearchError } from "./errors";
import type { EncryptedUserSearchClient } from "./search-client";

const CLAIM_SECRET_BYTES = 32;
const CLAIM_LIFETIME_MAX_MS = 31_000;
const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type CoordinatorDependencies = Readonly<{
  capability: EncryptedUserSearchCapabilityRpcAdapter;
  client: EncryptedUserSearchClient;
  ownerId: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  utf8Bytes?: (value: string) => Buffer;
}>;

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function abortable<Result>(
  operation: () => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> {
  if (signal === undefined) {
    try {
      return Promise.resolve(operation());
    } catch {
      return Promise.reject(new EncryptedUserSearchError());
    }
  }
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => reject(new EncryptedUserSearchError()));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let pending: Promise<Result>;
    try {
      pending = Promise.resolve(operation());
    } catch {
      finish(() => reject(new EncryptedUserSearchError()));
      return;
    }
    void pending.then(
      (value) => {
        if (signal.aborted) onAbort();
        else finish(() => resolve(value));
      },
      () => finish(() => reject(new EncryptedUserSearchError()))
    );
  });
}

/**
 * Mints exactly one owner-bound database capability and exchanges only its
 * owner-independent invocation with the isolated search trust domain.
 */
export class SemanticSearchCoordinator {
  private readonly capability: EncryptedUserSearchCapabilityRpcAdapter;
  private readonly client: EncryptedUserSearchClient;
  private readonly ownerId: string;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly utf8Bytes: (value: string) => Buffer;

  public constructor(dependencies: CoordinatorDependencies) {
    if (typeof dependencies.ownerId !== "string") encryptedUserSearchFailure();
    const ownerId = dependencies.ownerId.toLowerCase();
    if (!OWNER_ID_PATTERN.test(ownerId)) encryptedUserSearchFailure();
    this.capability = dependencies.capability;
    this.client = dependencies.client;
    this.ownerId = ownerId;
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
    this.utf8Bytes = dependencies.utf8Bytes ?? ((value) => Buffer.from(value, "utf8"));
  }

  public async search(
    material: EncryptedUserSearchMaterial,
    signal?: AbortSignal
  ): Promise<EncryptedUserSearchResult> {
    let secretBytes: Buffer | undefined;
    let secretTextBytes: Buffer | undefined;
    let materialBytes: Buffer | undefined;
    let claimSecret = "";
    try {
      if (signal?.aborted === true) return encryptedUserSearchFailure();
      const parsedMaterial = EncryptedUserSearchMaterialSchema.safeParse(material);
      if (!parsedMaterial.success) return encryptedUserSearchFailure();

      const serializedMaterial = serializeEncryptedUserSearchMaterial(parsedMaterial.data);
      materialBytes = this.utf8Bytes(serializedMaterial);
      if (!Buffer.isBuffer(materialBytes) || materialBytes.byteLength < 1) {
        return encryptedUserSearchFailure();
      }
      const requestDigest = digest(materialBytes);
      materialBytes.fill(0);

      secretBytes = this.randomBytes(CLAIM_SECRET_BYTES);
      if (!Buffer.isBuffer(secretBytes) || secretBytes.byteLength !== CLAIM_SECRET_BYTES) {
        return encryptedUserSearchFailure();
      }
      claimSecret = secretBytes.toString("base64url");
      secretBytes.fill(0);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(claimSecret)) return encryptedUserSearchFailure();
      secretTextBytes = this.utf8Bytes(claimSecret);
      if (!Buffer.isBuffer(secretTextBytes) || secretTextBytes.byteLength !== 43) {
        return encryptedUserSearchFailure();
      }
      const claimSecretDigest = digest(secretTextBytes);
      secretTextBytes.fill(0);

      const begun = await abortable(
        () =>
          this.capability.begin({
            ownerId: this.ownerId,
            requestDigest,
            filterManifest: parsedMaterial.data.filters,
            claimSecretDigest
          }),
        signal
      );
      const observedAt = this.now();
      const claimExpiresAt = Date.parse(begun.claimExpiresAt);
      if (
        begun.requestDigest !== requestDigest ||
        !Number.isFinite(observedAt) ||
        !Number.isFinite(claimExpiresAt) ||
        claimExpiresAt <= observedAt ||
        claimExpiresAt > observedAt + CLAIM_LIFETIME_MAX_MS
      ) {
        return encryptedUserSearchFailure();
      }

      const result = await abortable(
        () =>
          this.client.query(
            {
              searchId: begun.searchId,
              claimSecret,
              requestDigest,
              material: parsedMaterial.data
            },
            signal
          ),
        signal
      );
      const observedRankingVersion: unknown = result.rankingVersion;
      if (
        result.searchId !== begun.searchId ||
        result.generationId !== begun.generation.generationId ||
        result.generationRevisionToken !== begun.generation.revisionToken ||
        result.generationAttestationDigest !== begun.generation.attestationDigest ||
        observedRankingVersion !== USER_SEMANTIC_SEARCH_RANKING_VERSION
      ) {
        return encryptedUserSearchFailure();
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof EncryptedUserSearchError) throw error;
      return encryptedUserSearchFailure();
    } finally {
      secretBytes?.fill(0);
      secretTextBytes?.fill(0);
      materialBytes?.fill(0);
      claimSecret = "";
    }
  }
}

export function createSemanticSearchCoordinator(
  dependencies: CoordinatorDependencies
): SemanticSearchCoordinator {
  return new SemanticSearchCoordinator(dependencies);
}
