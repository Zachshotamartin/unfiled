# ADR-0011: Encrypted owner interactions and personal routing rules

- Status: accepted
- Date: 2026-09-01
- Depends on: ADR-0006 encrypted content, ADR-0008 reservation/replay, and ADR-0009 organizer isolation
- Decision drivers: make correction and Review resolution atomic across encrypted aggregates; keep private rule text outside AI workloads; preserve exact user-authored content; make learned behavior visible and consensual; prevent duplicate and expansion suggestions from becoming destructive model effects.

Implementation status: E0 and the E1 correction/Review/batch-Undo portion are implemented and locally verified. E2 private rules/personalization, E3 generated blocks/duplicate suggestions, E4 settings/Vault-only BYOK, and Milestones F–G remain pending. This ADR does not claim deployment or account evidence.

## Context

Milestone D can create or append one encrypted note from a leased organization job, or publish an encrypted Review item. Milestone E adds interactive effects initiated by an authenticated owner: move a prior decision to a different note, undo a mutation batch, resolve Review, manage routing rules, accept or reject a generated expansion, and act on a duplicate suggestion.

These interactions cannot safely be implemented as unrelated note writes. A correction may need to remove the exact contribution from one note and add it to another, with two new revisions and one feedback event. Application encryption means the service must decrypt and derive new snapshots outside PostgreSQL, but the database must still own identities, reservations, ownership, replay, revision compare-and-swap, and the all-or-nothing commit. A best-effort removal from the old note could erase a later user edit; committing the destination before discovering a stale source could duplicate content.

Routing-rule conditions are user content. Sending all rule text to the organizer would expand the AI workload's decryption and disclosure boundary even when a deterministic rule already decides the destination. A repeated correction is evidence for offering a rule, not consent to activate one. Generated text and duplicate suspicions have the same trust problem: a model suggestion must not silently become user-authored content, a merge, or a deletion.

## Decision

### 1. Keep interactive custody in the owner-authorized web service

The authenticated web/API service is the only Milestone E workload that may open the encrypted source mutation, Review payload, routing-rule condition, and all affected owner note snapshots for an interactive action. It derives the owner from the verified session, uses a callback-scoped owner-authorized custodian, and returns only decrypted product DTOs to that owner. The browser and native client receive no database credential, envelope, wrap reservation, content MAC, key identifier, or direct table grant.

The organizer remains a lease-driven AI-assisted workload. It does not receive a browser session, a caller-supplied owner, private-manual key capability, Review-resolution capability, correction capability, or routing-rule plaintext.

### 2. Use a two-phase reservation and request-MAC protocol

Every interactive encrypted write whose result contains new ciphertext uses prepare then commit:

1. The prepare RPC derives or verifies the owner, claims the global owner/idempotency namespace, validates the requested decision or Review item and expected revisions, creates stable revision/mutation/feedback/resolution identities, and issues exact owner/class/purpose/resource/version-bound wrap reservations. Correction prepare is outcome-neutral: it returns discovery ciphertext plus mutually exclusive prepared `applied` and `needs_review` branches because exact inverse safety is knowable only after owner-authorized decryption.
2. The web service opens the authorized source envelopes, derives the complete before/after payloads in bounded memory, seals every prepared object, self-verifies the envelopes, and computes the canonical logical-request MAC using the prepared content-MAC key reference.
3. The commit RPC compares the request MAC before accepting randomized ciphertext, consumes each reservation in the selected branch exactly once, atomically invalidates every unused sibling reservation, and either publishes every related row/event/index job or publishes nothing. A response-lost retry reuses the same prepared identities and returns the same encrypted result.

Prepare does not hold a database lock across decryption or encryption. Commit acquires every affected note lock in ascending note-ID order, followed by the decision/Review/idempotency rows in a fixed documented order. It validates all ownership, lifecycle, privacy class, current revision, mutation lineage, prepared identity, MAC, envelope shape, key reference, reservation, relation, and destination predicates before its first durable write. A stale or invalid member aborts the transaction without a partial revision, feedback event, Review resolution, receipt, cursor event, or index job.

### 3. Correct only through an exact safe inverse

A decision correction may remove content from the old destination only when the original mutation's stored inverse is exactly applicable to the current source snapshot. Compatibility includes the original inserted stable identifiers, expected content/structure, mutation lineage, and every dependency declared by the typed inverse contract. The implementation may not reconstruct an inverse from model output, normalized text, fuzzy matching, or a current note diff.

Every applied correction also requires the authenticated encrypted source capture. The service rebinds the validated typed plan to the selected destination while preserving that original capture contribution; it does not recreate list items, log entries, structured patches, or prose from a decision summary or mutation diff. A missing, deleted, retention-expired, or otherwise unavailable source capture makes exact application unavailable and therefore takes the zero-note-change Review path.

