# ADR-0015: User-selectable provider, model, and effort

- Status: Accepted
- Date: 2026-09-02
- Owners: Product, web, native iOS, organizer, and data contracts

## Context

Unfiled's private beta is bring-your-own-key first. A user who supplies an API key must be able to choose the provider and model that will process their notes. The prior E4 implementation exposed OpenAI key custody and a broad routing-effort setting, but kept one server-pinned model and did not implement Anthropic.

The controls must remain understandable to a non-technical user, must never permit a provider/model mismatch, and must preserve the security guarantees around Vault-held credentials and immutable jobs.

## Decision

The primary settings UI exposes four related controls:

1. Provider: OpenAI or Claude.
2. Model: Automatic or one exact model supported by the selected provider.
3. Effort: Efficient, Balanced, or Thorough. The wire values remain `economical`, `standard`, and `thorough` for compatibility.
4. Organization behavior: Cautious, Balanced, or Automatic routing, plus Off, Brief, or Detailed generated expansion.

The versioned `organization-model-registry-v2` allowlist is:

| Provider  | Selectable models                              |
| --------- | ---------------------------------------------- |
| OpenAI    | `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` |
| Anthropic | `claude-sonnet-5`, `claude-opus-5`             |

`auto` is resolved when a capture job is created:

| Provider  | Efficient         | Balanced          | Thorough        |
| --------- | ----------------- | ----------------- | --------------- |
| OpenAI    | `gpt-5.6-luna`    | `gpt-5.6-terra`   | `gpt-5.6-sol`   |
| Anthropic | `claude-sonnet-5` | `claude-sonnet-5` | `claude-opus-5` |

The organizer maps the effort values to provider-native reasoning effort `low`, `medium`, and `high`. Those values are supported by every model in the v2 registry. Candidate limits and output limits remain bounded independently of provider reasoning.

The exact resolved provider, model ID, effort, expansion style, settings revision, and registry version are copied into the immutable job snapshot. The API key, Vault locator, and authorization header are never copied into a job. A live lease resolves the matching provider credential immediately before the provider request.

Both provider keys may coexist in Supabase Vault. Provider-key status and CRUD operations are addressed by an explicit provider. Switching provider resets an incompatible model choice to Automatic but does not delete either key.

App-funded fallback remains an explicit opt-in and is shown only as a deployment-dependent capability. The free private-beta deployment does not promise app-funded inference.

## Validation rules

- App-default mode requires a null BYOK provider and Automatic model selection.
- BYOK mode requires exactly one selected provider.
- OpenAI accepts Automatic or an OpenAI model from the v2 registry.
- Anthropic accepts Automatic or a Claude model from the v2 registry.
- Unknown model IDs, cross-provider model IDs, unsupported effort values, extra advanced keys, and stale settings revisions fail closed.
- Provider responses remain untrusted data and pass the same strict schema, candidate-ID, ownership, revision, and operation allowlist checks.
- Raw sampling controls such as temperature, top-p, and arbitrary prompts are not exposed. They do not improve this bounded structured-routing task and can produce provider-specific incompatibilities.

## User experience

Automatic is the default model choice. Exact IDs and cost implications appear in secondary copy so a user can make an informed choice without needing to understand API terminology first. Changing settings affects only captures accepted after the save succeeds. In-flight and queued jobs retain their original snapshot.

The web and native iOS clients use the same catalog and validation fixtures. Both implement loading, empty, validation, stale-revision, ambiguous retry, invalid-key, replacement, and deletion states.

## Consequences

- Adding or retiring a selectable model requires a registry version change, provider adapter tests, routing evaluation, client catalog update, and deployment evidence.
- Exact model choice improves user control but can increase user-funded cost. The UI identifies higher-cost choices before save.
- The free beta can operate without an application model key when BYOK-only mode is active.
- Provider-neutral local retrieval remains separate from the generative model choice. A Claude key is never sent to an OpenAI embeddings endpoint.

## Sources checked

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [Claude effort controls](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Claude model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
