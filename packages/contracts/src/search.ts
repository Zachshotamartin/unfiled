import { z } from "zod";

import { ArchiveFilterSchema, NoteTypeSchema, PrivacyModeSchema } from "./enums.js";
import { entityIdSchema } from "./ids.js";
import { CursorSchema, PageInfoSchema } from "./pagination.js";

/**
 * Maximum note count that the isolated verifier can prove in one bounded run.
 *
 * This is a cross-service admission contract: web defers larger generations
 * before creation and the verifier independently rejects them. The admitted
 * limit is deliberately below the 1,023-row physical worst-case
 * space from 33 pages when the fixed 8 MiB ciphertext budget fits 31
 * database-maximum rows per page. This preserves the accepted 1,000-note
 * retrieval gate without letting typical smaller rows raise the admitted count.
 */
export const RAG_GENERATION_VERIFICATION_NOTE_CAPACITY = 1_000 as const;

/**
 * Maximum distinct owner-bound object-wrap key records the verifier may open
 * in one generation. Normal generations use one active key; a higher count is
 * treated as a deterministic rebuild condition so KMS work stays bounded.
 */
export const RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS = 4 as const;

/**
 * Private search transport payload.
 *
 * Search text belongs in an authenticated JSON body, never in an API URL where
 * it can be copied into browser history, access logs, or intermediary traces.
 * A continuation cursor is opaque and can be replayed only with the same
 * normalized query and archive filter by the same authenticated owner.
 * Keep this schema strict so query-string-era fields cannot be accepted by
 * accident during the cutover.
 */
export const SearchNotesRequestSchema = z
  .strictObject({
    query: z.string().trim().min(1).max(200),
    archive: ArchiveFilterSchema.default("exclude"),
    type: NoteTypeSchema.optional(),
    spaceId: entityIdSchema("spc").nullable().optional(),
    tagIds: z.array(entityIdSchema("tag")).min(1).max(20).optional(),
    updatedFrom: z.iso.datetime({ offset: true }).optional(),
    updatedTo: z.iso.datetime({ offset: true }).optional(),
    privacy: PrivacyModeSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(30)
  })
  .superRefine(({ tagIds, updatedFrom, updatedTo }, context) => {
    if (tagIds !== undefined && new Set(tagIds).size !== tagIds.length) {
      context.addIssue({
        code: "custom",
        message: "Search tag filters must be unique",
        path: ["tagIds"]
      });
    }
    if (
      updatedFrom !== undefined &&
      updatedTo !== undefined &&
      Date.parse(updatedFrom) >= Date.parse(updatedTo)
    ) {
      context.addIssue({
        code: "custom",
        message: "updatedFrom must be earlier than updatedTo",
        path: ["updatedFrom"]
      });
    }
  });
export type SearchNotesRequest = z.input<typeof SearchNotesRequestSchema>;
export type ParsedSearchNotesRequest = z.output<typeof SearchNotesRequestSchema>;

export const USER_SEMANTIC_SEARCH_MAX_RESULTS = 8 as const;
export const USER_SEMANTIC_SEARCH_RANKING_VERSION = "encrypted-semantic-rank-v1" as const;
export const ENCRYPTED_USER_SEARCH_REQUEST_VERSION = "encrypted-user-search-request-v1" as const;
export const USER_HYBRID_SEARCH_RANKING_VERSION = "encrypted-hybrid-rank-v1" as const;
const ENCRYPTED_USER_SEARCH_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const USER_SEARCH_GENERATION_DIGEST_DOMAIN = "unfiled/user-search-generation/v1\0";
const USER_SEARCH_RESULT_DIGEST_DOMAIN = "unfiled/user-search-result/v1\0";

const SearchSpaceFilterSchema = z
  .strictObject({
    mode: z.enum(["any", "root", "exact"]),
    id: entityIdSchema("spc").nullable()
  })
  .superRefine(({ id, mode }, context) => {
    if ((mode === "exact") !== (id !== null)) {
      context.addIssue({
        code: "custom",
        message: "Exact space filters require an id and other space filters forbid one",
        path: ["id"]
      });
    }
  });

/**
 * Canonical filter manifest accepted by the isolated semantic-search trust
 * domain. Privacy is deliberately fixed to AI-assisted; omitted, mixed, and
 * private-manual searches never enter this transport.
 */
export const EncryptedUserSearchFilterManifestSchema = z
  .strictObject({
    archive: ArchiveFilterSchema,
    privacy: z.literal("ai_assisted"),
    type: NoteTypeSchema.nullable(),
    space: SearchSpaceFilterSchema,
    tagIds: z.array(entityIdSchema("tag")).max(20),
    updatedFrom: z.iso.datetime({ offset: true }).nullable(),
    updatedTo: z.iso.datetime({ offset: true }).nullable()
  })
  .superRefine(({ tagIds, updatedFrom, updatedTo }, context) => {
    if (
      new Set(tagIds).size !== tagIds.length ||
      tagIds.some((tagId, index) => {
        const previous = tagIds[index - 1];
        return previous !== undefined && previous >= tagId;
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Semantic search tag filters must be unique and sorted",
        path: ["tagIds"]
      });
    }
    if (
      updatedFrom !== null &&
      updatedTo !== null &&
      Date.parse(updatedFrom) >= Date.parse(updatedTo)
    ) {
      context.addIssue({
        code: "custom",
        message: "updatedFrom must be earlier than updatedTo",
        path: ["updatedFrom"]
      });
    }
  });
