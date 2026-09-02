# Product Requirements

Scope: MVP as defined in [BUILD_PLAN.md](./BUILD_PLAN.md) Section 5. Every story maps to a milestone and carries acceptance criteria that become test cases in [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md).

Conventions:

- Priority: **M** must-have for MVP, **S** should-have for MVP, **L** later (v1.1+ candidate, listed only when it constrains MVP design).
- IDs are stable and referenced from tests and issues. Do not renumber; retire with strikethrough.
- "AC" = acceptance criteria. Criteria are testable statements, not aspirations.

## 1. Personas

**The overloaded capturer.** Uses the phone default notes app; has 200 untitled notes. Wants to write one line and trust it lands somewhere findable. Judges the product entirely on capture speed and whether the receipt makes sense. Uses they/them here; all personas are composites.

**The logger.** Tracks workouts and groceries. Cares that `bench 135x8` becomes a readable log entry they can correct with a tap, and that a shopping list is tappable in the store with one hand.

**The idea keeper.** Saves principles and project fragments. Cares that their exact words survive, that AI additions are visibly separate, and that a wrong filing is reversible. Most likely to test the trust model and to leave after one silent bad edit.

## 2. Epics and stories

### E1 — Account and authentication (Milestone B)

**REQ-A1 (M): Sign up / sign in with email code.**
AC:

- Entering a valid email sends a one-time code or magic link; the UI states which was sent and when to retry.
- An invalid or expired code shows a specific, non-enumerating error (does not reveal whether the email has an account).
- A successful sign-in on mobile and web establishes a session that survives app restart and browser refresh.
- Rate limiting on code requests is enforced per email and per IP; the error message says when retry is possible.
  Edge cases: mistyped email (resend to corrected address works), code requested twice (latest code wins, both within TTL are acceptable if provider does so), clock skew on device.

**REQ-A2 (M): Sign out.**
AC: signing out clears local session material; the capture outbox is preserved and clearly marked as belonging to the signed-out account; captures do not sync until the same account signs back in.

**REQ-A3 (M): Account deletion.**
AC:

- Deletion requires explicit confirmation including typing a confirmation word or equivalent friction.
- Deletion removes all rows per the deletion pipeline in [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) §8 and signs the user out everywhere.
- A deletion receipt screen states what was deleted and the backup retention window.
- Re-registering the same email creates a fresh empty account.

**REQ-A4 (M): Data export.**
AC: export produces a downloadable archive with Markdown files organized by space, a JSON manifest (IDs, types, dates, tags, links, source captures), and routing rules; export completes for a library of at least 1,000 notes; the archive contains no other user's data (tested).

### E1.5 — Encrypted library (Milestone C.5)

**REQ-E1 (M): Application-encrypted durable content.**
AC:

- Note titles/bodies/structured data, spaces/tags, revisions, generated blocks, routing conditions, mutation/inverse snapshots, organization/review payloads, idempotency responses, snippets, lexical features, hashes, and embeddings persist only as authenticated ciphertext after cutover.
- A seeded canary for every content kind appears in no database field/index, queue/dead letter, Realtime payload, log, trace, analytics event, or plaintext temporary export file.
- Typed CRUD, expected-revision CAS, replay, history, undo, sync, streaming export, soft delete, and hard-delete cascade retain their existing behavior.
- Product copy says application-encrypted, not E2EE, and identifies the operational metadata that remains visible.

**REQ-E2 (M): Managed production key custody.**
AC: production root keys remain in managed KMS/HSM; workloads use short-lived identity; AI/private key classes and principals are separate; KMS or envelope failure has no plaintext fallback; rewrap rotation and backup restore pass. Deletion copy states that old backups may remain decryptable until the published expiry window.

### E2 — Capture (Milestone C)

**REQ-C1 (M): One-field capture.**
AC:

