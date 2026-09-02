import { generateKeyEncryptionKey } from "@unfiled/content-crypto";
import { manualNoteFixtures } from "@unfiled/contracts";
import type { ObjectWrapReservation } from "@unfiled/encrypted-aggregate";
import type {
  InteractiveKeyCustodian,
  OwnerBoundKeyResolver,
  VercelSensitiveEnvironmentInteractiveKeyCustodian
} from "@unfiled/key-management";
import { describe, expect, it, vi } from "vitest";

import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import type { ServiceRpcClient } from "./service-rpc-client";
import type { InteractiveWebKeyRuntime } from "./web-key-runtime";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const WRAP_KEY_ID = "key_owner_ai_wrap_v1";

function resolver(): OwnerBoundKeyResolver {
  return Object.freeze({
    activeContentMacKey: vi.fn(),
    activeObjectWrappingKey: vi.fn(),
    contentKeyResolver: vi.fn(),
    resolveContentMacKey: vi.fn(),
    resolveObjectWrappingKey: vi.fn()
  });
}

function custodian(): InteractiveKeyCustodian {
  return Object.freeze({
    rewrapIntermediateKey: vi.fn(),
    withGeneratedIntermediateKey: vi.fn(),
    withUnwrappedIntermediateKey: vi.fn()
  });
}

function v2Custodian(): VercelSensitiveEnvironmentInteractiveKeyCustodian {
  return Object.freeze({
    rewrapIntermediateKey: vi.fn(),
    withGeneratedIntermediateKey: vi.fn(),
    withUnwrappedIntermediateKey: vi.fn()
  });
}

async function sealingResolver(): Promise<OwnerBoundKeyResolver> {
  const key = await generateKeyEncryptionKey(WRAP_KEY_ID);
  return Object.freeze({
    activeContentMacKey: vi.fn(),
    activeObjectWrappingKey: vi.fn(),
    contentKeyResolver: vi.fn(() => () => Promise.resolve(null)),
    resolveContentMacKey: vi.fn(() => Promise.resolve(null)),
    resolveObjectWrappingKey: vi.fn(({ ownerId, keyClass, keyId }) =>
      Promise.resolve(
        ownerId === OWNER_ID && keyClass === "ai_assisted" && keyId === WRAP_KEY_ID
          ? Object.freeze({
              key,
              reference: Object.freeze({
                ownerId: OWNER_ID,
                keyClass: "ai_assisted" as const,
                purpose: "object_wrap" as const,
                keyId: WRAP_KEY_ID,
                keyVersion: 1
              })
            })
          : null
      )
    )
  });
}

function reservation(id: string, ownerId = OWNER_ID): ObjectWrapReservation {
  return Object.freeze({
    reservationId: id,
    reference: Object.freeze({
      ownerId,
      keyClass: "ai_assisted" as const,
      purpose: "object_wrap" as const,
      keyId: WRAP_KEY_ID,
      keyVersion: 1
    })
  });
}

const noteContent = Object.freeze({
  schemaVersion: 1 as const,
  title: manualNoteFixtures.note.title,
  bodyMarkdown: manualNoteFixtures.note.bodyMarkdown,
  structuredData: manualNoteFixtures.note.structuredData
});

