import { describe, expect, it, vi } from "vitest";

import {
  createGenerationVerificationRepository,
  parseRevisionToken,
  type VerifierDatabaseQueryExecutor
} from "../src/database";
import {
  ATTESTATION_DIGEST,
  GENERATION_ID,
  OWNER_ID,
  buildingPage,
  databasePageJson,
  verification,
  verifiedGeneration
} from "./fixtures";

const identity = { sessionUser: "unfiled_rag_verifier", currentUser: "unfiled_rag_verifier" };

function executorFor(result: unknown): {
  executor: VerifierDatabaseQueryExecutor;
  query: ReturnType<typeof vi.fn<VerifierDatabaseQueryExecutor["query"]>>;
  releaseSession: ReturnType<
    typeof vi.fn<NonNullable<VerifierDatabaseQueryExecutor["releaseSession"]>>
  >;
} {
  const query = vi.fn<VerifierDatabaseQueryExecutor["query"]>((request) => {
    if (request.text.startsWith("select session_user")) {
      return Promise.resolve({ rows: [identity] });
    }
    return Promise.resolve({ rows: [{ result }] });
  });
  const releaseSession = vi.fn<NonNullable<VerifierDatabaseQueryExecutor["releaseSession"]>>();
  return { executor: { query, releaseSession }, query, releaseSession };
}

interface MutableDatabasePage {
  extra?: unknown;
  generation: {
    embeddingModelId: string;
    indexedNoteCount: number;
    revisionToken: string;
    state: string;
  };
  items: {
    cipher: {
      envelope: { payload: { ciphertext: string } };
      keyId: string;
    };
    encryptedByteLength: number;
    noteId: string;
  }[];
  keys: (Record<string, unknown> & {
    keyClass: string;
    keyId: string;
    purpose: string;
    status: string;
  })[];
  ownerId: string;
  page: {
    ciphertextBytes: number;
    hasMore: boolean;
    nextCursor: unknown;
    returnedCount: number;
  };
  verification: {
    attestationDigest: string;
    domain: string;
  } | null;
}

function mutablePage(value: unknown): MutableDatabasePage {
  return structuredClone(value) as MutableDatabasePage;
}

function first<Value>(values: readonly Value[]): Value {
  const value = values[0];
  if (value === undefined) throw new Error("expected fixture value");
  return value;
}

function terminalAttestation(
  value: MutableDatabasePage
): NonNullable<MutableDatabasePage["verification"]> {
  if (value.verification === null) throw new Error("expected terminal attestation");
  return value.verification;
}

const pageMutations: readonly [string, (value: MutableDatabasePage) => void][] = [
  [
    "wrong owner",
    (value) => {
      value.ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    }
  ],
  [
    "extra field",
    (value) => {
      value.extra = true;
    }
  ],
  [
    "non-building",
    (value) => {
      value.generation.state = "active";
    }
  ],
  [
    "token drift",
    (value) => {
      value.generation.revisionToken = "5";
    }
  ],
  [
    "count drift",
    (value) => {
      value.generation.indexedNoteCount = 2;
    }
  ],
  [
    "bad model",
    (value) => {
      value.generation.embeddingModelId = "bad model";
    }
  ],
  [
    "missing key",
    (value) => {
      value.keys = [];
    }
  ],
  [
    "extra key",
    (value) => {
      value.keys.push({ ...first(value.keys), keyId: "extra-key" });
    }
  ],
  [
    "private key",
    (value) => {
      first(value.keys).keyClass = "private_manual";
    }
  ],
  [
    "content mac",
    (value) => {
      first(value.keys).purpose = "content_mac";
    }
  ],
  [
    "revoked key",
    (value) => {
      first(value.keys).status = "revoked";
    }
  ],
  [
    "key mismatch",
    (value) => {
      first(value.items).cipher.keyId = "other-key";
    }
  ],
  [
    "note id",
    (value) => {
      first(value.items).noteId = "bad";
    }
  ],
  [
    "cipher length",
    (value) => {
      first(value.items).encryptedByteLength += 1;
    }
  ],
  [
    "page count",
    (value) => {
      value.page.returnedCount = 0;
    }
  ],
  [
    "page bytes",
    (value) => {
      value.page.ciphertextBytes = 0;
    }
  ],
  [
    "cursor missing",
    (value) => {
      value.page.hasMore = true;
    }
  ],
  [
    "bad digest",
    (value) => {
      terminalAttestation(value).attestationDigest = "x";
    }
  ],
  [
    "bad domain",
    (value) => {
      terminalAttestation(value).domain = "invented";
    }
  ]
];