- The composer opens with keyboard focus in the text field; no destination, title, or type selection is required.
- Submitting shows `Saved` within 200 ms perceived (local acknowledgement, no network wait).
- The composer dismisses (or clears, per the open question OQ-4) and processing continues in the background.
- Empty and whitespace-only submissions are rejected client-side with no network call.
- Maximum capture length (see DATA_MODEL constraint, 10,000 chars) is enforced with a visible counter past 90%.

**REQ-C2 (M): Offline capture outbox (mobile).**
AC:

- With airplane mode on, submitting a capture shows the same `Saved` state and a subtle `Waiting to sync` indicator.
- Force-quitting the app and reopening shows the pending capture; reconnecting syncs it exactly once.
- The same capture submitted after a crash-retry produces exactly one server row (idempotency key honored).
- Outbox retries use bounded exponential backoff; a permanently failing capture surfaces a manual retry affordance with a safe error message, never silent loss.

**REQ-C3 (M): Web draft persistence.**
AC: composer text survives page refresh and browser crash via IndexedDB; a pending submission that failed mid-flight is retried or surfaced, not lost.

**REQ-C4 (S): Capture options.**
AC: optional controls set an explicit destination note, mark the capture private, or disable expansion; none are required for the common path; an explicit destination bypasses routing and is recorded as reason code `explicit_destination`.

**REQ-C5 (M): Capture deletion.**
AC: deleting a capture removes the capture; content already routed into a note remains with provenance marked source-removed; the confirmation offers to also remove the inserted blocks as an undoable mutation.

### E3 — Organization and routing (Milestones D/E)

Implementation note: Milestone D implements create-or-append inference, explicit-destination handling, encrypted retrieval, and conservative policy. Stored personal routing-rule CRUD/evaluation remains Milestone E2; the requirements below retain their stable IDs but must not be cited as D evidence.

**REQ-R1 (M): Deterministic rules run first.**
AC:

- A capture matching an enabled routing rule routes without a model call (verified via decision telemetry: no model latency/tokens recorded).
- Rule priority order is respected; the highest-priority matching rule wins.
- A rule pointing at a deleted or archived note falls through to normal routing and flags the rule in settings.

**REQ-R2 (M): Create-or-append decision.**
AC:

- A capture with a strong existing destination appends; one with none creates a note with a validated title and type, or goes to Inbox per the scoring bands in [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) §7.
- The model can only reference candidate IDs it was given; any other ID fails validation and the capture goes to Inbox with reason `invalid_plan` (fails closed).
- Source preservation: the user's exact text is recoverable from every routed result. Zero tolerance; this is a release-gating metric.

**REQ-R3 (M): List extraction.**
AC: `shopping: milk, spinach, batteries` produces three unchecked items with stable item IDs on the correct list note; separators (commas, `and`, newlines) are handled; items are trimmed but not reworded; the raw capture remains linked.

**REQ-R4 (M): Log extraction.**
AC: `bench 135 x 8, 145 x 6` produces a workout entry with exercise, weight, reps per set in `structured_data`; unparseable fragments are preserved as raw text within the entry rather than dropped or invented; no units are invented (see AI spec §9 forbidden behaviors).

**REQ-R5 (M): Ambiguity goes to the user.**
AC: when the score margin is below the review threshold, the capture stays in Inbox/Review with at most three suggested destinations plus `New note`; choosing one applies immediately and records a feedback event.

**REQ-R6 (M): Empty library behavior.**
AC: a brand-new account's first captures only `create_note` or `add_to_inbox`; no append to a nonexistent destination is possible; the first receipt explains the loop in one line.

**REQ-R7 (M): Private captures never reach the model.**
AC: a capture marked private, and any private note, never appears in model requests, embeddings, or AI search — enforced in code and asserted by an automated test that inspects the outbound request builder.

**REQ-R8 (M): Tenant-isolated encrypted candidate index.**
AC: each AI-assisted note has at most one encrypted retrieval document per generation; private notes have none; retrieval reads only the authenticated user's active generation at the exact current note revision and revalidates owner/privacy/revision before model and write. Provider-spy and race tests show zero cross-user/private disclosure.