When the inverse is safe, one atomic commit applies it to the old destination and the new typed append/create effect to the selected destination. It creates two distinct note mutations when two notes change, records them as one server-derived correction batch, and permits reversal only through that complete batch rather than legacy single-member Undo. One prepared feedback event anchors both mutations and records the source decision plus old and new destinations; retries cannot create a second feedback event.

When the inverse cannot be proven safe—including intervening dependent edits, missing inserted IDs, stale revisions, deleted destinations, or incompatible structure—the correction changes no note. It creates or updates one encrypted Review item that explains the conflict and offers explicit owner actions. It never falls back to deleting matching prose or duplicating the capture into the new destination.

The unsafe-correction transaction also repoints the source capture receipt to that Review item and records the `needs_review` outcome. This keeps capture history and Review navigation consistent without representing any note mutation as applied. The public correction endpoint returns the typed `needs_review` success response because the requested safe fallback has been durably created.

Undo of a mutation batch uses the same rule: every inverse in the batch must be exactly compatible before any member is applied. Otherwise the entire batch remains unchanged and enters Review. An applied batch Undo is terminal: the generated Undo batch cannot be used as another batch source, and its restored receipt carries no undo action or undo targets.

`get_encrypted_mutation_batch` is the outcome-neutral preparation boundary for batch undo. The server records a canonical anchor when a correction/organization batch is created; the caller may submit that one mutation ID, but cannot choose the anchor or supply a member list. The function rejects a grouped non-anchor and every member of an Undo-generated batch, derives the complete authenticated batch itself, limits it to 1-16 distinct owned notes, returns every encrypted discovery projection plus mutually exclusive applied and Review plans, and allocates stable output identities and reservations. Web selects a branch only after decrypting and validating every exact inverse. If any member is unsafe, `undo_encrypted_mutation_batch` atomically persists the encrypted Review fallback and then the HTTP endpoint returns private `409 conflict_requires_review`; the success-only batch response is never fabricated for a no-op.

#### 3.1 Bind Review metadata to authenticated proposal semantics

The operational Review type must agree with the proposal inside the authenticated Review envelope. Readers reject a mismatch instead of choosing whichever field is more convenient. Resolution compatibility is frozen as follows:

| Review type            | Authenticated proposal                                               | Permitted terminal actions                        |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| `low_confidence`       | `route_capture` with a validated organization plan                   | `route`, `create`, `keep_inbox`, `dismiss`        |
| `revision_conflict`    | `conflict/revision`                                                  | `route`, `create`, `keep_inbox`, `dismiss`        |
| `failed_job`           | `failed_job` with a stable error code                                | `keep_inbox`, `dismiss`                           |
| `duplicate_suggestion` | `duplicate_notes` with two or three distinct revisioned note choices | `keep_both`, `dismiss`                            |
| `pending_expansion`    | `generated_block` with its exact block ID                            | `accept_expansion`, `reject_expansion`, `dismiss` |
| `structure_conflict`   | `conflict/candidate_eligibility` or `conflict/structure`             | `route`, `create`, `keep_inbox`, `dismiss`        |

The table is the base type/proposal contract; authenticated provenance may narrow it further. E1's unsafe correction fallback retains the exact decision and source-capture lineage, so its `revision_conflict` permits `route`, `create`, `keep_inbox`, or `dismiss`. An unsafe batch-Undo fallback intentionally has no decision lineage, so its otherwise compatible `revision_conflict` permits only `keep_inbox` or `dismiss`. Route/create is rejected before any write for that decision-less item.

Milestone D's temporary `pending_expansion` + `conflict/consent_controls` item is readable only as an open consent hold and may only be dismissed; it cannot accept or reject text that E3 has not durably preserved. Route, create, and keep-inbox actions additionally require prepare to bind an exact authorized source capture or plan. If that source cannot be proven, the server leaves the item unchanged and fails closed. Legacy V1 Review payloads are readable only while open with no resolution, and only when their typed semantics can be reconstructed without interpreting arbitrary strings.

### 4. Keep expansions proposed and duplicate handling non-destructive

Generated expansion text is a separate encrypted `generated_block` with state `proposed`, provenance, and its own prepared identity/reservation. It is never inserted into user-authored note body or structured data during organization. Accepting retains the separately rendered generated block and its provenance; rejecting hides it from the note and retains only the bounded undo/audit state required by policy. Neither action rewrites source capture text.

Milestone D does **not** currently preserve a returned `generatedExpansion`: the application discards that proposed text. Milestone E3 extends the existing organizer prepare/commit payloads to persist the separately encrypted proposal before the product may claim pending-expansion acceptance.

A duplicate result is an encrypted `duplicate_suggestion` Review item referencing authorized owner note IDs and an explanation inside its encrypted payload. The organizer and model cannot merge, delete, archive, rewrite, or redirect either note based on that suggestion. Dismissal is metadata-only. Any future merge command requires an explicit owner action and its own safe, reversible multi-note contract; it is not authorized by this ADR.

### 5. Evaluate private rule conditions only in the web trust domain

