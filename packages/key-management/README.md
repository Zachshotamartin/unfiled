# @unfiled/key-management

Owner-bound intermediate-key custody for Unfiled's application-encrypted content. This package is a server-side security boundary; it does not make Unfiled end-to-end encrypted.

## Production boundary

- `interactive_api` requires four distinct AWS KMS key ARNs: `ai_assisted` and `private_manual`, each split into `object_wrap` and `content_mac`.
- `organization_worker` accepts only the two `ai_assisted` ARNs. Its configuration fails if private root identifiers are present.
- The worker overload returns an `IntermediateKeyCustodian` with only generate/unwrap operations; its frozen runtime object has no rewrap method. Only the interactive overload returns `InteractiveKeyCustodian`, which carries the rotation-admin method.
- KMS encryption context contains exactly `UnfiledOwnerId`, `UnfiledKeyClass`, `UnfiledKeyPurpose`, and `UnfiledKeyRecordId`.
- Vercel credentials use OIDC with the fixed `sts.amazonaws.com` audience. Static AWS credential environment variables are rejected.
- Every returned plaintext intermediate key is scoped to a callback and zeroed in `finally`; consumers should import it immediately into a non-extractable `CryptoKey`.
- KMS, parsing, and authorization failures use bounded generic errors and do not retain provider error details.
- Custody operations accept `{ signal?: AbortSignal }`; the signal is passed to AWS SDK `client.send(command, { abortSignal })` and pre-aborted calls fail closed before contacting KMS.

`createVercelOidcKmsTransport` builds the AWS SDK v3 transport. Pass that transport to `createAwsKmsEnvelopeCustodian`, then use `createManagedKeyResolver` with a service-owned `ManagedKeyStore`. Exact resolution always includes owner, class, purpose, and key ID. Retired keys remain available only for reads; exhausted active wrapping keys cannot seal new objects.

The database integration must atomically reserve/increment `wrapOperations`, activate new pending records, retire predecessors, and enforce a single active record per owner/class/purpose. This package validates those records but does not implement persistence.

Before issuing worker drain capability, call `assertAiAssistedKmsReadiness({ activeRoots, transport, signal })`. It performs a real `GenerateDataKey` plus context-bound `Decrypt` against both AI-assisted purpose roots, validates and zeroes the returned material, and resolves with no reusable proof token only after both roots pass.

## Role-separation probe

`runKeyCustodyProbe` is credential-free and accepts injected custodians/transports. Its report carries `privateDenialEvidence: "application_guard" | "direct_kms"`, and the private check names are also distinct. A software-only guard result therefore cannot be represented as direct IAM/KMS evidence. It verifies:

1. AI-assisted `GenerateDataKey` and context-bound `Decrypt` succeed.
2. The worker is denied both `GenerateDataKey` and `Decrypt` on the private-manual object-wrap root.
3. The worker is denied both operations on the private-manual content-MAC root.
4. The AI ciphertext fails under a different owner context.
5. Probe events contain exactly `{ check, status }`; no key bytes or provider details are emitted.

The ordinary worker configuration must not contain private ARNs. A human-run production probe supplies those two ARNs separately through `directPrivateKmsProbe`, using the same worker OIDC transport. Production evidence must require `privateDenialEvidence === "direct_kms"` and the two `*_kms_generate_decrypt_denied` checks; application-guard checks are not substitutes. It must also call `assertAiAssistedKmsReadiness` so both AI purpose roots—not only the role probe's object-wrap round trip—are proven usable. The production CLI only needs to parse non-secret root ARN configuration, construct the worker transport/custodian, run both APIs, and print the content-free checks.

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

Local material must be canonical base64url, exactly 32 bytes, unique across the ring, and have at most one active key per owner/class/purpose. A local organization worker refuses to load any private-manual entry.