**REQ-R9 (M): Stale-index behavior fails safe.**
AC: stale rows never surface; at most 50 recent eligible notes use direct-decrypt repair; over-cap, failed repair, or unverified coverage disables RAG-based auto-apply and routes to Review/Inbox unless an explicit deterministic rule resolves the capture. Model change builds a verified shadow generation; key rotation rewraps without re-embedding; delete/privacy changes exclude immediately.

### E4 — Receipts and processing state (Milestone C/D)

**REQ-P1 (M): Visible processing states.**
AC: a capture visibly progresses `queued → processing → done | needs review | failed`; failure shows a retry affordance; state is consistent across mobile and web within realtime latency (< 5 s typical).

**REQ-P2 (M): Receipt content.**
AC: a receipt names the action and destination in plain language (`Added 3 items to Shopping / Aug 30`), lists inserted content, marks any generated block as AI-generated, and offers `Open`, `Move`, `Undo`; receipts remain accessible from the capture's detail view later.

**REQ-P3 (M): Provider outage degrades safely.**
AC: with the model provider unreachable, captures accumulate in Inbox with a status banner; nothing is lost; recovery drains the backlog idempotently.

### E5 — Review, correction, and undo (Milestones D/E)

Implementation note: Milestone D publishes ambiguity/conflict Review outcomes. Milestone E1 now implements owner-authorized encrypted Review reads/resolution, exact decision correction, and server-derived all-or-nothing mutation-batch Undo across the web runtime, database, and native UI. Unsafe correction changes no note, creates a decision-bound encrypted Review with route/create/keep-inbox/dismiss actions, and moves the receipt to `needs_review`. Unsafe batch changes no note, persists a decision-less encrypted Review restricted to keep-inbox/dismiss, and returns private `409 conflict_requires_review`. The database derives the canonical batch anchor and hidden members; grouped non-anchor members and every Undo-generated mutation are rejected as new batch anchors. Receipts and interaction history remain encrypted and owner-bound. E2 implements personal routing rules. E3 preserves an authorized generated expansion as a separate encrypted proposed block plus encrypted pending-expansion Review and implements encrypted, non-destructive duplicate suggestions. Provider settings/Vault-only BYOK remain E4, and Milestones F–G remain pending; neither an ADR nor a reserved migration is acceptance evidence for those later slices.

**REQ-V1 (M): Review queue.**
AC: Review lists low-confidence routes, conflicts, failed jobs, duplicate suggestions, and pending expansions; resolving any item updates the source capture's state; the empty state explains that captures are safe in Inbox.

**REQ-V2 (M): Correction (Move).**
AC: Move re-homes the routed content only when the original mutation's exact typed inverse is safe against the current source note and the authenticated encrypted source capture is still available. The service must preserve the original capture contribution instead of reconstructing prose or structured operations from a decision summary or mutation diff. One transaction locks affected notes in sorted order, validates every member before writing, reverts the old note, updates the new note, gives both new revisions, and anchors both mutations to one feedback event. If exact safety or source-capture availability cannot be proven, neither note changes and the correction enters Review. A successful correction visibly influences the next similar capture through a rule proposal or tested ranking change per AI spec §8.

**REQ-V3 (M): Undo.**
AC:

- Undo within the guaranteed window reverses the mutation via its inverse and creates a new revision; the note content equals the before state (hash-verified in tests).
- If later edits make the exact inverse unsafe, undo changes nothing and opens a focused Review; any later removal is an explicit owner action, never a fuzzy text deletion.
- A completed E1 batch Undo is terminal for one-tap Undo: its generated mutations cannot anchor another batch Undo, and the restored receipt exposes no undo action. Any future reversal is a separately authorized revision-restore operation, never recursive batch Undo.

**REQ-V4 (M): Rule creation from correction.**
AC: after the same correction pattern twice, the product offers a rule (`Always put X in Y?`); accepting creates a visible, editable, deletable rule; declining suppresses the offer for that pattern; no prefix, phrase, alias, or destination rule is activated without explicit confirmation.

