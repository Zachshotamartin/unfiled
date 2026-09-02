# @unfiled/key-management

Owner-bound intermediate-key custody for Unfiled's application-encrypted content. This package is a server-side security boundary; it does not make Unfiled end-to-end encrypted.

## Production boundary

- `interactive_api` requires four distinct AWS KMS key ARNs: `ai_assisted` and `private_manual`, each split into `object_wrap` and `content_mac`.
- `organization_worker` accepts only the two `ai_assisted` ARNs. Its configuration fails if private root identifiers are present.
- `index_worker` accepts exactly one active `ai_assisted/object_wrap` ARN plus optional retired object-wrap ARNs. Its runtime parser and every custody/resolver operation reject AI content-MAC and private bindings before KMS.
- The worker overload returns an `IntermediateKeyCustodian` with only generate/unwrap operations; its frozen runtime object has no rewrap method. Only the interactive overload returns `InteractiveKeyCustodian`, which carries the rotation-admin method.
- KMS encryption context contains exactly `UnfiledOwnerId`, `UnfiledKeyClass`, `UnfiledKeyPurpose`, and `UnfiledKeyRecordId`.
- Vercel credentials use OIDC with the fixed `sts.amazonaws.com` audience. Static AWS credential environment variables are rejected.
- Every returned plaintext intermediate key is scoped to a callback and zeroed in `finally`; consumers should import it immediately into a non-extractable `CryptoKey`.
- KMS, parsing, and authorization failures use bounded generic errors and do not retain provider error details.
- Custody operations accept `{ signal?: AbortSignal }`; the signal is passed to AWS SDK `client.send(command, { abortSignal })` and pre-aborted calls fail closed before contacting KMS.

`createVercelOidcKmsTransport` builds the AWS SDK v3 transport. Pass that transport to `createAwsKmsEnvelopeCustodian`, then use `createManagedKeyResolver` with a service-owned `ManagedKeyStore`. Exact resolution always includes owner, class, purpose, and key ID. Retired keys remain available only for reads; exhausted active wrapping keys cannot seal new objects.

The database integration must atomically reserve/increment `wrapOperations`, activate new pending records, retire predecessors, and enforce a single active record per owner/class/purpose. This package validates those records but does not implement persistence.

Before issuing index-worker drain capability, call `assertIndexWorkerKmsReadiness({ activeRoots, transport, signal })`. It performs a real `GenerateDataKey` plus context-bound `Decrypt` against the single active AI object-wrap root, validates and zeroes the returned material, and resolves with no reusable proof token. `assertAiAssistedKmsReadiness` remains the broader two-purpose probe for a separately isolated organizer workload; it is not accepted by `apps/worker`.

## Custodian modes

Two managed custodians share the same `AwsKmsTransport` interface, the same
encryption-context contract, and the same workload role split. A workload
selects exactly one with `UNFILED_KEY_CUSTODIAN`:

| Mode                      | Root keys live in                                   | Record schema     | Status in the free beta                            |
| ------------------------- | --------------------------------------------------- | ----------------- | -------------------------------------------------- |
| `aws-kms`                 | AWS KMS, reached through Vercel OIDC and STS        | V1 (`rootKeyArn`) | Preserved as deferred paid hardening; not required |
| `vercel-sensitive-env-v1` | A Vercel Sensitive Environment Variable (this repo) | V2 (`rootKeyId`)  | Used for the $0 beta                               |

The two record schemas never mix. `parseManagedKeyRecordV1` accepts only AWS
ARNs; `parseManagedKeyRecordV2` accepts only `schemaVersion: 2`,
`custodyProvider: "vercel_sensitive_environment_v1"`,
`wrapAlgorithm: "AES-256-GCM"`, a provider-neutral `rootKeyId` URN, and a
65-byte environment envelope. A V2 record therefore cannot masquerade as KMS
custody, and an AWS record cannot be opened by the environment custodian.

## Vercel sensitive-environment custodian (free-beta mode)

`createVercelSensitiveEnvironmentKmsTransport({ expectedRootKeyIds })` loads
AES-256 root keys from `UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1` and
returns a transport whose `generateDataKey`, `decryptDataKey`, and
`reEncryptDataKey` behave like the KMS transport. Pass it to
`createVercelSensitiveEnvironmentEnvelopeCustodian`, whose overloads mirror
the AWS ones:

- `index_worker` and `organization_worker` receive generate + unwrap;
- `search_worker` receives a frozen object with only
  `withUnwrappedIntermediateKey` (the verifier and search service use this);
- `interactive_api` additionally receives `rewrapIntermediateKey`.

`assertWorkloadCanAccess` still rejects AI content-MAC and private-manual
bindings for the index and search workloads before any root is touched.