Every routing-rule condition, including aliases, is encrypted with the `private_manual` content class. The owner-authorized web service decrypts a bounded active rule set and evaluates normalized prefix, phrase, alias, and destination-mention matching before dispatching organization. A matched capture receives an immutable, content-free routing snapshot containing only the rule ID, exact rule revision, destination kind/ID, priority, and match outcome. The database binds that snapshot to the capture/job and validates the destination owner and lifecycle.

The organizer receives only that content-free snapshot. It may honor the validated destination without a model call, but it never receives the condition, alias text, sample capture, rule-edit history, or private-manual key record. Rule plaintext is absent from queues, telemetry, logs, Realtime events, and provider requests.

An explicit rule becomes enabled only through direct owner creation or an owner's affirmative confirmation of a learned-rule proposal. Repeated corrections may create or update a disabled encrypted proposal, but no learned prefix, phrase, alias, or destination rule becomes active silently. Declining or dismissing a proposal is recorded content-free for offer suppression and does not create an enabled rule.

### 6. Freeze the Milestone E migration and RPC lanes

The following ownership prevents parallel migrations and adapters from inventing overlapping boundaries. The timestamp slots and public RPC names are reserved before implementation:

| Lane                         | Reserved migration                                                        | Exact public RPCs / extension boundary                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 corrections and Review    | `20260901000002_encrypted_decision_corrections.sql`                       | `prepare_encrypted_decision_correction`, `commit_encrypted_decision_correction`, `prepare_encrypted_review_resolution`, `commit_encrypted_review_resolution`, `get_encrypted_mutation_batch`, `undo_encrypted_mutation_batch` |
| E2 rules and personalization | `20260901000003_encrypted_routing_rules_and_personalization.sql`          | `prepare_encrypted_routing_rule_write`, `commit_encrypted_routing_rule_write`, `delete_encrypted_routing_rule`                                                                                                                |
| E3 expansions and duplicates | `20260901000004_encrypted_generated_blocks_and_duplicate_suggestions.sql` | extend the existing `prepare_encrypted_organizer_create`, `prepare_encrypted_organizer_append`, and `commit_encrypted_organizer_job` payloads; add `resolve_encrypted_generated_block`                                        |

`20260901000001_milestone_e0_interaction_contracts.sql` implements the shared Milestone E foundation, and `20260901000002_encrypted_decision_corrections.sql` implements the E1 lane. The latter includes one migration-owned, runtime-inaccessible compatibility repair for legacy organizer receipt timestamps: it requires exact job/capture/preparation/reservation/envelope/verification attestation, changes only the relational timestamp to authoritative capture occurrence time, preserves ciphertext/revision/verification, restores the ordinary write guard, and fails the upgrade if any candidate is unattested. E2–E3 remain unavailable to other lanes, and E4's separately governed Vault/BYOK slot and RPCs are frozen in ADR-0012.

## Alternatives considered

- Apply source removal and destination insertion as two API mutations: rejected because a stale/error boundary could duplicate or lose content and split one correction into inconsistent feedback.
- Hold row locks while the web service decrypts and reseals: rejected because external KMS work inside a long transaction amplifies contention and availability failures.
- Remove the old contribution by matching text: rejected because normalized or duplicated prose cannot prove which user-authored bytes the original mutation owns.
- Send decrypted rules to the organizer: rejected because it expands a private-manual decryption boundary and provider-adjacent memory surface for deterministic behavior the web service can decide first.
- Activate a narrow learned alias automatically: rejected because users cannot predict which repeated correction silently became durable routing behavior.
- Let a duplicate suggestion merge notes automatically: rejected because similarity is not authorization to destroy or rewrite either source.

## Consequences

Interactive correction costs more envelope operations and requires fixed lock-order concurrency tests. Some apparently simple moves will enter Review when exact inverse compatibility cannot be proven; this is an intentional protection against user-text loss.

The web service becomes the bounded plaintext evaluation point for routing rules, so rule pagination, memory lifetime, cancellation, log canaries, and capture/job snapshot integrity are release-gating. The organizer stays narrower and can short-circuit from a content-free database-bound result.

E1 tests cover cross-owner denial, replay, stale revisions, canonical-anchor and membership enforcement, sorted-lock concurrency, reservation/MAC substitution, partial-failure rollback, private-key denial, plaintext-canary absence, terminal Undo, action-limited conflict Review, and the attested timestamp projection repair. E2–E3 must extend those properties to private rules, generated blocks, and duplicate suggestions. No E1 result establishes expansion preservation, duplicate behavior, or learned-rule activation.

User-facing semantic search remains outside this decision. Adding query embeddings requires a separate trust decision and separately deployable service. It may not reuse organizer or index-worker workload keys: no database password, provider API key, OIDC credential, KMS grant, runtime secret, or plaintext cache may be copied into search. Whether a new exact search principal may be separately authorized to unwrap the existing AI-assisted index envelopes must be decided explicitly before Milestone F hybrid search; current owner-authorized lexical search remains the only accepted user search path.