**REQ-V5 (M): Expansion acceptance.**
AC: a proposed generated block renders visibly pending; accept keeps it marked as AI-generated with provenance; reject removes it; neither touches user-authored text.

### E6 — Manual notes, spaces, editor (Milestone B)

**REQ-N1 (M): Note CRUD.**
AC: create (with type and space), rename, move between spaces, archive, and delete work on both clients; delete is soft with a stated recovery window, then hard per retention policy.

**REQ-N2 (M): Markdown editor.**
AC: paragraphs, headings, bullet/numbered lists, checklists, quotes, inline links, tags, and note links render and edit correctly; undo/redo works; saving uses expected revision and a stale save is rejected with a merge-or-reload affordance, never silent overwrite.

**REQ-N3 (M): Spaces.**
AC: create, rename, reorder, archive spaces; a space with notes cannot be hard-deleted, only archived or emptied first; MVP limits nesting to one level (validated).

**REQ-N4 (M): Revisions.**
AC: every save, mutation, and undo appears in a revision list with source attribution (manual / organization / undo / import); any revision can be viewed and restored; restore is itself a new revision.

**REQ-N5 (M): Concurrent manual edit beats stale AI job.**
AC: an organization job planned against revision N re-plans once if the note is at N+1; a second conflict goes to Review; the manual edit is never overwritten (tested with a deliberately delayed job).

### E7 — Interactive note surfaces (Milestones B/F)

**REQ-I1 (M, Milestone B): Checklist toggling.**
AC:

- Tapping an item's checkbox toggles it optimistically within 100 ms perceived and syncs as a typed operation with expected revision.
- A rejected toggle (stale revision) rolls back visibly with a one-line explanation and a refreshed note.
- Checked items collapse into `Completed`; a fully checked list can be marked complete, updating the open-state routing signal.
- Toggles are undoable and appear in revision history; screen reader announces `item, checked, N of M remaining`.
- Touch target ≥ 44 pt; keyboard-operable on web.

**REQ-I2 (M, Milestone F): Log field editing.**
AC: tapping a numeric field opens the numeric keypad with steppers; the prior entry for the same exercise pre-fills as placeholder; edits write `structured_data` and regenerate the projection in one transaction; text fields are tap-editable; all edits undoable.

**REQ-I3 (M): Projection integrity.**
AC: the Markdown projection of a list/log note is byte-deterministic for the same `structured_data` (property-tested); an unambiguous free-text edit re-parses; an ambiguous one creates a structure-conflict Review item and leaves the note untouched.

**REQ-I4 (L, v1.1 — design constraint only): Table note type.**
MVP constraint: nothing in the operation schema, `structured_data` versioning, or renderer architecture may preclude adding a `table` type with typed columns later. No MVP implementation.

### E8 — Search (Milestone F; text search from B)

**REQ-S1 (M): Text search.**
AC: exact-word and prefix search over titles and bodies returns results with snippet, note path, and date; results respect archive state. Search is an authenticated `POST` and query/content is absent from URLs and logs.

**REQ-S2 (M): Hybrid search.**
AC: trigram handles misspellings (`spinich` finds spinach); semantic similarity finds `that quote about promising first` → the Roosevelt principle note; ranking follows AI spec §11; only active-generation, current-revision encrypted documents surface. Persisted plaintext vectors/FTS are out of scope without a future ADR.

**REQ-S3 (M): Filters.**
AC: type, space, tag, and date-range filters compose with text queries; private manual notes appear through owner-authorized in-memory lexical search only, and neither private content nor private query reaches an embedding provider.

### E9 — Sync and realtime (Milestone C)

**REQ-Y1 (M): Cross-device consistency.**
AC: a change on one client is visible on the other within 5 s under normal conditions via realtime, and always after pull-to-refresh / reload; ordering of a note's revisions is identical on both clients.

