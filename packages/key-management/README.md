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
