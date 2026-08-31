import type { InteractiveKeyCustodian, OwnerBoundKeyResolver } from "@unfiled/key-management";
import { describe, expect, it, vi } from "vitest";

import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import type { ServiceRpcClient } from "./service-rpc-client";
import type { InteractiveWebKeyRuntime } from "./web-key-runtime";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

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
      "register_user_content_key"
    ]);
    expect(new Set(encryptedAggregateRuntimeRpcFunctions).size).toBe(
      encryptedAggregateRuntimeRpcFunctions.length
    );
  });
});