**REQ-Y2 (M): Idempotent everything.**
AC: replaying any mutation request with the same idempotency key returns the original result; verified for captures, typed operations, undo, and review resolution.

### E10 — Settings and personalization (Milestone E)

**REQ-T1 (M): Behavior mode.**
AC: cautious / balanced / automatic modes change banding per AI spec §7.4; the setting explains each mode in one sentence; change takes effect on the next capture.

**REQ-T2 (M): Routing rules management.**
AC: list, create, edit, disable, delete rules; each rule shows its source (explicit or learned) and last time it fired; a dry-run preview shows what a sample capture would do.

**REQ-T3 (M): Profile settings.**
AC: timezone and locale editable (timezone drives daily-note boundaries; changing it does not retroactively re-date existing notes); expansion preference on/off.

**REQ-T4 (M): Bring-your-own-key.**
AC:

- The user can paste an OpenAI or Anthropic API key; it is validated with a minimal test call before saving, and a failed validation stores nothing and shows a safe error.
- After saving, the UI shows only provider, key last-four, and status; no API response ever returns the key; a canary-key log-audit test proves the key appears in no logs, Sentry events, or exports.
- The key is stored encrypted per [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) §7.1; the key table has zero client access (tested).
- Supabase Vault is the only accepted credential store. Vault unavailability disables BYOK; there is no application-layer provider-key ciphertext fallback.
- Deleting the key destroys the stored secret and immediately stops its use; subsequent captures use the app key or Inbox per the fallback setting.
- A key rejected at runtime marks status `invalid`, routes captures to Inbox with `provider_key_invalid`, and banners settings; no silent fallback unless the user enabled fallback.
- BYOK usage bypasses the app's per-user model budget but keeps all rate limits and payload caps.
- Every organization job freezes non-secret provider/effort/expansion/fallback settings at capture acceptance; no job or export contains a provider key or Vault secret ID.
- Provider and tier controls remain hidden until that exact adapter and provider×tier evaluation gate is green; Anthropic is not currently available.

**REQ-T5 (M): Model effort settings.**
AC:

- Routing effort (`economical` / `standard` / `thorough`) and expansion style (`off` / `brief` / `detailed`) are editable and take effect on the next capture, mapped exactly per [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) §13.
- `off` expansion style guarantees no generated block is ever proposed (validation-enforced, tested).
- Effort never changes validation, scoring bands, or trust behavior — only model tier, candidate budget, and sampling (asserted by config test).
- When BYOK is active, each effort option states its cost implication in one line.

## 3. Non-functional requirements

| ID     | Requirement                   | Measure                                                                                          |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| NFR-1  | Local capture acknowledgement | perceived < 200 ms, never network-blocked                                                        |
| NFR-2  | API acknowledgement           | p95 < 500 ms primary region (cold starts tracked separately)                                     |
| NFR-3  | Organization receipt          | p95 < 8 s                                                                                        |
| NFR-4  | Web vitals                    | LCP < 2.5 s, INP < 200 ms on authenticated shell                                                 |
| NFR-5  | Capture durability            | zero loss across crash/retry/duplicate/offline matrices                                          |
| NFR-6  | Accessibility                 | WCAG 2.1 AA minimum; AAA contrast for primary reading text; full criteria in DESIGN_SYSTEM.md §8 |
| NFR-7  | Privacy                       | no note/capture text in logs, traces, or analytics; private notes never in model requests        |
| NFR-8  | Cost                          | per-user daily model budget with Inbox fallback; unit economics reviewed at Milestone G          |
| NFR-9  | Encrypted retrieval           | at 1,000 notes: cold exact retrieval p95 < 2 s excluding provider; warm p95 < 250 ms             |
| NFR-10 | Retrieval quality             | candidate recall ≥ 0.98; wrong auto-apply ≤ 0.01, including stale/missing-index cases            |

## 4. Explicitly out of scope

See BUILD_PLAN §5.2. Any story not listed above and not in §5.3 requires a new requirement here plus an ADR before implementation.
