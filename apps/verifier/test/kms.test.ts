import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KMSClientConfig } from "@aws-sdk/client-kms";

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(
    () => () =>
      Promise.resolve({
        accessKeyId: "oidc",
        secretAccessKey: "oidc",
        sessionToken: "oidc"
      })
  ),
  verify: vi.fn()
}));

vi.mock("@vercel/oidc-aws-credentials-provider", () => ({
  awsCredentialsProvider: mocks.credentials
}));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: mocks.verify }));

import type { VerifierKmsConfig, VercelTrustedSource } from "../src/config";
import { createProductionInvocationAuth } from "../src/invocation-auth";
import { createVerifierKmsAdapter, type VerifierKeySession } from "../src/kms";
import { OWNER_ID, RETIRED_ROOT_ARN, ROOT_ARN, keyRecord } from "./fixtures";

const trustedSource: VercelTrustedSource = {
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_web123",
  projectName: "unfiled-web",
  teamSlug: "team-example"
};

const kmsConfig: VerifierKmsConfig = {
  activeObjectWrapRootArn: ROOT_ARN,
  expectedOidcSubject: "owner:team-example:project:unfiled-verifier:environment:production",
  maxKeyRecords: 4,
  oidcAudience: "sts.amazonaws.com",
  region: "us-west-2",
  retiredObjectWrapRootArns: [RETIRED_ROOT_ARN],
  roleArn: "arn:aws:iam::123456789012:role/unfiled-verifier-production",
  timeoutMs: 2_000,
  vercelProjectId: "prj_verifier123"
};

async function invocation() {
  const now = Math.floor(Date.now() / 1_000);
  mocks.verify.mockResolvedValue({
    payload: {
      aud: trustedSource.audience,
      environment: "production",
      exp: now + 300,
      iat: now,
      iss: trustedSource.issuer,
      nbf: now,
      owner: trustedSource.teamSlug,
      owner_id: trustedSource.ownerId,
      project: trustedSource.projectName,
      project_id: trustedSource.projectId,
      sub: trustedSource.expectedSubject
    },
    protectedHeader: { alg: "RS256" }
  });
  return createProductionInvocationAuth(trustedSource).authorize(
    {
      authorizationHeader: null,
      protectionBypassHeader: null,
      requestId: "request-1",
      trustedSourceToken: "header.payload.signature"
    },
    new AbortController().signal
  );
}

