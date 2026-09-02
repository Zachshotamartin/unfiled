# ADR-0012: Vault-only, lease-bound BYOK provider credentials

- Status: accepted
- Date: 2026-09-01
- Amended: 2026-09-01 to record Supabase's extension-owned `service_role` Vault ACL boundary and the exact transient replay comparison
- Supersedes: ADR-0002 decision 3's app-layer ciphertext fallback; narrows ADR-0002 provider availability and credential resolution
- Depends on: ADR-0009 organizer identity and ADR-0011 owner-authorized interaction custody
- Decision drivers: keep spend-capable user credentials out of application tables and content-key machinery; preserve immediate revocation; bind disclosure to one live organizer lease; prevent settings changes from mutating queued work; expose only provider configurations that have passed their adapter and evaluation gates.

## Context

A user-supplied provider API key is a spend-capable credential, not note content. Durable organization needs server-side access after the client disconnects, but placing a decryptable credential ciphertext in an application table would make the web secret store or content-encryption keys a second credential vault. Copying a key into an organization job, an encrypted aggregate, a key-wrap envelope, or a generic organizer environment variable would widen backup, export, replay, and logging exposure.

The historical Milestone D organizer accepted one application-owned OpenAI key from its dedicated Production project and deliberately rejected user BYOK. E4 now implements Vault-only OpenAI BYOK locally without changing the production-release gate. ADR-0002 selected BYOK as a product target but allowed an app-layer AES-256-GCM fallback if Supabase Vault proved unsuitable and described OpenAI and Anthropic as a two-adapter target. That fallback no longer meets the accepted custody boundary. The Anthropic adapter and provider×tier evaluation evidence also do not yet exist.

## Decision

### 1. Supabase Vault is the only accepted BYOK store

Milestone E4 stores each user provider key only as a Supabase Vault secret. `user_provider_keys` may retain content-free owner, provider, status, last-four, validation time, and monotonic credential revision metadata, but it stores neither plaintext nor application-decryptable key ciphertext. The E4 migration removes or permanently constrains any legacy `key_ciphertext` fallback column before BYOK is enabled. Provider credentials never use `ContentEnvelopeV1`, content DEKs, per-user object-wrap/content-MAC keys, KMS root aliases, or the content backfill/rewrap pipeline.

If Vault is unavailable, unsupported by the selected Supabase plan, or cannot satisfy the grant/deletion/audit tests, BYOK remains disabled. The product uses its approved application provider path or Inbox behavior; it does not fall back to a Vercel-held credential-encryption key.

Vault custody is application encryption, not E2EE or zero knowledge. Authorized security-definer database code and the exact leased organizer path can obtain a credential in memory.

### 2. Expose only exact owner-authorized CRUD RPCs

The browser/native clients and `authenticated`, `anon`, organizer, index-worker, and verifier roles have no direct privileges on the provider-key table, Vault tables, Vault decrypted view, or Vault functions. `service_role` has no provider-key-table or private E4 evidence access. Supabase's Vault bootstrap may separately grant its built-in `service_role` database role Vault privileges as extension owner `supabase_admin`; an ordinary project migration cannot portably revoke grants made by that different owner. Therefore the web runtime receives no database password, `vault` must remain absent from every PostgREST exposed schema and extra search path, and deployed `Accept-Profile: vault` / `Content-Profile: vault` probes must fail. The service-role key is used only against the exact exposed `public` RPCs below. If the project or Supabase support provides an owner-authorized way to revoke the latent Vault ACL, operators must revoke it and record the resulting catalog denial as an additional defense.

The authenticated web API validates its application session, holds a server-side parameter only for the duration of the request, and invokes these exact owner-scoped public capabilities:

- `get_user_provider_key_status`
- `put_user_provider_key`
- `delete_user_provider_key`

`get_user_provider_key_status` returns only provider, status, last-four, validation timestamp, and credential revision. `put_user_provider_key` supports a required replay-only mode that the web boundary invokes before external provider validation. When a receipt exists, that probe checks the receipt-bound credential revision, reads the current live Vault value inside the security-definer transaction, and compares the submitted key exactly in transient memory. It stores no durable secret-derived hash or fingerprint. An exact match returns the original content-free response without another provider validation; missing or drifted live state fails closed, and a different submitted secret is an idempotency conflict even when its last four characters match. Only a replay miss invokes minimal provider validation and the normal store path. The normal call creates or replaces the Vault secret and content-free metadata atomically, increments the credential revision, and destroys the superseded Vault secret in the same transaction. `delete_user_provider_key` destroys the Vault secret and metadata binding atomically and is replay-safe. No response returns a secret, Vault secret ID, encryption artifact, or reusable capability.

The web API uses parameterized database calls and disables/redacts request-body, database-parameter, trace, error, and replay capture for these routes. The native/web client must not persist the pasted key in preferences, drafts, IndexedDB, SQLCipher, analytics, or crash reports. A failed provider validation writes no key or metadata.

### 3. Snapshot settings, never credentials, on each job

Milestone E4 adds exact owner settings capabilities:

- `get_owner_ai_settings`
- `update_owner_ai_settings`

An organization job receives an immutable settings snapshot when its capture is durably accepted. The snapshot contains only organization mode, provider mode, selected provider, routing effort, expansion style, explicit fallback choice, adapter/model-registry version, and settings revision. It contains no provider key, credential revision, Vault secret ID, authorization header, credential ciphertext, key-wrap record, content key, or environment-secret name. Later settings changes affect later captures, not the meaning of an already queued job.