describe("owner encrypted aggregate runtime", () => {
  it("composes the local resolver without silently contacting managed KMS bootstrap", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const runtime: InteractiveWebKeyRuntime = Object.freeze({
      kind: "local",
      keyResolver: resolver()
    });
    const signal = new AbortController().signal;

    const result = await withOwnerEncryptedAggregateRuntime(
      runtime,
      Object.freeze({ rpc }),
      OWNER_ID,
      { signal },
      (context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(typeof context.service.sealNoteContent).toBe("function");
        return Promise.resolve("complete");
      }
    );

    expect(result).toBe("complete");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("bootstraps all managed key domains inside the production custodian scope", async () => {
    const scope = vi.fn();
    const managedCustodian = custodian();
    const runtime: InteractiveWebKeyRuntime = Object.freeze({
      kind: "aws-oidc",
      async withInteractiveCustodian<Result>(
        signal: AbortSignal,
        use: (value: InteractiveKeyCustodian) => Promise<Result>
      ): Promise<Result> {
        scope(signal);
        return use(managedCustodian);
      }
    });
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name, parameters) => {
      if (name !== "get_user_content_key_status") throw new Error(`unexpected ${name}`);
      return Promise.resolve({
        keyClass: parameters.p_key_class,
        keyPurpose: parameters.p_key_purpose,
        active: {
          keyId: `key_${String(parameters.p_key_class)}_${String(parameters.p_key_purpose)}`,
          keyVersion: 1
        },
        pending: null,
        nextVersion: 2
      });
    });
    const abort = new AbortController();

    await expect(
      withOwnerEncryptedAggregateRuntime(
        runtime,
        Object.freeze({ rpc }),
        OWNER_ID,
        { signal: abort.signal },
        ({ service }) => Promise.resolve(Object.isFrozen(service))
      )
    ).resolves.toBe(true);
    expect(scope).toHaveBeenCalledWith(abort.signal);
    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it("uses the V2 store and resolver contract for the sensitive-environment runtime", async () => {
    const scope = vi.fn();
    const managedCustodian = v2Custodian();
    const runtime: InteractiveWebKeyRuntime = Object.freeze({
      kind: "vercel-sensitive-env-v1",
      withInteractiveCustodian<Result>(
        signal: AbortSignal,
        use: (value: VercelSensitiveEnvironmentInteractiveKeyCustodian) => Promise<Result>
      ): Promise<Result> {
        scope(signal);
        return use(managedCustodian);
      }
    });
    const rpc = vi.fn<ServiceRpcClient["rpc"]>((name, parameters) => {
      if (name !== "get_user_content_key_status") throw new Error(`unexpected ${name}`);
      return Promise.resolve({
        keyClass: parameters.p_key_class,
        keyPurpose: parameters.p_key_purpose,
        active: {
          keyId: `key_${String(parameters.p_key_class)}_${String(parameters.p_key_purpose)}`,
          keyVersion: 1
        },
        pending: null,
        nextVersion: 2
      });
    });
    const abort = new AbortController();

    await expect(
      withOwnerEncryptedAggregateRuntime(
        runtime,
        Object.freeze({ rpc }),
        OWNER_ID,
        { signal: abort.signal },
        () => Promise.resolve("v2")
      )
    ).resolves.toBe("v2");
    expect(scope).toHaveBeenCalledWith(abort.signal);
    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it("consumes a prepare-issued reservation plan exactly once and in order", async () => {
    const runtime: InteractiveWebKeyRuntime = Object.freeze({
      kind: "local",
      keyResolver: await sealingResolver()
    });
    const client: ServiceRpcClient = Object.freeze({ rpc: vi.fn() });

    await withOwnerEncryptedAggregateRuntime(
      runtime,
      client,
      OWNER_ID,
      { signal: new AbortController().signal },
      async ({ access, createPreparedService }) => {
        const first = reservation("11111111-1111-4111-8111-111111111111");
        const prepared = createPreparedService([first]);
        const sealed = await prepared.service.sealNoteContent(access, {
          noteId: NOTE_ID,
          currentRevision: 1,
          privacy: "ai_assisted",
          payload: noteContent
        });
        expect(sealed.reservationId).toBe(first.reservationId);
        expect(() => prepared.assertConsumed()).not.toThrow();
        expect(() => prepared.assertConsumed()).toThrow(
          expect.objectContaining({ code: "reservation_invalid" })
        );
      }
    );
  });

  it("fails closed for incomplete, exhausted, or owner-substituted prepared plans", async () => {
    const runtime: InteractiveWebKeyRuntime = Object.freeze({
      kind: "local",
      keyResolver: await sealingResolver()
    });
    const client: ServiceRpcClient = Object.freeze({ rpc: vi.fn() });

    await withOwnerEncryptedAggregateRuntime(
      runtime,
      client,
      OWNER_ID,
      { signal: new AbortController().signal },
      async ({ access, createPreparedService }) => {
        const incomplete = createPreparedService([
          reservation("11111111-1111-4111-8111-111111111111"),
          reservation("22222222-2222-4222-8222-222222222222")
        ]);
        await incomplete.service.sealNoteContent(access, {
          noteId: NOTE_ID,
          currentRevision: 1,
          privacy: "ai_assisted",
          payload: noteContent
        });
        expect(() => incomplete.assertConsumed()).toThrow(
          expect.objectContaining({ code: "reservation_invalid" })
        );

        const exhausted = createPreparedService([
          reservation("33333333-3333-4333-8333-333333333333")
        ]);
        await exhausted.service.sealNoteContent(access, {
          noteId: NOTE_ID,
          currentRevision: 1,
          privacy: "ai_assisted",
          payload: noteContent
        });
        await expect(
          exhausted.service.sealNoteContent(access, {
            noteId: NOTE_ID,
            currentRevision: 2,
            privacy: "ai_assisted",
            payload: noteContent
          })
        ).rejects.toMatchObject({ code: "reservation_invalid" });

        const substituted = createPreparedService([
          reservation(
            "44444444-4444-4444-8444-444444444444",
            "22222222-2222-4222-8222-222222222222"
          )
        ]);
        await expect(
          substituted.service.sealNoteContent(access, {
            noteId: NOTE_ID,
            currentRevision: 1,
            privacy: "ai_assisted",
            payload: noteContent
          })
        ).rejects.toMatchObject({ code: "reservation_invalid" });
      }
    );
  });

  it("rejects an aborted local scope and an invalid owner before use", async () => {
    const use = vi.fn();
    const abort = new AbortController();
    abort.abort();
    const local: InteractiveWebKeyRuntime = Object.freeze({
      kind: "local",
      keyResolver: resolver()
    });
    const client: ServiceRpcClient = Object.freeze({ rpc: vi.fn() });

    await expect(
      withOwnerEncryptedAggregateRuntime(local, client, OWNER_ID, { signal: abort.signal }, use)
    ).rejects.toMatchObject({ name: "ServiceRpcError" });
    expect(use).not.toHaveBeenCalled();

    await expect(
      withOwnerEncryptedAggregateRuntime(
        local,
        client,
        "not-an-owner",
        { signal: new AbortController().signal },
        use
      )
    ).rejects.toMatchObject({ name: "EncryptedAggregateError" });
    expect(use).not.toHaveBeenCalled();
  });

  it("exports the complete, duplicate-free runtime RPC capability set", () => {
    expect(encryptedAggregateRuntimeRpcFunctions).toEqual([
      "get_active_user_content_key",
      "get_user_content_key_by_id",
      "reserve_content_key_operations",
      "activate_user_content_key",
      "get_user_content_key_status",
      "register_user_content_key",
      "register_user_content_key_v2"
    ]);
    expect(new Set(encryptedAggregateRuntimeRpcFunctions).size).toBe(
      encryptedAggregateRuntimeRpcFunctions.length
    );
  });
});