export type EncryptedUserSearchFilterManifest = z.infer<
  typeof EncryptedUserSearchFilterManifestSchema
>;

export const EncryptedUserSearchMatchSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  indexedRevision: z.number().int().min(1),
  score: z.number().min(0).max(1.2)
});
export type EncryptedUserSearchMatch = z.infer<typeof EncryptedUserSearchMatchSchema>;

export const EncryptedUserSearchContinuationSchema = z.strictObject({
  generationBindingDigest: z.string().regex(ENCRYPTED_USER_SEARCH_DIGEST_PATTERN),
  rankingVersion: z.literal(USER_SEMANTIC_SEARCH_RANKING_VERSION),
  resultDigest: z.string().regex(ENCRYPTED_USER_SEARCH_DIGEST_PATTERN),
  boundary: EncryptedUserSearchMatchSchema.nullable()
});
export type EncryptedUserSearchContinuation = z.infer<typeof EncryptedUserSearchContinuationSchema>;

export const EncryptedUserSearchMaterialSchema = z.strictObject({
  requestVersion: z.literal(ENCRYPTED_USER_SEARCH_REQUEST_VERSION),
  hybridRankingVersion: z.literal(USER_HYBRID_SEARCH_RANKING_VERSION),
  query: z.string().trim().min(1).max(200),
  filters: EncryptedUserSearchFilterManifestSchema,
  pageLimit: z.number().int().min(1).max(100),
  maxResults: z.literal(USER_SEMANTIC_SEARCH_MAX_RESULTS),
  continuation: EncryptedUserSearchContinuationSchema.nullable()
});
export type EncryptedUserSearchMaterial = z.infer<typeof EncryptedUserSearchMaterialSchema>;

/** Stable, fixed-key-order bytes hashed on both sides of the capability hop. */
export function serializeEncryptedUserSearchMaterial(value: EncryptedUserSearchMaterial): string {
  const parsed = EncryptedUserSearchMaterialSchema.parse(value);
  return JSON.stringify({
    requestVersion: parsed.requestVersion,
    hybridRankingVersion: parsed.hybridRankingVersion,
    query: parsed.query,
    filters: {
      archive: parsed.filters.archive,
      privacy: parsed.filters.privacy,
      type: parsed.filters.type,
      space: { mode: parsed.filters.space.mode, id: parsed.filters.space.id },
      tagIds: parsed.filters.tagIds,
      updatedFrom: parsed.filters.updatedFrom,
      updatedTo: parsed.filters.updatedTo
    },
    pageLimit: parsed.pageLimit,
    maxResults: parsed.maxResults,
    continuation:
      parsed.continuation === null
        ? null
        : {
            generationBindingDigest: parsed.continuation.generationBindingDigest,
            rankingVersion: parsed.continuation.rankingVersion,
            resultDigest: parsed.continuation.resultDigest,
            boundary:
              parsed.continuation.boundary === null
                ? null
                : {
                    score: parsed.continuation.boundary.score,
                    noteId: parsed.continuation.boundary.noteId,
                    indexedRevision: parsed.continuation.boundary.indexedRevision
                  }
          }
  });
}

export function encryptedUserSearchMaterialFromRequest(
  value: ParsedSearchNotesRequest
): EncryptedUserSearchMaterial | null {
  if (value.privacy !== "ai_assisted") return null;
  const tagIds = [...(value.tagIds ?? [])].sort();
  return EncryptedUserSearchMaterialSchema.parse({
    requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
    hybridRankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
    query: value.query,
    filters: {
      archive: value.archive,
      privacy: "ai_assisted",
      type: value.type ?? null,
      space:
        value.spaceId === undefined
          ? { mode: "any", id: null }
          : value.spaceId === null
            ? { mode: "root", id: null }
            : { mode: "exact", id: value.spaceId },
      tagIds,
      updatedFrom: value.updatedFrom ?? null,
      updatedTo: value.updatedTo ?? null
    },
    pageLimit: value.limit,
    maxResults: USER_SEMANTIC_SEARCH_MAX_RESULTS,
    continuation: null
  });
}

export const EncryptedUserSearchInvocationSchema = z.strictObject({
  searchId: z.uuid(),
  claimSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  material: EncryptedUserSearchMaterialSchema
});
export type EncryptedUserSearchInvocation = z.infer<typeof EncryptedUserSearchInvocationSchema>;