Credential deletion and invalidation are immediate safety overrides: they prevent a later lease from obtaining the deleted/invalid key even when an older job snapshot selected BYOK. Credential replacement may satisfy a queued snapshot only through the newly active key for the same owner/provider; no job pins or restores an old secret.

### 4. Resolve a BYOK credential only for one live organizer lease

Milestone E4 adds exactly one organizer capability:

- `get_lease_bound_organizer_provider_credential`

It accepts only the organization job ID and live lease token—never an owner ID, user token, provider override, Vault ID, or requested credential revision. The security-definer function derives the owner and immutable settings snapshot from the locked job; revalidates lease, expiry, capture privacy/lifecycle, provider visibility, credential status, and fallback policy; reads exactly the matching Vault secret; and returns it only to the exact `unfiled_organizer_worker` TLS session. The response is bounded to provider/source/status metadata plus the credential value and is never persisted by the organizer.

The implemented E4 migration changes the organizer database allowlist from ten to exactly eleven public RPCs by adding only this function. It grants no table, Vault, settings-write, credential-write, or arbitrary secret-read capability. The organizer zeroes or releases credential buffers after the bounded provider call and excludes credentials from errors, telemetry, traces, provider request diagnostics, and health responses.

On a BYOK 401/403, the organizer uses the existing lease-bound failure transition to mark only the resolved owner/provider credential revision `invalid`, place the capture in Inbox with `provider_key_invalid`, and show the owner a settings banner. It may make one app-key transition only when the immutable job snapshot explicitly enabled fallback; fallback is off by default and never crosses to a different provider without an explicit selected policy. A missing, deleted, invalid, or Vault-unavailable credential otherwise makes no provider request and no note write. Deleting a key wins against any credential resolution that has not already completed; a request already disclosed to a provider cannot be retroactively revoked.

### 5. Hide providers and tiers until their complete gate passes

Provider and effort options are server-controlled. A `(provider, tier)` is selectable only after its production adapter, strict schema behavior, cancellation/deadline handling, provider-specific data-control review, identical routing corpus, live stochastic evaluation, custody canary, and operational budget/rate gates pass for the pinned version.

OpenAI remains the only implemented Milestone D adapter and is not production-authorized until its existing live/account gates pass. Anthropic BYOK and Anthropic effort tiers remain absent from API/UI discovery until an Anthropic adapter and current provider×tier evidence land. A database enum, planned port, or ADR text is not availability evidence.

### 6. Freeze the E4 migration and function names

Milestone E4 owns `20260901000005_vault_byok_and_ai_settings.sql` and exactly these new public RPC names:

- `get_owner_ai_settings`
- `update_owner_ai_settings`
- `get_user_provider_key_status`
- `put_user_provider_key`
- `delete_user_provider_key`
- `get_lease_bound_organizer_provider_credential`

The first five are owner-authorized web capabilities. The last is the sole new organizer capability. No parallel lane may add a generic Vault proxy, arbitrary secret getter, provider-key table read, or second organizer credential resolver.

## Alternatives considered

- Keep ADR-0002's app-layer AES-256-GCM fallback: rejected because it turns an application secret/content path into a second credential vault and copies credential ciphertext into ordinary backups.
- Store a key in the organization job under the note-content envelope: rejected because jobs, replay, export, content-key rotation, and organizer capability would all gain credential material.
- Put every user's BYOK key in organizer environment variables: rejected because environment scope cannot provide per-owner CRUD, immediate deletion, or lease binding.
- Give the organizer direct Vault/table access: rejected because a compromised process could enumerate users or retrieve a secret without a current job lease.
- Pin a Vault secret ID in each job: rejected because it persists a reusable secret locator and makes deletion/replacement semantics harder to enforce centrally.
- Show Anthropic because the provider enum already contains it: rejected because a schema placeholder is not an implemented, evaluated adapter.

## Consequences

BYOK cannot ship on a Supabase configuration that lacks the required Vault controls or exposes `vault` through PostgREST. This is an intentional feature gate, not a reason to weaken custody. Database migrations and backups still contain content-free provider metadata, while the Vault system owns credential encryption and deletion behavior. The platform-owned latent `service_role` ACL is not described as revoked unless an owner-authorized production probe proves that exact fact.

The credential-free local E4 gate covers owner CRUD, direct-table denial, wrong-owner denial, lease theft/expiry, replay, deletion/recreate ABA, replacement, invalidation, fallback, Vault outage, log canaries, export/account deletion, and the exact eleven-RPC organizer ACL. Its clean reset passed 39 pgTAP files / 1,901 assertions, including focused `092` at 65/65 and combined `087` + `092` at 148/148; local Vault REST profile probes failed closed with `406 PGRST106`, and the built-local B–E4 HTTP suite passed. The independent final audit is clear; E4 PR/CI remains pending. Production still needs deployed Vault/account/provider/canary evidence plus a Vault backup/restore and deletion-retention review: destroying a live Vault secret does not justify claims about already-created infrastructure backups without provider evidence.

The dedicated application OpenAI key remains separate from user BYOK. The organizer may hold one of them briefly for one provider request, but no durable job, HTTP response, log, export, content envelope, wrap reservation, or key-rewrapping operation contains either key.