function target(signal = new AbortController().signal) {
  return {
    ownerId: OWNER_ID,
    generationId: GENERATION_ID,
    revisionToken: "4",
    cursor: null,
    limit: 50,
    ciphertextByteBudget: 8_388_608,
    signal
  } as const;
}

describe("generation verification database contract", () => {
  it("parses canonical int64 revision tokens", () => {
    expect(parseRevisionToken("0")).toBe("0");
    expect(parseRevisionToken("9223372036854775807")).toBe("9223372036854775807");
    for (const invalid of [0, "", "01", "-1", "9223372036854775808", "1.0"]) {
      expect(() => parseRevisionToken(invalid)).toThrow("contract");
    }
  });

  it("reads one strictly shaped building-generation page through only the frozen RPC", async () => {
    const page = await buildingPage();
    const { executor, query, releaseSession } = executorFor(databasePageJson(page));
    const input = target();
    const result = await createGenerationVerificationRepository(executor).readBuildingPage(input);
    expect(result).toEqual(page);
    expect(query).toHaveBeenCalledTimes(2);
    const listQuery = query.mock.calls[1]?.[0];
    expect(listQuery?.text).toContain("public.list_building_note_rag_index");
    expect(listQuery?.values).toEqual([OWNER_ID, GENERATION_ID, "4", null, 50, 8_388_608]);
    expect(releaseSession).toHaveBeenCalledWith(input.signal);
  });

  it("submits the database attestation verbatim and parses the exact response", async () => {
    const expected = verifiedGeneration();
    const { executor, query } = executorFor(expected);
    const result = await createGenerationVerificationRepository(executor).attest({
      ownerId: OWNER_ID,
      generationId: GENERATION_ID,
      revisionToken: "4",
      verification,
      signal: new AbortController().signal
    });
    expect(result).toEqual(expected);
    const verifyQuery = query.mock.calls[1]?.[0];
    expect(verifyQuery?.text).toContain("public.verify_rag_index_generation");
    expect(verifyQuery?.values).toEqual([OWNER_ID, GENERATION_ID, "4", verification]);
  });

  it("treats the first exact attestation rejection as terminal without replay", async () => {
    let verifyCalls = 0;
    const executor: VerifierDatabaseQueryExecutor = {
      query(request) {
        if (request.text.startsWith("select session_user")) {
          return Promise.resolve({ rows: [identity] });
        }
        verifyCalls += 1;
        if (verifyCalls === 1) {
          return Promise.reject(
            Object.assign(new Error("invalid_generation_attestation"), { code: "P0001" })
          );
        }
        return Promise.resolve({ rows: [{ result: verifiedGeneration() }] });
      }
    };
    await expect(
      createGenerationVerificationRepository(executor).attest({
        ownerId: OWNER_ID,
        generationId: GENERATION_ID,
        revisionToken: "4",
        verification,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "generation_invalid", status: 409 });
    expect(verifyCalls).toBe(1);
  });

  it("fails closed when both exact attestation attempts fail and redaction stays upstream", async () => {
    const executor: VerifierDatabaseQueryExecutor = {
      query(request) {
        return request.text.startsWith("select session_user")
          ? Promise.resolve({ rows: [identity] })
          : Promise.reject(new Error("database-secret-canary"));
      }
    };
    await expect(
      createGenerationVerificationRepository(executor).attest({
        ownerId: OWNER_ID,
        generationId: GENERATION_ID,
        revisionToken: "4",
        verification,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("database-secret-canary");
  });

  it("maps only an exact invalid-attestation failure after replay to generation-invalid", async () => {
    const input = {
      ownerId: OWNER_ID,
      generationId: GENERATION_ID,
      revisionToken: "4",
      verification,
      signal: new AbortController().signal
    } as const;
    const deterministic: VerifierDatabaseQueryExecutor = {
      query(request) {
        if (request.text.startsWith("select session_user")) {
          return Promise.resolve({ rows: [identity] });
        }
        return Promise.reject(
          Object.assign(new Error("invalid_generation_attestation"), { code: "P0001" })
        );
      }
    };
    await expect(
      createGenerationVerificationRepository(deterministic).attest(input)
    ).rejects.toMatchObject({ code: "generation_invalid", status: 409 });

    let firstExactCalls = 0;
    const exactThenTransient: VerifierDatabaseQueryExecutor = {
      query(request) {
        if (request.text.startsWith("select session_user")) {
          return Promise.resolve({ rows: [identity] });
        }
        firstExactCalls += 1;
        return Promise.reject(
          firstExactCalls === 1
            ? Object.assign(new Error("invalid_generation_attestation"), { code: "P0001" })
            : Object.assign(new Error("connection-reset"), { code: "08006" })
        );
      }
    };
    await expect(
      createGenerationVerificationRepository(exactThenTransient).attest(input)
    ).rejects.toMatchObject({ code: "generation_invalid", status: 409 });

    for (const replayError of [
      Object.assign(new Error("invalid_generation_attestation"), { code: "P0002" }),
      Object.assign(new Error("generation_not_complete"), { code: "P0001" }),
      Object.assign(new Error("invalid_generation_attestation "), { code: "P0001" })
    ]) {
      let verifyCalls = 0;
      const nearMiss: VerifierDatabaseQueryExecutor = {
        query(request) {
          if (request.text.startsWith("select session_user")) {
            return Promise.resolve({ rows: [identity] });
          }
          verifyCalls += 1;
          return Promise.reject(
            verifyCalls === 1 ? new Error("ambiguous-first-attempt") : replayError
          );
        }
      };
      await expect(createGenerationVerificationRepository(nearMiss).attest(input)).rejects.toThrow(
        "ambiguous-first-attempt"
      );
    }
  });

  it.each(pageMutations)("rejects %s in a building page", async (_label, mutate) => {
    const value = mutablePage(databasePageJson(await buildingPage()));
    mutate(value);
    const { executor } = executorFor(value);
    await expect(
      createGenerationVerificationRepository(executor).readBuildingPage(target())
    ).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("classifies malformed wrapped key material as deterministic generation corruption", async () => {
    const value = mutablePage(databasePageJson(await buildingPage()));
    const key = value.keys[0];
    if (key === undefined) throw new Error("expected key fixture");
    key.encryptedKeyMaterial = "not+canonical";
    const { executor } = executorFor(value);
    await expect(
      createGenerationVerificationRepository(executor).readBuildingPage(target())
    ).rejects.toMatchObject({ code: "generation_invalid", status: 409 });
  });

  it("rejects noncanonical envelope tail bits before decrypt", async () => {
    const value = mutablePage(databasePageJson(await buildingPage()));
    const item = first(value.items);
    item.cipher.envelope.payload.ciphertext = `${"A".repeat(21)}B`;
    item.encryptedByteLength = 16;
    const { executor } = executorFor(value);
    await expect(
      createGenerationVerificationRepository(executor).readBuildingPage(target())
    ).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("accepts an exact cursor and rejects cursor/input drift", async () => {
    const page = await buildingPage();
    const value = mutablePage(databasePageJson(page));
    value.items = [];
    value.keys = [];
    value.page.returnedCount = 0;
    value.page.ciphertextBytes = 0;
    const cursor = {
      generationId: GENERATION_ID,
      revisionToken: "4",
      afterIndexId: page.items[0]?.indexId ?? ""
    };
    const { executor } = executorFor(value);
    await expect(
      createGenerationVerificationRepository(executor).readBuildingPage({
        ...target(),
        cursor
      })
    ).resolves.toMatchObject({ items: [] });

    await expect(
      createGenerationVerificationRepository(executor).readBuildingPage({
        ...target(),
        cursor: { ...cursor, revisionToken: "3" }
      })
    ).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("requires null verification before the terminal page and one exact terminal attestation", async () => {
    const page = await buildingPage();
    const nonterminal = mutablePage(databasePageJson(page));
    nonterminal.page.hasMore = true;
    nonterminal.page.nextCursor = {
      generationId: GENERATION_ID,
      revisionToken: "4",
      afterIndexId: first(page.items).indexId
    };
    nonterminal.verification = null;
    const accepted = executorFor(nonterminal);
    await expect(
      createGenerationVerificationRepository(accepted.executor).readBuildingPage(target())
    ).resolves.toMatchObject({ verification: null });

    const leakedEarly = mutablePage(databasePageJson(page));
    leakedEarly.page.hasMore = true;
    leakedEarly.page.nextCursor = nonterminal.page.nextCursor;
    await expect(
      createGenerationVerificationRepository(executorFor(leakedEarly).executor).readBuildingPage(
        target()
      )
    ).rejects.toMatchObject({ code: "contract_violation" });

    const missingTerminal = mutablePage(databasePageJson(page));
    missingTerminal.verification = null;
    await expect(
      createGenerationVerificationRepository(
        executorFor(missingTerminal).executor
      ).readBuildingPage(target())
    ).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("denies wrong session/current roles, malformed results, and aborted calls", async () => {
    for (const rows of [
      [],
      [{ sessionUser: "postgres", currentUser: "postgres" }],
      [{ sessionUser: "unfiled_rag_verifier", currentUser: "postgres" }],
      [{ ...identity, extra: true }]
    ]) {
      const repository = createGenerationVerificationRepository({
        query: () => Promise.resolve({ rows })
      });
      await expect(repository.preflight(new AbortController().signal)).rejects.toThrow();
    }

    const malformed = createGenerationVerificationRepository({
      query: (request) =>
        request.text.startsWith("select session_user")
          ? Promise.resolve({ rows: [identity] })
          : Promise.resolve({ rows: [] })
    });
    await expect(malformed.readBuildingPage(target())).rejects.toThrow("contract");

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(malformed.readBuildingPage(target(controller.signal))).rejects.toThrow(
      "cancelled"
    );

    const firstRepository = createGenerationVerificationRepository(
      executorFor(databasePageJson(await buildingPage())).executor
    );
    const foreignProof = await firstRepository.preflight(new AbortController().signal);
    const second = executorFor(databasePageJson(await buildingPage()));
    await expect(
      createGenerationVerificationRepository(second.executor).readBuildingPage(
        target(),
        foreignProof
      )
    ).rejects.toMatchObject({ code: "contract_violation" });
    expect(second.query).not.toHaveBeenCalled();
    firstRepository.release(foreignProof);
  });

  it("rejects mismatched verification responses and attestation shapes", async () => {
    for (const change of [
      { generationId: "igen_01J6M9Q7G4BMKB33GSG3NJ6D1Y" },
      { revisionToken: "5" },
      { attestationDigest: "b".repeat(64) },
      { verified: false },
      { attestationDomain: "invented" },
      { extra: true }
    ]) {
      const { executor } = executorFor({ ...verifiedGeneration(), ...change });
      await expect(
        createGenerationVerificationRepository(executor).attest({
          ownerId: OWNER_ID,
          generationId: GENERATION_ID,
          revisionToken: "4",
          verification,
          signal: new AbortController().signal
        })
      ).rejects.toMatchObject({ code: "contract_violation" });
    }
    const { executor } = executorFor(verifiedGeneration());
    await expect(
      createGenerationVerificationRepository(executor).attest({
        ownerId: OWNER_ID,
        generationId: GENERATION_ID,
        revisionToken: "4",
        verification: { ...verification, attestationDigest: ATTESTATION_DIGEST.toUpperCase() },
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "contract_violation" });
  });
});
