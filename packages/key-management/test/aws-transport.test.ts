import {
  DecryptCommand,
  GenerateDataKeyCommand,
  ReEncryptCommand,
  type KMSClientConfig
} from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  createAwsSdkKmsTransport,
  createVercelOidcKmsTransport,
  type KmsClientLike
} from "../src/index";
import { OWNER_A, ROOTS } from "./fixtures";

const ROLE_ARN = "arn:aws:iam::123456789012:role/vercel/unfiled-worker";
const ENCRYPTION_CONTEXT = {
  UnfiledOwnerId: OWNER_A,
  UnfiledKeyClass: "ai_assisted",
  UnfiledKeyPurpose: "object_wrap",
  UnfiledKeyRecordId: "ai.object.v1"
};

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

describe("AWS SDK KMS transport", () => {
  it("uses AWS SDK v3 command objects and delegates destruction", async () => {
    const commands: unknown[] = [];
    const operationOptions: unknown[] = [];
    const destroy = vi.fn();
    const client: KmsClientLike = {
      destroy,
      send(command: unknown, options): Promise<unknown> {
        commands.push(command);
        operationOptions.push(options);
        return Promise.resolve({});
      }
    };
    const transport = createAwsSdkKmsTransport(client);
    const abortController = new AbortController();
    await transport.generateDataKey(
      {
        EncryptionContext: ENCRYPTION_CONTEXT,
        KeyId: ROOTS.ai_assisted.object_wrap,
        KeySpec: "AES_256"
      },
      { abortSignal: abortController.signal }
    );
    await transport.decryptDataKey(
      {
        CiphertextBlob: new Uint8Array([1]),
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: ENCRYPTION_CONTEXT,
        KeyId: ROOTS.ai_assisted.object_wrap
      },
      { abortSignal: abortController.signal }
    );
    await transport.reEncryptDataKey(
      {
        CiphertextBlob: new Uint8Array([1]),
        DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        DestinationEncryptionContext: ENCRYPTION_CONTEXT,
        DestinationKeyId: ROOTS.private_manual.object_wrap,
        SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        SourceEncryptionContext: ENCRYPTION_CONTEXT,
        SourceKeyId: ROOTS.ai_assisted.object_wrap
      },
      { abortSignal: abortController.signal }
    );
    transport.destroy();

    expect(commands[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(commands[1]).toBeInstanceOf(DecryptCommand);
    expect(commands[2]).toBeInstanceOf(ReEncryptCommand);
    expect(operationOptions).toEqual([
      { abortSignal: abortController.signal },
      { abortSignal: abortController.signal },
      { abortSignal: abortController.signal }
    ]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("constructs KMS with short-lived Vercel OIDC credentials and the STS audience", async () => {
    const credentialProvider = vi.fn(() =>
      Promise.resolve({
        accessKeyId: "synthetic-access-key",
        secretAccessKey: "synthetic-secret",
        sessionToken: "synthetic-session"
      })
    );
    const oidcFactory = vi.fn(() => credentialProvider);
    let clientConfiguration: KMSClientConfig | undefined;
    const client: KmsClientLike = { send: () => Promise.resolve({}) };
    const transport = await createVercelOidcKmsTransport({
      environment: {},
      kmsClientFactory(configuration) {
        clientConfiguration = configuration;
        return client;
      },
      oidcCredentialsProviderFactory: oidcFactory,
      region: "us-west-2",
      roleArn: ROLE_ARN,
      workload: "organization_worker"
    });

    expect(oidcFactory).toHaveBeenCalledWith({
      audience: "sts.amazonaws.com",
      roleArn: ROLE_ARN,
      roleSessionName: "unfiled-organization-worker"
    });
    expect(clientConfiguration).toMatchObject({
      credentials: credentialProvider,
      maxAttempts: 3,
      region: "us-west-2"
    });
    await expect(
      transport.generateDataKey({
        EncryptionContext: ENCRYPTION_CONTEXT,
        KeyId: ROOTS.ai_assisted.object_wrap,
        KeySpec: "AES_256"
      })
    ).resolves.toEqual({});
  });

  it("rejects static AWS credential sources and malformed production configuration", async () => {
    const base = {
      environment: {},
      kmsClientFactory: () => ({ send: () => Promise.resolve({}) }),
      oidcCredentialsProviderFactory: () => () =>
        Promise.resolve({ accessKeyId: "synthetic", secretAccessKey: "synthetic" }),
      region: "us-west-2",
      roleArn: ROLE_ARN,
      workload: "interactive_api" as const
    };
    for (const options of [
      { ...base, environment: { AWS_ACCESS_KEY_ID: "must-not-be-used" } },
      { ...base, environment: { AWS_PROFILE: "default" } },
      { ...base, region: "localhost" },
      { ...base, roleArn: "admin" },
      { ...base, maxAttempts: 0 },
      { ...base, maxAttempts: 6 }
    ]) {
      await expect(createVercelOidcKmsTransport(options)).rejects.toSatisfy(
        expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID)
      );
    }
  });

  it("does not include credential-provider failure details in errors", async () => {
    const canary = "CANARY_STATIC_AWS_SECRET";
    try {
      await createVercelOidcKmsTransport({
        environment: {},
        oidcCredentialsProviderFactory: () => {
          throw new Error(canary);
        },
        region: "us-west-2",
        roleArn: ROLE_ARN,
        workload: "interactive_api"
      });
      throw new Error("expected failure");
    } catch (error: unknown) {
      expect(error).toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });
});
