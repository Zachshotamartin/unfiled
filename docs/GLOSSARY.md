# Glossary

Terms are used with exactly these meanings in every document, in code identifiers, and in product copy. When a term drifts, fix the code or copy, not the glossary, unless an ADR changes the definition.

| Term                | Definition                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture             | The original user submission, saved verbatim before any organization. The durable source of truth.                                                                              |
| Note                | A living document with a stable ID, title, type, space, canonical content, and revision history.                                                                                |
| Note type           | One of `generic`, `list`, `log`, `principle`, `project`. Guides rendering, extraction, and interaction surface.                                                                 |
| Note item           | An addressable unit inside a `list` or `log` note (checklist item or log entry) with a stable server-assigned ID.                                                               |
| Space               | A user-visible top-level grouping of notes, such as Shopping or Health.                                                                                                         |
| Inbox               | The state of a capture that has no destination yet. Not a separate table; a capture processing status. Surfaced in Today (`Needs a home`) on mobile and as a rail entry on web. |
| Organization plan   | Validated model output: a decision plus zero or more allowed operations against server-provided candidates.                                                                     |
| Organization job    | The durable workflow execution that turns one capture into a mutation, Review item, or Inbox state.                                                                             |
| Decision            | The recorded outcome of one organization job: candidate manifest, signals, validated plan, behavior band, destination, reason codes.                                            |
| Mutation            | The transactional application of operations to one note: before/after revision, applied operations, inverse, audit metadata.                                                    |
| Typed operation     | A named, schema-validated operation from the allowlist. AI-grantable ops and user-only ops share one validation and mutation pipeline.                                          |
| Behavior band       | The policy outcome for a decision: `auto` (apply with Undo receipt), `review` (wait for the user), `inbox` (no useful candidate).                                               |
| Receipt             | The compact user-facing record of what an organization job did, with Open, Move, and Undo actions.                                                                              |
| Review item         | An unresolved decision or failure awaiting user input: low confidence, conflict, failed job, duplicate suggestion, or pending expansion.                                        |
| Routing rule        | A deterministic user-owned rule (prefix, phrase, alias, destination mention) evaluated before any model call.                                                                   |
| Alias               | A routing rule of type `alias` mapping a phrase to a note. There is no separate alias store.                                                                                    |
| Generated block     | Model-generated text stored with provenance and acceptance state (`proposed`, `accepted`, `rejected`). Never merged invisibly into user text.                                   |
| Expansion           | AI-added interpretation, summary, or suggestion. Always a generated block; never automatic content inside user text.                                                            |
| Formatting          | Converting clear list/log syntax without changing meaning. May be automatic. Distinct from expansion.                                                                           |
| Canonical source    | The authoritative content representation per note type: `body_markdown` for prose types; `structured_data` for `list` and `log`.                                                |
| Projection          | The deterministic Markdown rendering of a structured note, regenerated in the same transaction as each structured mutation.                                                     |
| Structure conflict  | A manual free-text edit to a projected region that cannot be unambiguously re-parsed; becomes a Review item.                                                                    |
| Revision            | An immutable numbered snapshot of a note. Every mutation, manual edit, undo, and import creates one.                                                                            |
| Expected revision   | The revision a writer believes is current. A write with a stale expected revision is rejected.                                                                                  |
| Idempotency key     | The client-generated ULID that makes capture submission and mutation requests safe to retry.                                                                                    |
| Outbox              | The mobile-local (Expo SQLite) queue of captures awaiting server acknowledgement. Capture-only in MVP.                                                                          |
| Candidate           | A note the retrieval stage nominates as a possible destination, with the metadata sent to the model.                                                                            |
| Candidate manifest  | The recorded list of candidates and signals a decision was made from.                                                                                                           |
| Reason code         | A stable machine string explaining a decision factor, e.g. `explicit_shopping_intent`.                                                                                          |
| Behavior mode       | The per-user organization setting: `cautious` (everything waits), `balanced` (default), `automatic` (wider auto band).                                                          |
| Private manual note | A note excluded from model context, embeddings, and AI search.                                                                                                                  |
| Evaluation corpus   | The versioned set of routing cases with expected outcomes used to tune scoring and gate releases.                                                                               |
| RLS                 | PostgreSQL Row Level Security; every exposed table enforces per-user ownership at the database layer.                                                                           |
| ULID                | Lexicographically sortable unique ID; used for client-generated IDs. Server IDs use typed prefixes, e.g. `note_01H...`.                                                         |
| BYOK                | Bring-your-own-key: a user-supplied OpenAI or Anthropic API key, encrypted at rest, used for that user's organization calls in place of the application key.                    |
| Routing effort      | User setting (`economical`/`standard`/`thorough`) selecting model tier, candidate budget, and sampling — never validation or trust behavior.                                    |
| Expansion style     | User setting (`off`/`brief`/`detailed`) bounding whether and how long generated expansions may be.                                                                              |
| Provider registry   | The set of `OrganizationModel` adapters (OpenAI, Anthropic) behind one port; both must pass the same evaluation corpus.                                                         |
