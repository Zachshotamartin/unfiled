import { describe, expect, it, vi } from "vitest";

import type { AwsKmsTransport } from "@unfiled/key-management";

import type { OrganizerConfig } from "../src/config.js";
import { OrganizerUnavailableError } from "../src/errors.js";
import { authorizeLocalOrganizerInvocation } from "../src/invocation-auth.js";
import {
  createAbortBoundOrganizerKmsTransport,
  createOrganizerKeyManagementAdapter,
  custodianForOrganizerAuthority,
  isOrganizerKeyAuthority,
  oidcTokenFromRequest,
  unconfiguredKeyManagementAdapter,
  type OrganizerKeyAuthority
} from "../src/key-management.js";

function transport(overrides: Partial<AwsKmsTransport> = {}): AwsKmsTransport {
  return {
    decryptDataKey: vi.fn().mockResolvedValue({ KeyId: "root", Plaintext: new Uint8Array(32) }),
    destroy: vi.fn(),
    generateDataKey: vi.fn().mockResolvedValue({
      KeyId: "root",
      Plaintext: new Uint8Array(32),
      CiphertextBlob: new Uint8Array([1])
    }),
    reEncryptDataKey: vi.fn().mockResolvedValue({
      KeyId: "root",
      SourceKeyId: "old",
      CiphertextBlob: new Uint8Array([1])
    }),
    ...overrides
  };
}

describe("abort-bound organizer KMS custody", () => {
  it("destroys promptly and zeroes late plaintext and ciphertext settlement", async () => {
    let resolve!: (value: {
      KeyId: string;
      Plaintext: Uint8Array;
      CiphertextBlob: Uint8Array;
    }) => void;
    const pending = new Promise<{
      KeyId: string;
      Plaintext: Uint8Array;
      CiphertextBlob: Uint8Array;
    }>((done) => {
      resolve = done;
    });
    const underlying = transport({ generateDataKey: vi.fn().mockReturnValue(pending) });
    const controller = new AbortController();
    const bounded = createAbortBoundOrganizerKmsTransport(underlying, controller.signal);
    const operation = bounded.generateDataKey({
      EncryptionContext: {},
      KeyId: "root",
      KeySpec: "AES_256"
    });
    await Promise.resolve();
    controller.abort();
    await expect(operation).rejects.toBeInstanceOf(OrganizerUnavailableError);
    expect(underlying.destroy).toHaveBeenCalledOnce();
    const plaintext = new Uint8Array(32).fill(7);
    const ciphertext = new Uint8Array([8, 9]);
    resolve({ KeyId: "root", Plaintext: plaintext, CiphertextBlob: ciphertext });
    await new Promise((done) => setTimeout(done, 0));
    expect([...plaintext]).toEqual(new Array(32).fill(0));
    expect([...ciphertext]).toEqual([0, 0]);
  });

  it("closes the subscribe/check registration window before starting KMS", async () => {
    let checks = 0;
    const fakeSignal = {
      get aborted() {
        checks += 1;
        return checks >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as AbortSignal;
    const underlying = transport();
    const bounded = createAbortBoundOrganizerKmsTransport(underlying, fakeSignal);
    await expect(
      bounded.generateDataKey({ EncryptionContext: {}, KeyId: "root", KeySpec: "AES_256" })
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    expect(underlying.generateDataKey).not.toHaveBeenCalled();
    expect(underlying.destroy).toHaveBeenCalledOnce();
  });

  it("forwards successful operations and makes destroy idempotent", async () => {
    const underlying = transport();
    const bounded = createAbortBoundOrganizerKmsTransport(underlying, new AbortController().signal);
    await expect(
      bounded.decryptDataKey({
        CiphertextBlob: new Uint8Array([1]),
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: {},
        KeyId: "root"
      })
    ).resolves.toMatchObject({ KeyId: "root" });
    await expect(
      bounded.reEncryptDataKey({
        CiphertextBlob: new Uint8Array([1]),
        DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        DestinationEncryptionContext: {},
        DestinationKeyId: "root",
        SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        SourceEncryptionContext: {},
        SourceKeyId: "old"
      })
    ).resolves.toMatchObject({ SourceKeyId: "old" });
    bounded.destroy();
    bounded.destroy();
    expect(underlying.destroy).toHaveBeenCalledOnce();
  });
});

describe("organizer key authority", () => {
  it("issues a request-bound local authority and revokes it after use", async () => {
    const invocation = authorizeLocalOrganizerInvocation({
      authorizationHeader: `Bearer ${"s".repeat(32)}`,
      requestId: "request-1",
      runtime: "local",
      secret: "s".repeat(32)
    });
    const adapter = createOrganizerKeyManagementAdapter();
    let issued: OrganizerKeyAuthority | undefined;
    await expect(
      adapter.withAiAssistedAuthority(
        { kind: "local-synthetic", keyClass: "ai_assisted" },
        { invocation, oidcToken: undefined, requestId: "request-1", runtime: "local" },
        new AbortController().signal,
        (authority) => {
          issued = authority;
          expect(
            isOrganizerKeyAuthority(authority, { requestId: "request-1", runtime: "local" })
          ).toBe(true);
          expect(() => custodianForOrganizerAuthority(authority)).toThrow("not ready");
          return Promise.resolve("ok");
        }
      )
    ).resolves.toBe("ok");
    expect(isOrganizerKeyAuthority(issued, { requestId: "request-1", runtime: "local" })).toBe(
      false
    );
  });

  it("rejects forged, cross-runtime, aborted, and unconfigured authority requests", async () => {
    const adapter = createOrganizerKeyManagementAdapter();
    const forged = {} as never;
    await expect(
      adapter.withAiAssistedAuthority(
        { kind: "local-synthetic", keyClass: "ai_assisted" },
        { invocation: forged, oidcToken: undefined, requestId: "r", runtime: "local" },
        new AbortController().signal,
        () => Promise.resolve()
      )
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    const invocation = authorizeLocalOrganizerInvocation({
      authorizationHeader: `Bearer ${"s".repeat(32)}`,
      requestId: "r",
      runtime: "local",
      secret: "s".repeat(32)
    });
    await expect(
      adapter.withAiAssistedAuthority(
        { kind: "local-synthetic", keyClass: "ai_assisted" },
        { invocation, oidcToken: "a.b.c", requestId: "r", runtime: "local" },
        new AbortController().signal,
        () => Promise.resolve()
      )
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
    await expect(
      unconfiguredKeyManagementAdapter.withAiAssistedAuthority(
        {} as never,
        {} as never,
        new AbortController().signal,
        () => Promise.resolve()
      )
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
  });

  it("accepts OIDC header syntax only for the AWS boundary", () => {
    const aws = { kind: "aws-oidc" } as OrganizerConfig["keyBoundary"];
    expect(
      oidcTokenFromRequest(
        new Request("https://example.test", { headers: { "x-vercel-oidc-token": "a.b.c" } }),
        aws
      )
    ).toBe("a.b.c");
    expect(
      oidcTokenFromRequest(new Request("https://example.test"), {
        kind: "local-synthetic",
        keyClass: "ai_assisted"
      })
    ).toBeUndefined();
    expect(() => oidcTokenFromRequest(new Request("https://example.test"), aws)).toThrow(
      "not ready"
    );
    expect(() =>
      oidcTokenFromRequest(
        new Request("https://example.test", { headers: { "x-vercel-oidc-token": "bad" } }),
        aws
      )
    ).toThrow("not ready");
  });
});
