import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  ReEncryptCommand,
  type KMSClientConfig
} from "@aws-sdk/client-kms";

import { KeyManagementErrorCode, keyManagementFailure, type KeyWorkload } from "./types.js";
import { assertAwsRegion, assertAwsRoleArn, assertWorkload } from "./validation.js";

export type KmsEncryptionContext = Readonly<Record<string, string>>;

export type GenerateDataKeyRequest = Readonly<{
  EncryptionContext: KmsEncryptionContext;
  KeyId: string;
  KeySpec: "AES_256";
}>;

export type GenerateDataKeyResponse = Readonly<{
  CiphertextBlob?: Uint8Array;
  KeyId?: string;
  Plaintext?: Uint8Array;
}>;

export type DecryptDataKeyRequest = Readonly<{
  CiphertextBlob: Uint8Array;
  EncryptionAlgorithm: "SYMMETRIC_DEFAULT";
  EncryptionContext: KmsEncryptionContext;
  KeyId: string;
}>;

export type DecryptDataKeyResponse = Readonly<{
  KeyId?: string;
  Plaintext?: Uint8Array;
}>;

export type ReEncryptDataKeyRequest = Readonly<{
  CiphertextBlob: Uint8Array;
  DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT";
  DestinationEncryptionContext: KmsEncryptionContext;
  DestinationKeyId: string;
  SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT";
  SourceEncryptionContext: KmsEncryptionContext;
  SourceKeyId: string;
}>;

export type ReEncryptDataKeyResponse = Readonly<{
  CiphertextBlob?: Uint8Array;
  KeyId?: string;
  SourceKeyId?: string;
}>;

export type KmsTransportOperationOptions = Readonly<{
  abortSignal?: AbortSignal;
}>;

export type AwsKmsTransport = Readonly<{
  decryptDataKey(
    input: DecryptDataKeyRequest,
    options?: KmsTransportOperationOptions
  ): Promise<DecryptDataKeyResponse>;
  destroy(): void;
  generateDataKey(
    input: GenerateDataKeyRequest,
    options?: KmsTransportOperationOptions
  ): Promise<GenerateDataKeyResponse>;
  reEncryptDataKey(
    input: ReEncryptDataKeyRequest,
    options?: KmsTransportOperationOptions
  ): Promise<ReEncryptDataKeyResponse>;
}>;

export type KmsClientLike = Readonly<{
  destroy?: () => void;
  send(command: unknown, options?: KmsTransportOperationOptions): Promise<unknown>;
}>;

function sendOptions(
  options: KmsTransportOperationOptions | undefined
): KmsTransportOperationOptions | undefined {
  const abortSignal = options?.abortSignal;
  return abortSignal === undefined ? undefined : { abortSignal };
}

function send<Result>(
  client: KmsClientLike,
  command: unknown,
  options: KmsTransportOperationOptions | undefined
): Promise<Result> {
  const resolvedOptions = sendOptions(options);
  return (
    resolvedOptions === undefined ? client.send(command) : client.send(command, resolvedOptions)
  ) as Promise<Result>;
}

export function createAwsSdkKmsTransport(clientValue: KMSClient | KmsClientLike): AwsKmsTransport {
  const client = clientValue as KmsClientLike;
  return Object.freeze({
    async decryptDataKey(
      input: DecryptDataKeyRequest,
      options?: KmsTransportOperationOptions
    ): Promise<DecryptDataKeyResponse> {
      return await send<DecryptDataKeyResponse>(client, new DecryptCommand(input), options);
    },
    destroy(): void {
      client.destroy?.();
    },
    async generateDataKey(
      input: GenerateDataKeyRequest,
      options?: KmsTransportOperationOptions
    ): Promise<GenerateDataKeyResponse> {
      return await send<GenerateDataKeyResponse>(
        client,
        new GenerateDataKeyCommand(input),
        options
      );
    },
    async reEncryptDataKey(
      input: ReEncryptDataKeyRequest,
      options?: KmsTransportOperationOptions
    ): Promise<ReEncryptDataKeyResponse> {
      return await send<ReEncryptDataKeyResponse>(client, new ReEncryptCommand(input), options);
    }
  });
}

type AwsCredentials = NonNullable<KMSClientConfig["credentials"]>;

export type VercelOidcKmsTransportOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  kmsClientFactory?: (configuration: KMSClientConfig) => KMSClient | KmsClientLike;
  maxAttempts?: number;
  oidcCredentialsProviderFactory?: (
    options: Readonly<{
      audience: "sts.amazonaws.com";
      roleArn: string;
      roleSessionName: string;
    }>
  ) => AwsCredentials;
  region: string;
  roleArn: string;
  workload: KeyWorkload;
}>;

const STATIC_AWS_CREDENTIAL_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE"
] as const;

function assertNoStaticAwsCredentials(
  environment: Readonly<Record<string, string | undefined>>
): void {
  if (
    STATIC_AWS_CREDENTIAL_VARIABLES.some((name) => {
      const value = environment[name];
      return value !== undefined && value.trim() !== "";
    })
  ) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "Static AWS credentials are not accepted"
    );
  }
}

export async function createVercelOidcKmsTransport(
  options: VercelOidcKmsTransportOptions
): Promise<AwsKmsTransport> {
  assertAwsRegion(options.region);
  assertAwsRoleArn(options.roleArn);
  assertWorkload(options.workload);
  assertNoStaticAwsCredentials(options.environment ?? process.env);
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "AWS KMS configuration is invalid"
    );
  }

  let credentials: AwsCredentials;
  try {
    const credentialOptions = Object.freeze({
      audience: "sts.amazonaws.com" as const,
      roleArn: options.roleArn,
      roleSessionName: `unfiled-${options.workload.replaceAll("_", "-")}`
    });
    if (options.oidcCredentialsProviderFactory !== undefined) {
      credentials = options.oidcCredentialsProviderFactory(credentialOptions);
    } else {
      // Keep the Vercel helper out of local and client bundles until production KMS is requested.
      const oidc = await import("@vercel/oidc-aws-credentials-provider");
      credentials = oidc.awsCredentialsProvider(credentialOptions);
    }
  } catch {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "AWS KMS credential configuration is invalid"
    );
  }

  const configuration: KMSClientConfig = {
    credentials,
    maxAttempts,
    region: options.region
  };
  const client = options.kmsClientFactory?.(configuration) ?? new KMSClient(configuration);
  return createAwsSdkKmsTransport(client);
}