export const EncryptedUserSearchResultSchema = z.strictObject({
  searchId: z.uuid(),
  generationId: z.string().regex(/^igen_[0-9A-HJKMNP-TV-Z]{26}$/u),
  generationAttestationDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  generationRevisionToken: z.string().min(1).max(256),
  rankingVersion: z.literal(USER_SEMANTIC_SEARCH_RANKING_VERSION),
  items: z.array(EncryptedUserSearchMatchSchema).max(USER_SEMANTIC_SEARCH_MAX_RESULTS),
  scannedNoteCount: z.number().int().min(0).max(RAG_GENERATION_VERIFICATION_NOTE_CAPACITY)
});
export type EncryptedUserSearchResult = z.infer<typeof EncryptedUserSearchResultSchema>;

type EncryptedUserSearchGenerationBindingDigestInput = Readonly<
  Pick<
    EncryptedUserSearchResult,
    "generationAttestationDigest" | "generationId" | "generationRevisionToken"
  >
>;

type EncryptedUserSearchResultDigestInput = Readonly<{
  generationBindingDigest: string;
  items: readonly EncryptedUserSearchMatch[];
  rankingVersion: typeof USER_SEMANTIC_SEARCH_RANKING_VERSION;
}>;

function framedDigestBytes(domain: string, fields: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const domainBytes = encoder.encode(domain);
  const fieldBytes = fields.map((field) => encoder.encode(field));
  const length =
    domainBytes.byteLength + fieldBytes.reduce((total, field) => total + 4 + field.byteLength, 0);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  try {
    output.set(domainBytes, offset);
    offset += domainBytes.byteLength;
    for (const field of fieldBytes) {
      view.setUint32(offset, field.byteLength);
      offset += 4;
      output.set(field, offset);
      offset += field.byteLength;
    }
    return output;
  } finally {
    domainBytes.fill(0);
    for (const field of fieldBytes) field.fill(0);
  }
}

async function sha256FramedHex(domain: string, fields: readonly string[]): Promise<string> {
  const runtime = globalThis as unknown as Readonly<{
    crypto?: Readonly<{ subtle?: SubtleCrypto }>;
  }>;
  const subtle = runtime.crypto?.subtle;
  if (subtle === undefined) throw new TypeError("SHA-256 is unavailable");
  const bytes = framedDigestBytes(domain, fields);
  try {
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    try {
      return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    } finally {
      digest.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

/** Digest shared by the web cursor and isolated search generation binding. */
export async function encryptedUserSearchGenerationBindingDigest(
  input: EncryptedUserSearchGenerationBindingDigestInput
): Promise<string> {
  const parsed = EncryptedUserSearchResultSchema.pick({
    generationAttestationDigest: true,
    generationId: true,
    generationRevisionToken: true
  }).parse({
    generationAttestationDigest: input.generationAttestationDigest,
    generationId: input.generationId,
    generationRevisionToken: input.generationRevisionToken
  });
  return sha256FramedHex(USER_SEARCH_GENERATION_DIGEST_DOMAIN, [
    parsed.generationId,
    parsed.generationRevisionToken,
    parsed.generationAttestationDigest
  ]);
}

function canonicalSearchScore(score: number): string {
  return Object.is(score, -0) ? "0" : String(score);
}

/** Digest of the exact ordered semantic top-K returned to the web trust domain. */
export async function encryptedUserSearchResultDigest(
  input: EncryptedUserSearchResultDigestInput
): Promise<string> {
  const observedRankingVersion: unknown = input.rankingVersion;
  if (
    !ENCRYPTED_USER_SEARCH_DIGEST_PATTERN.test(input.generationBindingDigest) ||
    observedRankingVersion !== USER_SEMANTIC_SEARCH_RANKING_VERSION
  ) {
    throw new TypeError("Invalid encrypted search digest input");
  }
  const items = z
    .array(EncryptedUserSearchMatchSchema)
    .max(USER_SEMANTIC_SEARCH_MAX_RESULTS)
    .parse(input.items);
  return sha256FramedHex(USER_SEARCH_RESULT_DIGEST_DOMAIN, [
    input.generationBindingDigest,
    input.rankingVersion,
    String(items.length),
    ...items.flatMap((item) => [
      canonicalSearchScore(item.score),
      item.noteId,
      String(item.indexedRevision)
    ])
  ]);
}

export const SearchNoteResultSchema = z.strictObject({
  noteId: entityIdSchema("note"),
  title: z.string().min(1).max(200),
  type: NoteTypeSchema,
  snippet: z.string().max(500),
  spacePath: z.array(z.string().min(1).max(60)).max(2),
  updatedAt: z.iso.datetime({ offset: true }),
  archivedAt: z.iso.datetime({ offset: true }).nullable()
});
export type SearchNoteResult = z.infer<typeof SearchNoteResultSchema>;

export const SearchNotesResponseSchema = z.strictObject({
  items: z.array(SearchNoteResultSchema),
  pageInfo: PageInfoSchema
});
export type SearchNotesResponse = z.infer<typeof SearchNotesResponseSchema>;
