# Provider Outage

## Trigger and safe product state

Use this runbook when OpenAI or Anthropic (Claude) reports elevated timeouts, 429s, 5xx or 529
responses, schema/tool-call failures, refusals, or authentication failures for organization
requests. In the free private beta every provider request is made with the **user's own key** for
the provider snapshotted on that job; there is no operator-funded key and retrieval never calls a
provider. The safe product state is:

- capture remains durably accepted and falls back to Inbox/Review without inventing content;
- private-manual capture and every non-explicit search remain provider-free;
- explicit AI-assisted search is unaffected by a provider outage because its embedding is computed
  in process (`unfiled-local-hash-v1`); it still degrades to lexical-only on its own dependency
  failures;
- provider responses are never retried after the bounded policy (one retry for transport, 408, 409,
  429, 529, or 5xx) is exhausted;
- no provider credential is copied into diagnostics.

Any source-preservation failure, privacy-dispatch error, cross-provider request (a Claude key reaching
OpenAI or an OpenAI key reaching Anthropic), or provider response that appears in logs is a security
incident, not an ordinary outage.

## Authority

The release operator may disable AI organization. The security owner must approve action after
suspected content/key disclosure. A user BYOK credential may be marked invalid only by the
implemented credential-revision-bound failure path; an operator must not edit a user's Vault record
for either provider.

## Diagnose

1. Confirm environment, affected provider (`openai` or `anthropic`), pinned registry version
   (`organization-model-registry-v2`), resolved model IDs in play, incident start, and affected
   service from restricted configuration references—not from environment-variable dumps.
2. Review only aggregate request count by provider and model, status class, timeout, retry,
   circuit-breaker, token, cost, Inbox fallback, and Review-deferral metrics. Claude-specific
   deferrals (text-only, zero/multiple/wrong tool calls, `max_tokens`, refusal, non-object input)
   land in Review and are counted, not logged with content.
3. A failure in one provider must not imply the other is affected; jobs snapshotted to the healthy
   provider continue.
4. Check the provider's status page, per-user rate limits (the user's own key), Vercel egress, and
   DNS/TLS health.
5. For authentication failures, compare the stored credential revision/status for that owner and
   provider. Never perform a diagnostic request with a key in a command argument or log a provider
   body.
6. Verify durable capture acceptance, one receipt per idempotency key, and lexical search using a
   synthetic account.

Stop and switch to [suspected key exposure](./suspected-key-exposure.md) if telemetry contains
content/credentials, the provider received private/default material, a request reached the wrong
provider, or an unknown model/base URL was used.

## Contain and recover

1. Disable AI organization at the narrowest reviewed control (stop the capture drain schedule and
   manual drain callers). Keep capture, manual notes, export, deletion, and lexical/AI-assisted
   search available.
2. Allow already accepted jobs to reach the implemented safe Inbox/Review terminal state. Do not bulk
   retry until the provider recovers.
3. For user-key authentication failures, the product marks only the resolved owner/provider
   credential revision `invalid`, sends the capture to Inbox with `provider_key_invalid`, and shows a
   settings banner. Do not contact the provider on the user's behalf; the user rotates their own key.
4. If a future funded deployment's `UNFILED_ORGANIZER_OPENAI_API_KEY` is invalid, rotate it in the
   provider and Vercel secret stores through the approved procedure, redeploy only the organizer, and
   revoke the superseded credential. Never reuse evaluation or BYOK keys.
5. If throttled, reduce claim concurrency within validated bounds and preserve queue leases. Never
   extend deadlines beyond platform/lease safety budgets (20-second provider deadline, 49-second
   organizer request).
6. When the provider is healthy, use a non-sensitive synthetic fixture on a synthetic account with a
   low-value key for that provider to prove one bounded request, strict schema/tool parsing, `store:
false` (OpenAI) or the single forced tool (Claude), content-free telemetry, and correct fallback
   behavior.
7. Resume a small synthetic batch, then the controlled beta cohort. Watch error rate, queue age,
   receipt latency, and circuit state during the observation window.

## Verification and re-enable

Require:

- three consecutive synthetic requests succeed for the affected provider under a pinned registry-v2
  model;
- no cross-provider request, environment drift, or unknown endpoint;
- queued captures are neither lost nor duplicated and terminal receipts reconcile;
- explicit AI-assisted search still degrades to lexical-only on an injected dependency failure;
- the canary-log audit has zero hits if configuration or logging changed;
- alerting and circuit-breaker state return to normal.

The release operator approves re-enable; the security owner also approves when credentials,
privacy, or unexpected responses were involved.

## Rollback, escalation, and evidence

Roll back a provider/config deployment as one compatible service configuration. Do not roll back the
database or weaken schema validation. Escalate to the provider with request IDs, timestamps, model,
and status class from restricted evidence—never prompts, bodies, or user keys.

Record incident window, affected provider/model, safe error counts, feature state, credential
revision changes if any, fallback verification, queue reconciliation, canary result, approvals, and
provider case reference.