The transport fails closed unless all of the following hold in the process
environment: `NODE_ENV=production`, `VERCEL=1`, `VERCEL_ENV` is `preview` or
`production`, `VERCEL_PROJECT_ID` matches `^prj_[A-Za-z0-9]{6,100}$`,
`UNFILED_KEY_CUSTODIAN` is exactly `vercel-sensitive-env-v1`, and none of the
following carry a value: `UNFILED_LOCAL_KEY_RING_V1`; `AWS_ACCESS_KEY_ID`,
`AWS_PROFILE`, `AWS_ROLE_ARN`, `AWS_SECRET_ACCESS_KEY`, `AWS_SECURITY_TOKEN`,
`AWS_SESSION_TOKEN`, `AWS_SHARED_CREDENTIALS_FILE`; any
`UNFILED_<WORKLOAD>_AWS_ROLE_ARN`; or any `NEXT_PUBLIC_*` name containing
`KEK`, `MASTER_KEY`, `ROOT_KEY`, `KEY_BYTES`, `KEY_MATERIAL`, or `KEY_RING`.

The ring is canonical JSON (no whitespace; `JSON.stringify(JSON.parse(raw))`
must equal the raw value), at most 32,768 bytes, with exactly these keys:

```json
{
  "deploymentEnvironment": "production",
  "projectId": "prj_...",
  "roots": [
    {
      "keyMaterial": "<43-char base64url of exactly 32 random bytes>",
      "rootKeyId": "urn:unfiled:key-root:vercel-sensitive-env-v1:production:<uuid>"
    }
  ],
  "version": 1
}
```

`deploymentEnvironment` must equal `VERCEL_ENV`, `projectId` must equal
`VERCEL_PROJECT_ID`, every `rootKeyId` must match
`^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):<RFC-4122 UUID>$`
with the same environment segment, identifiers and materials must be unique,
and the set of ring identifiers must equal the caller's `expectedRootKeyIds`
exactly (active plus retired). A ring minted for another project or
environment, or one missing a configured retired root, is rejected before any
key is imported. Roots are imported as non-extractable AES-GCM `CryptoKey`s
and released by `destroy()`.

Each wrapped intermediate key is a 65-byte envelope: the prefix `UFEK` + `0x01`,
a 12-byte random IV, the 32-byte key ciphertext, and the 16-byte GCM tag. The
additional authenticated data binds the root ID and the exact four-field
encryption context, so an envelope cannot be opened under a different root,
owner, class, purpose, or record ID.

Honest limits of this mode: the root material is an exportable environment
value present in the function process, there is no HSM, no per-call cloud
audit record, and no IAM denial between workloads. It preserves
application-layer encryption against a database-only disclosure and keeps the
workload role split enforceable in software. It is neither end-to-end
encryption nor zero knowledge; every workload that holds the AI object-wrap
root can decrypt AI-assisted content. The four independent root families (AI
object-wrap, AI content-MAC, private-manual object-wrap, private-manual
content-MAC) are distributed by the deploying operator: the interactive web
service receives all four, the organizer receives the two AI roots, and the
worker, verifier, and search service receive only the AI object-wrap root.

## Role-separation probe

`runKeyCustodyProbe` is credential-free and accepts injected custodians/transports. Its report carries separate `aiContentMacDenialEvidence` and `privateDenialEvidence` fields, and the check names distinguish application guards from direct KMS denial. A software-only guard result therefore cannot be represented as direct IAM/KMS evidence. It verifies:

1. AI-assisted `GenerateDataKey` and context-bound `Decrypt` succeed.
2. The index worker is denied both operations on the AI-assisted content-MAC root.
3. The worker is denied both operations on the private-manual object-wrap root.
4. The worker is denied both operations on the private-manual content-MAC root.
5. The AI ciphertext fails under a different owner context.
6. Probe events contain exactly `{ check, status }`; no key bytes or provider details are emitted.

The ordinary worker configuration must contain neither content-MAC nor private ARNs. A controlled human-run production probe supplies the AI content-MAC and two private ARNs only through `directPrivateKmsProbe`, using the same worker OIDC transport. Production evidence must require both denial-evidence fields to equal `"direct_kms"`, all three `*_kms_generate_decrypt_denied` checks, and a successful `assertIndexWorkerKmsReadiness`; application-guard checks are not substitutes. The probe prints only content-free checks.

## Local adapter

`createLocalEnvironmentKeyResolver` is explicitly opt-in with `UNFILED_KEY_CUSTODIAN=local`, accepts only `NODE_ENV=development|test`, and rejects every Vercel or production runtime. `UNFILED_LOCAL_KEY_RING_V1` is a bounded JSON object:

```json
{
  "version": 1,
  "keys": [
    {
      "ownerId": "00000000-0000-4000-8000-000000000000",
      "keyClass": "ai_assisted",
      "purpose": "object_wrap",
      "keyId": "local.ai.object.v1",
      "keyVersion": 1,
      "status": "active",
      "keyMaterial": "base64url-encoded-32-byte-synthetic-local-key"
    }
  ]
}
```

Local material must be canonical base64url, exactly 32 bytes, unique across the ring, and have at most one active key per owner/class/purpose. A local index worker refuses to load content-MAC or private-manual entries.