describe("decrypt-only verifier KMS session", () => {
  beforeEach(() => {
    mocks.credentials.mockClear();
    mocks.verify.mockReset();
  });

  it("uses one Decrypt command per exact key and caches the non-extractable imported key", async () => {
    const plaintext = new Uint8Array(32).fill(9);
    const observed: Record<string, unknown>[] = [];
    const send = vi.fn(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        observed.push({
          command: command.constructor.name,
          context: command.input.EncryptionContext,
          keyId: command.input.KeyId
        });
        return Promise.resolve({ KeyId: ROOT_ARN, Plaintext: plaintext });
      }
    );
    const destroy = vi.fn();
    let clientConfig: KMSClientConfig | undefined;
    let retained: VerifierKeySession | undefined;
    const adapter = createVerifierKmsAdapter((config) => {
      clientConfig = config;
      return { send, destroy };
    });
    const signal = new AbortController().signal;

    const result = await adapter.withKeySession(
      kmsConfig,
      { invocation: await invocation(), requestId: "request-1", runtime: "production" },
      signal,
      async (session) => {
        retained = session;
        const first = await session.keyFor(keyRecord(), signal);
        const second = await session.keyFor(keyRecord(), signal);
        expect(second).toBe(first);
        expect(first.keyId).toBe("key-ai-object-wrap-1");
        expect(first.key.extractable).toBe(false);
        expect(first.key.usages).toEqual(["encrypt", "decrypt"]);
        return "verified";
      }
    );

    expect(result).toBe("verified");
    expect(send).toHaveBeenCalledOnce();
    expect(observed).toEqual([
      {
        command: "DecryptCommand",
        context: {
          UnfiledOwnerId: OWNER_ID,
          UnfiledKeyClass: "ai_assisted",
          UnfiledKeyPurpose: "object_wrap",
          UnfiledKeyRecordId: "key-ai-object-wrap-1"
        },
        keyId: ROOT_ARN
      }
    ]);
    expect(plaintext.every((value) => value === 0)).toBe(true);
    expect(clientConfig).toMatchObject({ maxAttempts: 3, region: "us-west-2" });
    expect(mocks.credentials).toHaveBeenCalledWith({
      audience: "sts.amazonaws.com",
      roleArn: kmsConfig.roleArn,
      roleSessionName: "unfiled-rag-verifier"
    });
    expect(destroy).toHaveBeenCalledOnce();
    if (retained === undefined) throw new Error("expected retained session");
    await expect(retained.keyFor(keyRecord(), signal)).rejects.toMatchObject({
      code: "provider_unavailable"
    });
  });

  it("accepts only active or retired AI object-wrap records under configured roots", async () => {
    const send = vi.fn().mockResolvedValue({
      KeyId: RETIRED_ROOT_ARN,
      Plaintext: new Uint8Array(32)
    });
    const adapter = createVerifierKmsAdapter(() => ({ send, destroy: vi.fn() }));
    const signal = new AbortController().signal;
    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) =>
          session.keyFor(
            keyRecord({
              status: "retired",
              rootKeyArn: RETIRED_ROOT_ARN,
              retiredAt: "2026-08-30T12:02:00.000Z"
            }),
            signal
          )
      )
    ).resolves.toMatchObject({ keyId: "key-ai-object-wrap-1" });

    for (const record of [
      keyRecord({ keyClass: "private_manual" }),
      keyRecord({ purpose: "content_mac" }),
      keyRecord({ status: "revoked", revokedAt: "2026-08-30T12:02:00.000Z" }),
      keyRecord({
        rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/99999999-9999-4999-8999-999999999999"
      })
    ]) {
      await expect(
        adapter.withKeySession(
          kmsConfig,
          { invocation: await invocation(), requestId: "request-1", runtime: "production" },
          signal,
          (session) => session.keyFor(record, signal)
        )
      ).rejects.toMatchObject({ code: "provider_unavailable" });
    }
  });

  it("reuses one logical key across benign counter and lifecycle metadata drift", async () => {
    const send = vi.fn(() => Promise.resolve({ KeyId: ROOT_ARN, Plaintext: new Uint8Array(32) }));
    const adapter = createVerifierKmsAdapter(() => ({
      send,
      destroy: vi.fn()
    }));
    const signal = new AbortController().signal;
    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        async (session) => {
          const firstPage = await session.keyFor(keyRecord(), signal);
          const laterCounterPage = await session.keyFor(keyRecord({ wrapOperations: 2 }), signal);
          const laterLifecyclePage = await session.keyFor(
            keyRecord({
              retiredAt: "2026-08-30T12:03:00.000Z",
              rotation: {
                lastRootRewrappedAt: "2026-08-30T12:02:00.000Z",
                predecessorKeyId: null,
                previousRootKeyArn: ROOT_ARN,
                rootRewrapCount: 1
              },
              status: "retired",
              wrapOperations: 3
            }),
            signal
          );
          expect(laterCounterPage).toBe(firstPage);
          expect(laterLifecyclePage).toBe(firstPage);
        }
      )
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it("classifies same-identity root rewrap or wrapped-material drift as retryable", async () => {
    const send = vi.fn(() => Promise.resolve({ KeyId: ROOT_ARN, Plaintext: new Uint8Array(32) }));
    const adapter = createVerifierKmsAdapter(() => ({ send, destroy: vi.fn() }));
    const signal = new AbortController().signal;

    for (const changedRecord of [
      keyRecord({ rootKeyArn: RETIRED_ROOT_ARN }),
      keyRecord({ encryptedKeyMaterial: Buffer.alloc(48, 8).toString("base64url") })
    ]) {
      await expect(
        adapter.withKeySession(
          kmsConfig,
          { invocation: await invocation(), requestId: "request-1", runtime: "production" },
          signal,
          async (session) => {
            await session.keyFor(keyRecord(), signal);
            await session.keyFor(changedRecord, signal);
          }
        )
      ).rejects.toMatchObject({ code: "provider_unavailable", retryable: true, status: 503 });
    }
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("unwraps a valid rewrapped key in a fresh session", async () => {
    const send = vi.fn((command: { input: Readonly<{ KeyId?: string }> }) =>
      Promise.resolve({ KeyId: command.input.KeyId, Plaintext: new Uint8Array(32) })
    );
    const adapter = createVerifierKmsAdapter(() => ({ send, destroy: vi.fn() }));
    const signal = new AbortController().signal;
    const rewrappedRecord = keyRecord({
      encryptedKeyMaterial: Buffer.alloc(48, 8).toString("base64url"),
      rootKeyArn: RETIRED_ROOT_ARN,
      rotation: {
        lastRootRewrappedAt: "2026-08-30T12:02:00.000Z",
        predecessorKeyId: null,
        previousRootKeyArn: ROOT_ARN,
        rootRewrapCount: 1
      }
    });

    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(keyRecord(), signal)
      )
    ).resolves.toMatchObject({ keyId: "key-ai-object-wrap-1" });
    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(rewrappedRecord, signal)
      )
    ).resolves.toMatchObject({ keyId: "key-ai-object-wrap-1" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects a fifth logical key identity", async () => {
    const send = vi.fn(() => Promise.resolve({ KeyId: ROOT_ARN, Plaintext: new Uint8Array(32) }));
    const adapter = createVerifierKmsAdapter(() => ({
      send,
      destroy: vi.fn()
    }));
    const signal = new AbortController().signal;

    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        async (session) => {
          for (let index = 0; index < 5; index += 1) {
            await session.keyFor(
              keyRecord({ keyId: `key-${String(index).padStart(2, "0")}` }),
              signal
            );
          }
        }
      )
    ).rejects.toMatchObject({ code: "generation_invalid" });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["short plaintext", { KeyId: ROOT_ARN, Plaintext: new Uint8Array(31) }],
    ["wrong response key", { KeyId: RETIRED_ROOT_ARN, Plaintext: new Uint8Array(32) }],
    ["missing plaintext", { KeyId: ROOT_ARN }]
  ])("fails closed on %s", async (_label, response) => {
    const adapter = createVerifierKmsAdapter(() => ({
      send: () => Promise.resolve(response),
      destroy: vi.fn()
    }));
    const signal = new AbortController().signal;
    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(keyRecord(), signal)
      )
    ).rejects.toMatchObject({ code: "generation_invalid" });
  });

  it("classifies malformed wrapped key material as deterministic generation corruption", async () => {
    const send = vi.fn();
    const adapter = createVerifierKmsAdapter(() => ({ send, destroy: vi.fn() }));
    const signal = new AbortController().signal;
    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(keyRecord({ encryptedKeyMaterial: "not+canonical" }), signal)
      )
    ).rejects.toMatchObject({ code: "generation_invalid", status: 409 });
    expect(send).not.toHaveBeenCalled();
  });

  it("classifies only AWS invalid ciphertext as deterministic generation failure", async () => {
    const invalidCiphertext = createVerifierKmsAdapter(() => ({
      send: () =>
        Promise.reject(
          Object.assign(new Error("ciphertext-canary"), { name: "InvalidCiphertextException" })
        ),
      destroy: vi.fn()
    }));
    const unavailable = createVerifierKmsAdapter(() => ({
      send: () =>
        Promise.reject(Object.assign(new Error("auth-canary"), { name: "AccessDeniedException" })),
      destroy: vi.fn()
    }));
    const signal = new AbortController().signal;
    await expect(
      invalidCiphertext.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(keyRecord(), signal)
      )
    ).rejects.toMatchObject({ code: "generation_invalid", status: 409 });
    await expect(
      unavailable.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(keyRecord(), signal)
      )
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });

  it("redacts provider failures and rejects forged or aborted authority", async () => {
    const destroy = vi.fn();
    const adapter = createVerifierKmsAdapter(() => ({
      send: () => Promise.reject(new Error("kms-key-secret-canary")),
      destroy
    }));
    const signal = new AbortController().signal;
    let captured: unknown;
    try {
      await adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(keyRecord(), signal)
      );
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "provider_unavailable" });
    expect(String(captured)).not.toContain("canary");
    expect(destroy).toHaveBeenCalledOnce();

    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: {} as never, requestId: "request-1", runtime: "production" },
        signal,
        () => Promise.resolve()
      )
    ).rejects.toMatchObject({ code: "provider_unavailable" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        controller.signal,
        () => Promise.resolve()
      )
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("aborts an in-flight Decrypt before destroying the client", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const adapter = createVerifierKmsAdapter(() => ({
      send(_command, options) {
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => {
              order.push("aborted");
              reject(new Error("aborted"));
            },
            { once: true }
          );
        });
      },
      destroy() {
        order.push("destroyed");
      }
    }));
    const pending = adapter.withKeySession(
      kmsConfig,
      { invocation: await invocation(), requestId: "request-1", runtime: "production" },
      controller.signal,
      (session) => session.keyFor(keyRecord(), controller.signal)
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(order).toEqual(["aborted", "destroyed"]);
  });

  it("bounds credential-resolution hangs and wipes a late KMS plaintext", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      let resolveLate: ((value: unknown) => void) | undefined;
      const send = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            resolveLate = resolve;
          })
      );
      const destroy = vi.fn();
      const adapter = createVerifierKmsAdapter(() => ({ send, destroy }));
      const signal = new AbortController().signal;
      const pending = adapter.withKeySession(
        kmsConfig,
        { invocation: await invocation(), requestId: "request-1", runtime: "production" },
        signal,
        (session) => session.keyFor(keyRecord(), signal)
      );
      const rejection = expect(pending).rejects.toMatchObject({
        code: "provider_unavailable",
        status: 503
      });

      await vi.advanceTimersByTimeAsync(kmsConfig.timeoutMs - 1);
      expect(destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(timeout).toHaveBeenCalledWith(kmsConfig.timeoutMs);
      expect(send).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();

      const latePlaintext = new Uint8Array(32).fill(0x7a);
      resolveLate?.({ KeyId: ROOT_ARN, Plaintext: latePlaintext });
      await Promise.resolve();
      await Promise.resolve();
      expect(latePlaintext.every((value) => value === 0)).toBe(true);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
