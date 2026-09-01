import { openBytes } from "@unfiled/content-crypto";
import { decodePrivateRagIndexEmbedding, parsePrivateRagIndexDocumentBytes } from "@unfiled/search";

import type { BuildingGeneration, BuildingIndexItem } from "./database.js";
import { GenerationVerificationError, VerifierUnavailableError } from "./errors.js";
import type { VerifierKeySession } from "./kms.js";

export type StrictIndexDocumentOpener = Readonly<{
  validate(
    ownerId: string,
    generation: BuildingGeneration,
    item: BuildingIndexItem,
    keys: VerifierKeySession,
    signal: AbortSignal
  ): Promise<void>;
}>;

export function createStrictIndexDocumentOpener(): StrictIndexDocumentOpener {
  return Object.freeze({
    async validate(ownerId, generation, item, keys, signal): Promise<void> {
      if (signal.aborted) throw new VerifierUnavailableError();
      let plaintext: Uint8Array | undefined;
      try {
        const key = await keys.keyFor(item.keyRecord, signal);
        if (
          key.keyId !== item.cipher.keyId ||
          item.keyRecord.ownerId !== ownerId ||
          item.keyRecord.keyId !== item.cipher.keyId ||
          item.keyRecord.keyVersion !== item.cipher.keyVersion
        ) {
          throw new GenerationVerificationError();
        }
        plaintext = await openBytes(
          item.cipher.envelope,
          {
            tenantId: ownerId,
            resourceId: item.indexId,
            recordVersion: item.indexedRevision,
            kind: "note_rag_index"
          },
          key
        );
        const document = parsePrivateRagIndexDocumentBytes(plaintext, {
          noteId: item.noteId,
          indexedRevision: item.indexedRevision,
          modelId: generation.embeddingModelId,
          dimensions: generation.embeddingDimensions
        });
        const embedding = decodePrivateRagIndexEmbedding(document);
        embedding.fill(0);
      } catch (error: unknown) {
        if (
          error instanceof VerifierUnavailableError ||
          error instanceof GenerationVerificationError
        ) {
          throw error;
        }
        throw new GenerationVerificationError();
      } finally {
        plaintext?.fill(0);
      }
    }
  });
}
