# ADR-0002: Bring-your-own-key provider strategy and key custody

- Status: accepted
- Date: 2026-08-30
- Decision drivers: user request for BYOK (OpenAI or Anthropic) with effort settings; personal notes demand strict key custody; solo maintenance budget; trust behavior must not vary by provider or price tier.

## Context

Users may prefer their own provider account for cost transparency, provider choice, or trust. Routing runs server-side in a durable workflow, so a user key must be server-accessible at request time — client-only storage cannot work. Storing third-party API keys makes us a custodian of credentials that spend the user's money.

## Decisions

1. **Two adapters behind the existing `OrganizationModel` port:** OpenAI (Responses API, strict Structured Outputs, `store: false`) and Anthropic (Messages API, forced tool call carrying the organization schema). Both must pass the identical evaluation corpus per `(provider, effort tier)` before being selectable; failing tiers stay hidden.
2. **Credential resolution:** user BYOK key for their chosen provider → app key for the default provider. No silent fallback on BYOK failure; fallback is an explicit user setting, default off.
3. **Custody: Supabase Vault** for encrypted storage (fallback: app-layer AES-256-GCM, KEK in server env only). Zero client access to the key table; status functions expose provider/last-four/status only; decryption only inside the workflow, in memory, per request; canary-key log audit in CI.
4. **Effort settings change economics, never trust:** routing effort (economical/standard/thorough) selects model tier, candidate budget, and sampling; expansion style bounds generated blocks. Schema, validation, scoring bands, and hard overrides are identical at every tier — asserted by test.
5. **Budget interplay:** BYOK bypasses the app's per-user model budget (user's spend) but keeps all rate limits and payload caps, plus a call-volume anomaly alert protecting the user's wallet from our bugs.

## Alternatives considered

- **Client-held key, proxied per request:** key never at rest server-side, but breaks durable background organization (retries after the client is gone) — the core reliability feature. Rejected.
- **App key only (no BYOK):** simplest; rejected as an explicit product requirement, and BYOK also derisks provider cost at portfolio scale.
- **One provider only:** halves adapter/eval work; rejected because the port already isolates providers and dual support proves the abstraction claimed in ADR-0001.
- **KMS outside Supabase (e.g. cloud KMS envelope):** stronger separation, more moving parts for one person; Vault chosen as sufficient with the fallback documented; revisit on Vault limits.

## Consequences

Every eval report gains a provider×tier matrix; prompt changes must be validated on both providers. We accept credential-custodian responsibility: the SECURITY_AND_PRIVACY §7.1 rules and §10 checklist items are release-gating. Key columns never appear in exports, logs, or backups in plaintext. If a third provider is ever added, it enters through the same registry + corpus gate, not ad hoc.
