# Soft Index: Full Build Plan

Working title: **Soft Index**. The name describes an index that adapts to the person instead of making the person maintain a rigid filing system. It is provisional until a proper trademark, App Store, package-name, social-handle, and domain review is complete.

Plan status: selected product direction and implementation blueprint. No production claims in this document are implemented yet.

This plan is the spine of a full documentation set; see [docs/README.md](./README.md) for reading order. Companion documents:

- [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md): user stories, acceptance criteria, and edge cases per epic
- [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md): pipeline contracts, prompt, schemas, scoring, provider/effort settings, and evaluation corpus
- [DATA_MODEL.md](./DATA_MODEL.md): full DDL, RLS policies, transactional functions, structured-data schemas, retention
- [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md): threat model, BYOK key custody, disclosure, deletion pipeline, incident handling
- [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md): environments, CI, enumerated test inventory, release checklists, backups, monitoring
- [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md): tokens, components, states, accessibility rules (skeleton; completed during Milestone 0)
- [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md): deferred decisions with defaults and decision triggers
- [GLOSSARY.md](./GLOSSARY.md) and [decisions/](./decisions/): shared vocabulary and architecture decision records

When this plan disagrees with a companion document on a detail, the companion document wins and this plan gets corrected.

## Plan Review Outcome

Build the product, but keep its thesis narrower than "Obsidian with AI." Several products already combine capture, AI, graphs, daily notes, and automatic organization. The distinctive product is a phone-first capture layer that reliably turns a short message into a visible update to a living note without asking the user to choose a folder or title first.

The plan makes the following decisions:

1. **The capture is the durable source of truth.** Save it before any model call. AI processing can fail without losing what the user wrote.
2. **AI proposes typed organization operations.** It never receives unrestricted database tools and never writes arbitrary SQL or document patches.
3. **Every automatic change produces a receipt and an undo path.** The user can see what happened, correct it in one or two taps, and teach the system a stable preference.
4. **Manual notes remain a complete product.** Navigation, search, editing, folders or spaces, history, export, and recovery cannot depend on AI.
5. **Start with text capture and five note types.** Voice, images, web clipping, collaboration, public publishing, and deep research workflows follow only after routing quality is proven.
6. **Use one shared TypeScript domain and API, not one stretched UI.** The Next.js web application and Expo mobile application share contracts, domain logic, API clients, design tokens, and tests. They use platform-appropriate screen implementations.
7. **Use a durable background workflow for organization.** The request that accepts a capture returns quickly; routing and expansion continue reliably and can be retried idempotently.
8. **Cloud sync is part of the MVP, but capture is offline-capable.** A phone without a connection can still accept a thought into a local outbox and sync it later.
9. **Do not claim end-to-end encryption while server-side AI reads note content.** Provide a manual-only private-note mode and disclose the actual data path precisely.
10. **Design the complete core loop before bootstrapping application code.** Start with information architecture, mobile wireframes, dark-mode tokens, high-fidelity core screens, responsive web adaptations, and a clickable prototype. The first coded vertical slice follows the approved design rather than inventing the product while implementing it.
11. **Prove a vertical slice before building a broad knowledge platform.** The first convincing coded demo is capture, route, append, receipt, correction, undo, and cross-device sync.

## 1. Product Definition

### One-sentence pitch

> A phone-first notes app where you write one message and the right living note updates itself, with the original capture preserved and every AI change visible, correctable, and reversible.

### The problem

Many people do not fail at note-taking because they dislike writing. They fail at the moment before writing:

- Which note should this go in?
- Does a matching note already exist?
- What should the title be?
- Is this a task, a list item, a journal entry, or an idea?
- Will I remember where I put it later?

The cost of that filing decision is enough to make the person open a blank note, write an untitled fragment, or write nothing. The fragment then becomes hard to find and impossible to build on.

### Product thesis

Separate **capture** from **organization**.

The user should be able to write a message in seconds. The system should save it immediately, determine the likely note type and destination, add it to an existing note or create an appropriate note, and show a plain-language receipt. If the system is unsure, it should ask for a small routing decision without discarding the capture.

Organization should become more accurate through explicit corrections and deterministic personal rules, not through hidden behavior the user cannot inspect.

### The flagship demonstration

A user opens the mobile app and submits three messages over a day:

1. `shopping: milk, spinach, batteries`
2. `bench 135 x 8, 145 x 6, 155 x 4; incline dumbbell 45 x 10 for 3 sets`
3. `Roosevelt method: tell people you can do it, then figure out how to do it later`

Soft Index:

1. Adds three unchecked items to `Shopping / August 30`.
2. Creates or updates `Workouts / August 30`, preserves the raw line, extracts exercises and sets into a readable workout entry, and offers an optional summary.
3. Adds the exact thought to `Mindset / Principles`, labels the proposed interpretation as AI-generated, and does not assert that the name or attribution is historically correct.

Each result appears in a processing receipt with `Open`, `Move`, and `Undo`. A later message, `add bananas`, goes to the currently active shopping note because the server considers explicit wording, recent destinations, open list state, and the user's prior routing decisions.

The same notes are visible and manually editable in the hosted web application.

## 2. Positioning and Existing Product Landscape

This category exists. The opportunity is a focused behavior and trust model, not the absence of competitors.

| Product | Relevant strength | Gap Soft Index should target |
| --- | --- | --- |
| Obsidian | Local files, links, plugins, deep research workflows | Organization still depends heavily on user-created structure and desktop-oriented habits |
| Mem | Capture without organizing and an agent with broad workspace context | Broader chief-of-staff direction; Soft Index should make routing receipts, correction, and small personal notes the center |
| Tana | Structured nodes, supertags, capture, and AI | Powerful schema and outliner concepts introduce setup and vocabulary before value |
| Capacities | Daily notes, object types, mobile capture, and review | The user still selects destinations and performs substantial review or conversion work |
| Reflect | Fast networked notes, sync, encryption, and AI assistance | AI-assisted writing and graph features are broader than message-to-note routing |
| Rill | Very close thesis: capture, automatic entities, tasks, and connections | Desktop and coding-agent orientation leaves room for a consumer phone-first product with a shared hosted web app |

### Selected differentiation

Soft Index is not marketed as a second brain, research tool, or autonomous chief of staff. Its promise is smaller and testable:

- Capture has no filing question.
- One message can update an existing note.
- The user always knows what changed.
- A wrong decision is easy to correct and undo.
- Corrections become stable personal routing rules.
- The mobile app is the primary capture surface, not a companion afterthought.
- Manual browsing and editing are obvious enough that the user never feels trapped behind AI.

### Product language

Prefer functional labels in the application:

- `Capture`
- `Today`
- `Notes`
- `Review`
- `Search`
- `Spaces`
- `Moved to Shopping`
- `Added to today's workout`
- `Needs your input`

Do not force the brand metaphor into every control. The name can be expressive while the interface stays literal.

## 3. Product Principles and Invariants

### 3.1 Capture first

The system acknowledges a locally or remotely durable capture before starting organization. A model outage cannot turn the Save button into data loss.

### 3.2 Original text survives transformation

Every organized block links back to its source capture. Generated expansions are distinct from the user's words. A user can inspect the source, remove generated material, or restore a prior note revision.

### 3.3 AI does not own the information architecture

The model chooses from server-provided note IDs, note types, spaces, and allowed operations. Creating a new destination is an explicit operation with a validated title and type. The model cannot invent an existing note ID or bypass ownership checks.

### 3.4 Automatic changes are inspectable and reversible

Every applied organization plan records:

- source capture
- chosen destination
- operation type
- model and prompt version
- deterministic signals used
- confidence band
- before and after note revisions
- user correction or undo, if any

### 3.5 Confidence changes behavior

High-confidence actions may apply automatically. Medium-confidence actions may apply with prominent correction controls or wait in Review, depending on the user's preference. Low-confidence actions remain safely in the Inbox with suggested destinations.

Do not trust a model's self-reported probability by itself. Calibrate the decision score from evaluated model output plus deterministic signals such as explicit keywords, exact aliases, open list state, recency, prior corrections, and candidate separation.

### 3.6 Manual behavior is first-class

The user can always:

- create a note directly
- choose a space and note type
- rename, move, archive, or delete a note
- edit the full note without an AI command
- move a capture or block to another note
- pin a note as the active destination for a phrase
- search by text, date, type, tag, or space
- export readable Markdown and JSON

### 3.7 Personal rules beat repeated inference

When the user says `Always put "groceries" in my Shopping list`, or corrects the same pattern repeatedly, store an explicit routing rule. Evaluate these rules before calling a model. Rules are visible, editable, and removable.

### 3.8 No silent expansion

Generated summaries, interpretations, or recommendations are marked as generated. The system may automatically format clearly structured facts, such as list items or workout sets, but it must not silently turn a short opinion into a long essay inside the user's note.

### 3.9 The system is useful without a graph view

Relationships and semantic links may improve retrieval, but a graph visualization is not part of the MVP. It does not solve the capture problem and can distract from a simpler information hierarchy.

### 3.10 Deletion means deletion

Undo history has a bounded retention window. The MVP default: full revision history is retained without pruning, direct one-tap undo of an AI mutation is guaranteed for 30 days, and older changes remain reversible through revision restore. Automatic pruning is deferred until real storage metrics justify it, and any future pruning policy is published before it takes effect. Account deletion and note deletion behavior are documented, testable, and propagated to search indexes, embeddings, generated artifacts, and backups according to the published retention policy.

## 4. Target User and Jobs to Be Done

### Primary user

A person who already uses a phone notes app but has many untitled, duplicated, or abandoned notes. They want to capture personal logistics, workouts, ideas, principles, errands, and project fragments without adopting a knowledge-management methodology.

### Core jobs

1. **When a thought occurs, let me save it before I decide where it belongs.**
2. **When I add a fragment later, find the note I meant and update it.**
3. **When a capture contains a familiar shape, turn it into a useful list or log without changing its meaning.**
4. **When the system is uncertain or wrong, let me fix it quickly and remember that preference.**
5. **When I want control, let me navigate and edit the note structure manually.**
6. **When I need something later, let me find it by ordinary words, approximate meaning, or date.**

### Secondary users after MVP

- people who prefer voice capture while walking or driving
- users who want a simple workout or habit log without a dedicated fitness system
- students capturing small ideas but not building a research vault
- neurodivergent users who benefit from eliminating the filing decision

Do not make medical, therapeutic, or accessibility claims without appropriate evidence and review.

## 5. Scope

### 5.1 MVP scope

- Email magic-link or one-time-code authentication
- iOS and Android application through Expo development builds
- Responsive web application and marketing page hosted on Vercel
- Text capture from mobile and web
- Offline mobile capture outbox
- Five note types: generic note, list, log, principle, project
- Interactive typed note surfaces: tap-to-toggle checklist items on list and project notes, tap-to-edit numeric fields on log entries
- Spaces, notes, tags, date views, archive, and manual editor
- AI create-or-append routing
- Structured list and workout-log extraction
- Separate optional generated expansion block
- Processing receipts, Review queue, correction, and undo
- Full-text, date, type, and semantic search
- Revision history for AI and manual edits
- Data export and account deletion
- Bring-your-own-key: user-supplied OpenAI or Anthropic API key, encrypted at rest, with model-effort settings
- Dark-first visual system with accessible token architecture
- Shared backend, contracts, auth, database, search, and AI workflow

### 5.2 Explicit non-goals for MVP

- Real-time multi-user collaboration
- Public publishing
- Obsidian plugin compatibility
- Arbitrary nested databases, formulas, rollups, cross-table relations, or database views
- Canvas or graph visualization
- PDF research ingestion
- Web browsing or factual research on the user's behalf
- Calendar, email, or task-manager integrations
- Automatic reminders and notifications based on inferred intent
- Push notifications; processing receipts surface in-app only in MVP, and a capture whose receipt is never seen still lands safely and appears in Today
- Handwriting recognition
- Images and file attachments
- Continuous background agent behavior
- Fully local inference
- End-to-end encryption claims
- Billing and team administration

### 5.3 Candidate v1.1 additions

- Voice recording and transcription
- Share-sheet text and URL capture
- Home-screen quick-capture widget
- User-defined note templates, including templates with checkbox, number, and single-select input fields
- `table` note type: typed columns (text, number, checkbox, date, single-select), tap-to-edit cells, row operations, sort, and CSV export — no formulas, relations, or views
- Interactive workout plans on the `log` type: a planned session the user ticks through set by set, with per-set numeric quick-entry and optional rest timers
- Offline toggling and field edits for cached notes, synced through the outbox with conflict handling
- Reminder extraction with explicit confirmation
- Private, manual-only notes excluded from AI
- Import from Apple Notes, Google Keep, Markdown folders, and Obsidian
- Saved search views

### 5.4 Later possibilities

- On-device classification for common routes
- Optional local-only vault
- Calendar and health integrations with narrow permissions
- Photo and receipt capture
- Shared household shopping and planning spaces
- Plugin or automation API

## 6. Information Architecture and UX

### 6.1 Mobile navigation

Use a five-destination bottom navigation:

1. `Today`
2. `Notes`
3. central `Capture` action
4. `Review`
5. `Search`

`Settings`, `Archive`, `Routing rules`, and account controls live behind the profile button. The capture action opens a focused composer rather than switching to a permanent tab screen.

Mobile has no dedicated Inbox tab. Inbox captures surface in two places: a `Needs a home` section at the top of `Today`, and inside `Review` when they carry suggested destinations. The web rail keeps a dedicated `Inbox` entry because desktop has room for it. Both surfaces read from the same underlying state: a capture whose processing status is `inbox`.

### 6.2 Web navigation

Use a compact left rail:

- Today
- Inbox
- Notes
- Spaces
- Review
- Search
- Archive
- Settings

The center pane shows the active note or view. A narrow optional right inspector shows routing history, backlinks, source captures, and note properties. Do not make the inspector necessary for ordinary editing.

### 6.3 Today

Today is the default landing view. It contains:

- a persistent capture field
- today's captures and processing state
- a `Needs a home` section for Inbox captures awaiting a destination
- notes updated today
- unresolved Review items
- active lists, such as today's Shopping list, with tappable checkboxes inline

It is a chronological operational view, not a mandatory daily journal.

### 6.4 Notes

The Notes screen provides manual navigation:

- pinned notes
- recent notes
- spaces
- note types
- all notes

On mobile, opening a note shows a clear back path and a compact breadcrumb such as `Health / Workouts / Aug 30`. On web, the hierarchy remains visible in the rail.

### 6.5 Capture composer

The text field opens ready for input. The default flow is:

1. Type or paste.
2. Tap Save or press the submit key.
3. Receive an immediate `Saved` acknowledgement.
4. Dismiss the composer while processing continues.
5. Receive an in-app receipt when organization completes.

Optional controls can set an explicit destination, mark a capture private, or disable expansion. They must not be required for the common path.

### 6.6 Processing receipt

A receipt is a compact event, not a chat response:

```text
Added 3 items to Shopping / Aug 30

milk
spinach
batteries

[Open] [Move] [Undo]
```

If the system created a note, say so. If it generated an expansion, identify the generated block. If it is uncertain, show at most three suggested destinations plus `New note`.

### 6.7 Review

Review is an exception queue, not required daily maintenance. It contains:

- low-confidence destinations
- conflicts caused by concurrent edits
- failed organization jobs
- proposed merges or duplicate notes
- optional generated expansions waiting for acceptance

The empty state should explain that captures still remain safely in the Inbox.

### 6.8 Manual editor

The MVP editor supports:

- title
- Markdown-style paragraphs
- headings
- bullet and numbered lists
- checklists
- quotes
- inline links
- simple tags and note links
- undo and redo

Avoid a custom block editor in the first milestone. Use revision checks for writes and add a richer editor only when the cross-platform behavior is proven. The canonical content source differs by note type; Section 6.9 and Section 12.1 define the rule.

### 6.9 Interactive typed note surfaces

A note type is not only a routing label. Each type renders an interaction surface appropriate to its data, so the note is usable in place rather than read-only output of the AI pipeline:

- **`list`:** every item renders with a tappable checkbox. Toggling an item is a first-class typed operation, not a hand-edit of Markdown syntax. Checked items collapse into a `Completed` group, a fully checked list can be marked complete, and completing a list updates the open-state signal that candidate retrieval already uses.
- **`log`:** each entry renders its extracted fields as compact editable values. For a workout entry, exercise name is text, and weight, repetitions, and sets are numeric fields. Tapping a numeric value opens the platform numeric keypad with plus and minus steppers; the most recent prior entry for the same exercise pre-fills as a placeholder so logging a repeat set takes one or two taps. Field edits update `structured_data` and re-render the readable entry.
- **`project`:** checklist blocks inside a project note behave exactly like `list` items, including toggling and completion state.
- **`generic` and `principle`:** standard Markdown editing. Checklists authored with checkbox syntax are tappable; no other interactive blocks exist for these types in MVP.

Interaction rules, which apply to every interactive control:

1. Every interactive edit goes through the same typed-operation, expected-revision, mutation, and undo pipeline that AI organization uses. A checkbox toggle produces a mutation with an inverse, exactly like an AI append, so receipts, history, and undo need no second code path.
2. Toggles and field edits apply optimistically in the UI and roll back visibly with a brief explanation if the server rejects the revision.
3. Checkboxes and numeric fields meet the 44-point touch-target minimum and are reachable by keyboard on web.
4. Interactive edits require a connection in MVP. Offline interactivity arrives with broader offline editing, not as silent local divergence; the offline outbox remains capture-only.
5. Screen readers announce state changes, such as `milk, checked, 2 of 5 remaining`.

### 6.10 First-run and cold start

A brand-new account has zero notes, so routing has no candidates. Define this experience explicitly rather than letting the empty state fall out of the pipeline:

- Onboarding offers, but does not force, a small set of starter spaces such as Shopping, Health, Mindset, and Projects. Declining leaves an empty library; nothing is silently pre-created.
- With an empty or sparse library, the expected decisions are `create_note` and `add_to_inbox`. The scoring policy must not hallucinate an append destination that does not exist, and the evaluation corpus includes empty-library and first-week cases.
- The first receipt teaches the loop: when the first capture creates a note, the receipt explains in one line that future related captures will land in the same note.
- Onboarding shows, and lets the user try, three example captures matching the flagship demonstration so the value is experienced within the first minute.

Interactive tables are not an MVP surface. A `table` note type is a v1.1 candidate with this shape: user-defined typed columns limited to text, number, checkbox, date, and single-select; tap-to-edit cells using the same typed-operation pipeline; row add, reorder, and archive; column sort; CSV export. Formulas, cross-table relations, rollups, and database views stay out of scope per Section 5.2 — the table type is a structured grid, not a spreadsheet. Interactive workout *plans* (a planned session the user ticks through set by set, with rest timers) are likewise deferred to v1.1 as a template feature layered on the `log` type.

## 7. Core User Flows

### 7.1 Shopping list

Input:

```text
shopping list milk, eggs, paper towels
```

Default behavior:

1. Save the exact capture.
2. Detect explicit list intent and the Shopping alias.
3. Find an open Shopping list for the user's local date.
4. If none exists, create `Shopping / Aug 30` inside the `Shopping` space.
5. Add normalized, unchecked items while preserving the raw source. The server assigns each item a stable item ID.
6. Return a receipt.

In the store, the user opens the list and taps each item's checkbox as they pick it up. Each toggle is a typed operation that creates a revision and syncs, so the same list on the web app shows live progress. Checked items collapse into `Completed`.

Later input:

```text
add bananas
```

Candidate selection should prefer the recent open Shopping list only if the phrase, recent context, and prior user behavior support that choice. Otherwise, keep it for Review. The user can switch the preference from daily shopping notes to one living Shopping note.

### 7.2 Workout log

Input:

```text
bench 135 x 8, 145 x 6, 155 x 4; incline dumbbell 45 x 10 for 3 sets
```

Default behavior:

1. Route to today's workout log.
2. Preserve the raw text.
3. Extract exercise name, weight, repetitions, and sets into `structured_data`.
4. Render a readable entry in the note with each numeric field editable in place: a mistyped `145` becomes `155` through a tap and stepper, not a text edit.
5. Offer, but do not silently insert, a short summary or next-workout suggestion.

The product must avoid medical conclusions and should not invent missing units, exercise variations, or personal records.

### 7.3 Principle or mindset note

Input:

```text
Roosevelt method: telling people that you can do it and then later figuring out how to do it
```

Default behavior:

1. Route to `Mindset / Principles` if that destination is a strong match.
2. Store the exact user-authored statement.
3. Optionally propose a label such as `public commitment` or `accountability` in a generated block.
4. Do not validate the attribution, present it as historical fact, or rewrite the user's idea as a quotation.

### 7.4 Ambiguous capture

Input:

```text
get batteries
```

Possible meanings include a shopping item, a task, or a project supply. If deterministic signals do not separate the candidates, save it to Inbox and ask:

```text
Where should this go?
[Shopping] [Tasks] [Garage project] [New note]
```

The correction becomes evidence for later routing. It does not automatically become a universal rule after one ambiguous example. `Tasks` in this prompt is an ordinary user note of type `list`, not a separate task subsystem; the five note types are the complete type vocabulary in MVP.

### 7.5 Manual update

The user opens `Notes`, selects `Mindset`, opens `Principles`, edits the text, and saves. The server creates a new revision. A concurrent AI job that was based on the older revision must re-plan or enter Review; it cannot overwrite the manual edit.

### 7.6 Undo

Undo validates that the note has not changed incompatibly since the mutation. If safe, it applies the stored inverse mutation and creates a new revision. If later edits depend on the generated block, show a focused diff and let the user remove only the affected material.

## 8. Domain Model

Use stable product terms in code and copy.

### Capture

The original user submission. It has a client-generated idempotency key, source device, local timestamp, server timestamp, content, privacy mode, and processing state.

### Note

A living document with a stable ID, title, note type, space, canonical Markdown body, structured metadata, and current revision.

### Note type

One of:

- `generic`
- `list`
- `log`
- `principle`
- `project`

Types guide rendering and extraction but do not lock the user out of editing.

### Note item

An addressable unit inside a `list` or `log` note: a checklist item or a log entry. It has a stable server-assigned ID, ordinal, text or typed fields, checked state where applicable, and a link to the capture that created it. Typed operations reference items by ID, which keeps toggles, field edits, and undo unambiguous across revisions.

### Space

A manually visible top-level grouping such as Shopping, Health, Mindset, or Projects. Spaces may contain subspaces after MVP, but deep nesting is discouraged.

### Organization plan

A validated model output describing zero or more allowed operations against server-provided candidates.

### Mutation

The transactional application of one organization plan. It records the before revision, after revision, inserted content identifiers, inverse operation, and audit metadata.

### Routing rule

A deterministic user-owned rule evaluated before model inference. Examples:

- exact prefix `workout:` routes to the current Workout log
- phrase `shopping list` routes to the Shopping space
- alias `Roosevelt method` suggests the Principles note

### Review item

An unresolved decision or failure that needs user input. The capture remains available regardless of Review state.

### Generated block

Model-generated text stored with explicit provenance and acceptance state. It is not merged invisibly into the user's source text.

## 9. AI Organization System

### 9.1 Pipeline

```text
client capture
  -> durable capture row
  -> durable organization workflow
  -> deterministic rule evaluation
  -> candidate retrieval
  -> structured model plan
  -> schema and ownership validation
  -> calibrated policy decision
  -> transactional note mutation or Review item
  -> search re-index
  -> receipt event
```

### 9.2 Candidate retrieval

Do not send the entire note library on every request. Build a bounded candidate set using:

1. explicit routing rules and aliases
2. currently pinned or active notes
3. note type inferred from syntax
4. recency and open-state signals
5. PostgreSQL full-text and trigram matches
6. vector similarity against note summaries and recent chunks
7. prior confirmed destinations for similar captures

Send only the candidate IDs, safe summaries, relevant headings, latest snippets, and note metadata required for the decision.

### 9.3 Structured organization schema

The model returns a strict JSON schema similar to:

```json
{
  "schemaVersion": 1,
  "captureKind": "list_items",
  "decision": "append_to_note",
  "destination": {
    "candidateId": "note_01...",
    "newNote": null
  },
  "operations": [
    {
      "type": "append_list_items",
      "section": "Open items",
      "items": ["milk", "spinach", "batteries"]
    }
  ],
  "generatedExpansion": null,
  "reasonCodes": ["explicit_shopping_intent", "open_daily_list"]
}
```

Allowed decisions:

- `append_to_note`
- `create_note`
- `add_to_inbox`
- `needs_review`

Allowed operations are implemented and validated by the domain layer. The first release should support:

- append raw capture
- append paragraphs
- append list items
- append a log entry
- update typed structured data
- add tags from an allowed set
- add a relation to an allowed note ID
- create a note with a validated title and type

No arbitrary search-and-replace or delete operation is exposed to the model in MVP.

The same operation vocabulary serves user-initiated interactions. `toggle_item_checked`, `update_log_field`, `edit_item_text`, and `remove_item` are user-only operations: they run through identical schema validation, revision preconditions, transactional mutation, and undo machinery, but they are never granted to the model in MVP. One validated operation layer, two callers.

### 9.4 Scoring and behavior bands

The server computes a routing score from features that have evaluation evidence. Initial features may include:

- explicit user rule match
- explicit capture prefix or destination mention
- exact candidate alias
- note type compatibility
- destination recency
- open-list or same-day log state
- semantic similarity and gap to the second candidate
- prior accepted and corrected decisions
- model reason-code consistency

Threshold values are not chosen by intuition and hard-coded forever. Tune them against a versioned evaluation set. The default product behavior is:

- **Auto:** evidence is strong enough to apply and show an Undo receipt.
- **Review:** plausible destination, but applying could pollute the wrong living note.
- **Inbox:** no useful candidate or an invalid plan.

Users may choose a more cautious mode where every AI route waits for approval.

### 9.5 Expansion policy

There are three distinct behaviors:

1. **Formatting:** convert clear list or log syntax without changing meaning. May be automatic.
2. **Organization:** choose a destination and note type. May be automatic when calibrated.
3. **Expansion:** add interpretation, summary, suggestion, or context. Generated and separate by default.

Do not combine these into one opaque "AI improved your note" operation.

### 9.6 Personalization

Personalization sources, in priority order:

1. explicit routing rules
2. pinned aliases and active-note settings
3. accepted or corrected prior decisions
4. aggregate feature weights derived from the user's history
5. generic model inference

Never train a global model on private note content without a separate explicit program, consent design, privacy review, and legal review. MVP personalization is retrieval and rule based.

### 9.7 Model and provider boundary

Create an `OrganizationModel` port owned by the domain-facing AI package, with a provider registry behind it holding two adapters:

- **OpenAI adapter:** Responses API with strict Structured Outputs and `store: false`.
- **Anthropic adapter:** Messages API with a forced tool call whose input schema is the organization schema, which yields strictly validated JSON.

Keep model IDs and per-effort model tiers in versioned server configuration so routing evaluation can select current cost-appropriate models per provider without changing domain code.

The credential used per request resolves in this order: the user's own stored key for their selected provider (bring-your-own-key), otherwise the application's key for the default provider. BYOK requests bypass the application's per-user model budget, since the spend is the user's, but keep all rate limits, payload caps, and validation. An invalid or revoked user key sends captures to Inbox with `provider_key_invalid` and a settings banner; there is no silent fallback to the application key unless the user explicitly enables fallback.

User-facing effort settings shape each call (full mapping in `AI_ROUTING_SPEC.md`): routing effort selects the model tier and candidate budget; expansion style controls whether and how long generated expansions may be.

Send the minimum candidate context. Record token counts, latency, provider, prompt version, schema version, and response status, but keep raw note text and API keys out of all logs.

Both provider APIs support schema-constrained output; reconfirm exact SDK and model behavior against current official documentation when implementation starts.

### 9.8 Prompt injection and untrusted note content

Treat every capture and note snippet as untrusted data. The model prompt clearly delimits it and grants no tools. Model output is data that must pass:

- strict JSON schema validation
- known candidate ID validation
- user ownership validation
- operation allowlist validation
- length and item-count limits
- note revision preconditions
- deterministic policy checks

Prompt text cannot authorize a database operation.

### 9.9 Evaluation corpus

Maintain versioned cases that cover:

- empty-library and sparse first-week libraries
- same-day list continuation
- cross-day list behavior
- workouts with varied shorthand
- generic journal entries
- mindset and principle fragments
- project updates
- ambiguous tasks versus shopping items
- duplicate or near-duplicate notes
- adversarial instructions inside captures
- wrong candidate IDs
- stale revisions
- private notes that must never enter model context
- multilingual and code-switching cases before claiming support

Each case includes expected candidate set, permitted decisions, forbidden destinations, required preservation, and whether auto-apply is allowed.

## 10. System Architecture

### 10.1 Selected stack

- **Monorepo:** pnpm workspaces plus Turborepo
- **Web:** Next.js App Router, React, TypeScript, deployed to Vercel
- **Mobile:** Expo, React Native, Expo Router, EAS development and store builds
- **API:** versioned Next.js route handlers in the web deployment for MVP
- **Auth, database, storage, realtime:** Supabase
- **Database:** PostgreSQL with Row Level Security and `pgvector`
- **Durable background processing:** Vercel Workflows behind an internal `OrganizationJobRunner` port
- **AI:** official OpenAI JavaScript SDK, Responses API, strict Structured Outputs
- **Validation:** Zod at application boundaries plus database constraints
- **Web styling:** Tailwind CSS with semantic CSS variables
- **Native styling:** NativeWind or platform StyleSheet using the same semantic tokens, chosen after a prototype
- **Server data access:** generated Supabase types plus reviewed SQL functions for transactional mutations
- **Client data fetching:** TanStack Query with a generated typed API client
- **Local mobile persistence:** Expo SQLite for capture outbox and cached read models
- **Web offline draft storage:** IndexedDB
- **Testing:** Vitest or Node test runner for packages, Playwright for web, Maestro for device flows, SQL tests for RLS and database functions
- **Observability:** Vercel logs and traces plus Sentry for client and server errors, with note content redacted

Pin actual versions during bootstrap after verifying current compatibility. Do not copy version numbers from this planning date into a future lockfile without checking official release guidance.

### 10.2 Why two clients

Expo Router can target web, but this product benefits from two optimized surfaces:

- The native app needs offline capture, keyboard behavior, haptics, share sheet, widgets, notifications, and app-store delivery.
- The hosted web product needs a strong desktop editor, responsive split-pane navigation, marketing routes, metadata, and Vercel-native APIs.

Share domain logic and visual tokens. Do not force every web editor interaction through React Native Web or duplicate the backend.

### 10.3 Logical architecture

```text
Expo mobile app                       Next.js web app
  | local outbox                        | web capture/editor
  |                                     |
  +------------ versioned HTTPS API ----+
                        |
                 auth and rate limits
                        |
              capture and note services
                  |              |
          Supabase Postgres      durable organization workflow
          RLS, search, vector        |
                  |                  +-> OpenAI structured plan
                  |                  +-> validated mutation transaction
                  |
          realtime receipt events
                        |
                both clients refresh
```

### 10.4 Request path

1. Client creates a ULID and stores the capture locally.
2. Client sends `POST /api/v1/captures` with the idempotency key.
3. Server validates auth, limits, content size, and workspace ownership.
4. Database transaction inserts the capture and workflow record once.
5. API returns `202 Accepted` with the capture and job status.
6. Durable workflow selects candidates, calls the model if required, validates, applies, and emits a receipt.
7. Clients receive a realtime change or poll the status endpoint.
8. The local outbox marks the capture synced only after server acknowledgement.

### 10.5 Why durable workflows

Organization includes database reads, an external model call, validation, a conditional write, indexing, and receipt emission. It must survive deployment, timeout, and transient provider failure. Vercel Workflows is the selected hosted adapter because the web and API already deploy to Vercel. Keep the port narrow so Supabase Queues, another workflow service, or a self-hosted worker can replace it if operational evidence requires a change.

## 11. Repository Layout

```text
soft-index/
  apps/
    web/                    # marketing, authenticated web app, API routes, workflows
    mobile/                 # Expo iOS and Android application
  packages/
    contracts/              # versioned API schemas and DTOs
    domain/                 # notes, captures, routing, revisions, undo
    ai-routing/             # candidates, prompt schemas, scoring, model port
    api-client/             # typed client used by web and mobile
    database/               # migrations, generated types, SQL functions, RLS tests
    sync/                   # outbox, idempotency, cursors, reconciliation
    search/                 # full-text, vector, ranking contracts
    design-tokens/          # color, type, spacing, motion, z-index, icon rules
    test-fixtures/          # deterministic users, notes, captures, AI cases
  supabase/
    migrations/
    seed.sql
    tests/
  docs/
    README.md               # documentation index and maintenance rules
    BUILD_PLAN.md
    GLOSSARY.md
    PRODUCT_REQUIREMENTS.md
    AI_ROUTING_SPEC.md
    DATA_MODEL.md
    SECURITY_AND_PRIVACY.md
    OPERATIONS_TEST_PLAN.md
    DESIGN_SYSTEM.md
    OPEN_QUESTIONS.md
    decisions/              # architecture decision records
  scripts/
  .github/workflows/
  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
```

Dependency direction:

```text
contracts <- domain <- application services <- web/mobile adapters
                         ^
                         |-- database adapter
                         |-- workflow adapter
                         |-- OpenAI adapter
                         |-- search adapter
```

`domain` must not import Next.js, Expo, Supabase, Vercel, or the OpenAI SDK.

## 12. Data Model

Every user-owned table includes `user_id`, timestamps, and database constraints. Enable RLS on every exposed table and test both allowed and cross-user-denied cases.

### 12.1 Core tables

#### `profiles`

- `id` references the auth user
- display name
- timezone and locale
- organization mode: cautious, balanced, or automatic
- expansion preference
- AI provider mode: app default, or bring-your-own-key per provider
- routing effort and expansion style settings
- created and updated timestamps

#### `user_provider_keys`

- `id`
- `user_id`
- provider: openai or anthropic
- encrypted key reference (Supabase Vault secret ID or app-layer AES-256-GCM ciphertext; never plaintext)
- key last-four for display
- status: active, invalid, revoked
- validated and created timestamps

The ciphertext or vault reference is not readable by clients; decryption happens only inside the organization workflow. Full custody rules live in `SECURITY_AND_PRIVACY.md`.

#### `spaces`

- `id`
- `user_id`
- optional `parent_id`
- `name`
- stable slug
- sort key
- archived timestamp

Limit nesting depth in application validation for MVP.

#### `notes`

- `id`
- `user_id`
- `space_id`
- `type`
- `title`
- `body_markdown`
- `structured_data jsonb`
- `current_revision`
- local-date key for daily notes when applicable
- open or completed state for lists and projects
- pinned, private, archived, and deleted timestamps
- created and updated timestamps

Use a unique partial index for note identities that must be singular, such as one daily Shopping list per user and local date.

Canonical content source by note type:

- `generic`, `principle`, `project` prose: `body_markdown` is canonical; `structured_data` holds metadata only. Checklist blocks inside `project` notes are the exception and follow the structured rule below.
- `list` and `log`: `structured_data` is canonical for items and entries — stable item IDs, text, checked state, typed numeric fields, and source capture ID. `body_markdown` is a deterministic projection regenerated inside the same transaction as every structured mutation; it feeds search chunks, export, and fallback rendering.
- A manual free-text edit that touches a projected region re-parses into structured items when the edit is unambiguous, such as adding or rewording plain list lines. An ambiguous structural edit creates a Review item as a structure conflict instead of guessing.

`structured_data` payloads carry their own `schemaVersion` per note type so extraction formats can evolve without breaking old notes.

#### `note_revisions`

- `id`
- `note_id`
- revision number
- source: manual, organization, undo, import
- full snapshot or storage-efficient patch
- content hash
- actor and mutation ID
- created timestamp

Start with full snapshots for correctness and simplicity. Revisit patch storage only after real size metrics justify it.

#### `captures`

- `id`, generated by the client
- `user_id`
- source: mobile, web, share sheet, import
- device ID
- raw text
- privacy mode
- client-created timestamp and timezone
- server-received timestamp
- processing status
- last error code
- deleted timestamp

#### `organization_jobs`

- `id`
- `capture_id`
- state
- attempt count
- workflow provider ID
- prompt, model, and schema versions
- started and completed timestamps
- safe error code

#### `organization_decisions`

- `id`
- `capture_id`
- candidate manifest
- deterministic signals
- model plan after validation
- computed behavior band
- selected destination
- reason codes
- created timestamp

Keep user text out of ordinary decision telemetry. The capture already owns the content.

#### `note_mutations`

- `id`
- decision ID
- note ID
- before revision
- after revision
- applied operation list
- inverse operation or before snapshot reference
- undone timestamp

#### `generated_blocks`

- `id`
- `user_id`
- note ID
- decision ID that produced it
- generated content
- kind: summary, interpretation, suggestion, label
- state: proposed, accepted, rejected
- model and prompt versions
- created and resolved timestamps

This table backs the Generated block domain entity in Section 8. A proposed block renders in the note as a clearly marked pending element; accepting it keeps it visible with provenance, rejecting it removes it. Rejected blocks are retained briefly for undo, then hard-deleted on the published retention schedule.

#### `capture_note_links`

- capture ID
- note ID
- mutation ID
- relation type
- inserted content marker

#### `routing_rules`

- `id`
- `user_id`
- enabled flag
- rule type and normalized condition
- destination note or space
- priority
- source: explicit or correction-suggested
- created and updated timestamps

An inferred pattern is not activated as a rule without an explicit confirmation unless it is a narrow alias learned through repeated accepted corrections and the product makes that behavior clear.

Aliases referenced by search and candidate retrieval are routing rules with rule type `alias`; there is no separate alias store.

#### `tags` and `note_tags`

- `tags`: `id`, `user_id`, normalized unique name, created timestamp
- `note_tags`: note ID, tag ID, source: manual or organization, mutation ID when AI-applied, created timestamp

The AI `add tags from an allowed set` operation may only reference existing tag IDs from this table; it cannot create tags in MVP.

#### `note_links`

- `id`
- `user_id`
- from note ID and to note ID
- link type: reference, related
- source: manual or organization
- mutation ID when AI-applied
- created timestamp

This table backs the `add a relation to an allowed note ID` operation, inline note links in the editor, and the backlinks list in the web inspector.

#### `review_items`

- `id`
- `user_id`
- `capture_id`
- type
- candidate choices
- state
- resolution
- created and resolved timestamps

#### `note_chunks`

- `id`
- note ID and revision
- ordinal and text hash
- full-text search vector
- embedding vector
- created timestamp

Embeddings are derived data. Deleting a note must delete its chunks.

#### `feedback_events`

- decision ID
- action: accepted, moved, undone, expansion accepted, expansion rejected
- old and new destination
- optional reason code
- created timestamp

### 12.2 Transactional requirements

- Capture creation and job creation commit together.
- An organization mutation checks the note revision it planned against.
- Mutation, new revision, note update, capture link, decision status, and receipt event commit together.
- Duplicate capture submissions return the original result.
- A stale revision never overwrites a newer manual revision.
- Search indexes may update asynchronously, but their source revision is recorded so stale chunks are ignored.

## 13. API Contract

Use `/api/v1` from the start. Publish OpenAPI from shared Zod schemas or generate both from a single reviewed source.

### Captures

- `POST /api/v1/captures`
- `GET /api/v1/captures` with date, status, and pagination filters, backing Today and Inbox views
- `GET /api/v1/captures/:id`
- `GET /api/v1/captures/:id/receipt`
- `POST /api/v1/captures/:id/retry`
- `DELETE /api/v1/captures/:id`

Deleting a capture removes the capture itself. Note content it produced stays in the note, with the provenance link marked as source-removed; the confirmation dialog offers to also remove the inserted blocks, which runs as an ordinary undoable mutation.

### Notes

- `GET /api/v1/notes`
- `POST /api/v1/notes`
- `GET /api/v1/notes/:id`
- `PATCH /api/v1/notes/:id` with expected revision
- `POST /api/v1/notes/:id/operations` with expected revision, for typed interactive operations: toggle an item, update a log field, edit or remove an item
- `POST /api/v1/notes/:id/move`
- `POST /api/v1/notes/:id/archive`
- `GET /api/v1/notes/:id/revisions`
- `POST /api/v1/notes/:id/restore`

### Spaces and tags

- `GET /api/v1/spaces`
- `POST /api/v1/spaces`
- `PATCH /api/v1/spaces/:id`
- `POST /api/v1/spaces/:id/archive`
- `GET /api/v1/tags`
- `POST /api/v1/tags`
- `DELETE /api/v1/tags/:id`

### Review and undo

- `GET /api/v1/review`
- `POST /api/v1/review/:id/resolve`
- `POST /api/v1/mutations/:id/undo`
- `POST /api/v1/decisions/:id/correct`

### Search and sync

- `GET /api/v1/search`
- `POST /api/v1/sync/push`
- `GET /api/v1/sync/pull?cursor=`

### Rules and settings

- `GET /api/v1/routing-rules`
- `POST /api/v1/routing-rules`
- `PATCH /api/v1/routing-rules/:id`
- `DELETE /api/v1/routing-rules/:id`
- `GET /api/v1/me`
- `PATCH /api/v1/me/settings` for organization mode, AI provider mode, routing effort, expansion style, timezone, and locale
- `GET /api/v1/me/provider-key` returning provider, key last-four, and validation status only — never the key
- `PUT /api/v1/me/provider-key` validating the key with a minimal test call before encrypted storage
- `DELETE /api/v1/me/provider-key`
- `GET /api/v1/me/export`
- `DELETE /api/v1/me`

Every mutation accepts an idempotency key. Errors use stable machine codes and safe human messages.

## 14. Offline Capture and Sync

### 14.1 Mobile outbox

The mobile client writes each capture to Expo SQLite before showing success. The row includes:

- client ULID
- raw content
- client timestamp and timezone
- privacy and explicit destination options
- sync state
- retry count and last safe error

A background sync loop sends pending rows with bounded exponential backoff. App foregrounding, connection restoration, and manual retry can wake the loop.

### 14.2 Server authority

The server is authoritative for organization, notes, revisions, and receipts. The local client may optimistically show a pending capture but does not predict an AI destination as final.

### 14.3 Conflict policy

- Manual edits win over plans based on older revisions.
- AI append operations may re-plan once against the newest revision.
- A second conflict goes to Review rather than looping.
- Two identical client submissions with the same idempotency key produce one capture.
- Two distinct captures with identical text remain distinct events.

### 14.4 Web offline behavior

The web app stores unsent composer text and pending submissions in IndexedDB. Full offline note-library access is not required for MVP, but losing a browser connection after typing must not lose the draft.

## 15. Visual and Interaction Direction

### Design read

A calm personal utility, dark-first and mobile-first, with the hierarchy of a good editor rather than the density of a research dashboard. It should feel private, grounded, and fast. Avoid AI-purple gradients, glowing agent avatars, chat bubbles as the primary UI, and decorative knowledge graphs.

Working design dials:

- `DESIGN_VARIANCE: 5`
- `MOTION_INTENSITY: 3`
- `VISUAL_DENSITY: 5`

### 15.1 Design-first execution protocol

Complete this sequence before framework and database bootstrap:

1. **Journey map:** diagram the paths from idea to durable capture, pending organization, receipt, correction, Review, manual edit, search, and undo.
2. **Information architecture:** finalize the mobile bottom navigation, web rail, note hierarchy, breadcrumbs, and the relationship between Today, Inbox, Notes, Spaces, and Review.
3. **Low-fidelity mobile wireframes:** design the smallest phone viewport first for Today, Capture, processing, receipt, Notes, note editor, Review, Search, offline, and error states.
4. **Low-fidelity desktop wireframes:** adapt the same tasks to a left-rail and editor layout. Do not merely stretch the mobile screen.
5. **Dark visual system:** define semantic color, type, spacing, radius, icon, motion, focus, and elevation tokens with contrast evidence.
6. **High-fidelity mobile screens:** create the complete flagship flow, including keyboard-open capture, optimistic Saved state, background processing, receipt, Move, and Undo. Include the interactive surfaces: checking items off a list one-handed and tap-to-edit numeric fields on a workout entry.
7. **High-fidelity web screens:** create Today, the manual Notes library, the editor, Search, and Review at laptop and wide-desktop sizes.
8. **Clickable prototype:** connect the flagship shopping, workout, mindset, ambiguous-routing, manual-edit, and undo flows using realistic copy.
9. **Usability check:** test whether a person can capture without a filing decision, understand where content went, correct a wrong route, and find the manual editor without explanation.
10. **Design handoff:** record component anatomy, responsive rules, platform differences, empty/loading/offline/error states, and accessibility annotations in `DESIGN_SYSTEM.md`.

Apply the taste-skill preflight to the marketing surface and the relevant product-design rules to the application. The product UI is a daily utility, so prioritize clarity over landing-page spectacle. Do not use fake dashboard screenshots, generic three-card layouts, decorative glows, unexplained motion, or a chat-first shell.

Design approval means the core loop is coherent across mobile and web. It does not mean every future settings page is polished before engineering starts.

### Theme

Dark is the default product expression. Build semantic tokens that can support a future light theme without rewriting components.

Suggested starting palette, subject to contrast testing:

- canvas: `#0B0D0C`
- primary surface: `#121512`
- raised surface: `#191D1A`
- border: `#2A302C`
- primary text: `#E8EBE7`
- secondary text: `#A5AEA7`
- accent: muted sage `#8FB49A`
- danger: muted coral chosen to pass contrast requirements

Use one accent across the product. Avoid pure black and pure white.

### Typography and icons

- Geist Sans or another compact, highly legible sans for UI
- Geist Mono only for timestamps, extracted measurements, and technical metadata
- Phosphor icons with one global weight
- no emoji as navigation icons

### Shape system

- containers: 12px radius
- inputs: 10px radius
- buttons: 10px radius
- circular icon buttons only when the hit target and meaning are clear

### Motion

Motion communicates state:

- composer submission compresses into a pending capture row
- receipt enters when processing finishes
- undo visibly restores the prior content
- note moves use a short layout transition

Honor reduced motion. Do not use perpetual AI shimmer after loading completes.

### Accessibility

- WCAG AA minimum, AAA target for primary reading text
- minimum 44 by 44 point touch targets
- Dynamic Type and font scaling on mobile
- keyboard navigation and visible focus on web
- screen-reader labels and live announcements for Save, processing, receipt, error, and undo
- reduced motion and reduced transparency behavior
- color never serves as the only processing-state indicator
- loading skeletons match the actual layout

### Core UI states

Every primary surface must specify:

- loading
- empty
- offline
- queued
- processing
- completed
- needs review
- failed with retry
- partial sync
- deleted or restored

## 16. Security and Privacy

### 16.1 Trust boundaries

Untrusted inputs include:

- client requests
- note and capture content
- model output
- imported Markdown
- deep links and share-sheet payloads

Trusted enforcement points include:

- API authentication and ownership validation
- database grants, constraints, and RLS
- organization-plan schema validation
- transactional mutation functions
- workflow idempotency

### 16.2 Authentication and authorization

- Supabase Auth issues the user session.
- API routes verify the token and derive the user ID server-side.
- Every database table exposed through the Data API has RLS and least-privilege grants.
- Cross-user access tests run in CI.
- Service-role credentials stay server-side and are not used for routine user CRUD when a user-scoped path is available.
- Administrative operations require separate reviewed functions and audit records.

### 16.3 AI privacy modes

Provide two note modes:

1. `AI-assisted`: relevant bounded content may be sent to the configured model provider for routing and expansion.
2. `Private manual`: content is excluded from model candidate retrieval, embeddings, generated summaries, and AI search.

The product must explain that AI-assisted cloud notes are not end-to-end encrypted from the application server. `store: false` controls provider-side response storage behavior but is not a substitute for a complete privacy policy or data-processing disclosure.

### 16.4 Secrets and logging

- OpenAI, Anthropic, and Supabase application secrets exist only in server or build-secret stores.
- User-supplied provider keys are encrypted at rest, decrypted only inside the workflow, displayed only as last-four, and never logged or returned to clients.
- Do not log request bodies, note text, capture text, generated text, auth tokens, magic links, or service keys.
- Logs use user-independent trace IDs or a one-way pseudonymous identifier.
- Sentry breadcrumbs and replay features are configured to redact text fields.
- Production database access uses reviewed roles and rotation procedures.

### 16.5 Abuse and cost controls

- per-user and per-IP capture rate limits
- rate limits on typed note operations and all other mutation endpoints, tuned so rapid legitimate toggling is never blocked
- maximum capture length and candidate context size
- model token and request budgets
- bounded retry attempts
- queue age and depth alerts
- circuit breaker that preserves captures in Inbox when the provider is unavailable
- hashed safety identifier when required by the provider and appropriate under the privacy design

### 16.6 Export and deletion

Export contains:

- Markdown files by space and note
- JSON manifest with IDs, types, dates, tags, source captures, and links
- routing rules
- optional revision history

Deletion removes active rows, derived chunks, embeddings, queued work, and provider-facing pending artifacts. Publish backup-retention timing and test deletion reconciliation.

## 17. Search

### MVP search stack

Use hybrid ranking:

1. exact title and alias match
2. PostgreSQL full-text rank
3. trigram similarity for spelling variation
4. vector similarity
5. recency and pinned-note boost
6. note-type and space filters

Results display the matching snippet, note path, and date. AI answer generation over the library is not required. Search should return notes, not synthesize facts the user did not ask for.

### Indexing rules

- Each chunk records its source note revision.
- Query ignores chunks from older revisions.
- Private manual notes use local or permitted text search only and have no embedding.
- Index jobs are idempotent.
- Deletion and archive state propagate to search.

## 18. Testing and Evaluation

### 18.1 Unit tests

- capture validation and idempotency
- note type rules
- deterministic routing rules
- candidate ranking
- organization schema parsing
- operation allowlist
- revision conflict behavior
- inverse mutations and undo
- item ID stability across mutations
- toggle and field-edit operations, including idempotent repeat and stale-revision rejection
- Markdown projection determinism for list and log notes
- free-text re-parse versus structure-conflict classification
- local-date logic across time zones and daylight-saving transitions
- Markdown preservation
- privacy-mode filtering

### 18.2 Database tests

- RLS permits a user to access only owned data
- anonymous and cross-user writes fail
- unique daily-note constraints hold under concurrency
- capture and job insert atomically
- conditional revision mutation rejects stale writes
- delete cascades remove chunks and derived data
- export scope excludes other users

### 18.3 Contract tests

- mobile and web clients validate the same API fixtures
- server returns stable error codes
- old supported client schema versions remain compatible
- idempotent retries return the original capture and mutation

### 18.4 AI routing evaluation

Track at least:

- candidate recall
- exact destination accuracy
- note-type accuracy
- wrong auto-apply rate
- Review rate
- correction rate
- create-versus-append accuracy
- source-preservation failures
- invalid-plan rate
- latency and token cost by case type

Separate deterministic tests from stochastic model evaluations. Pin prompt, schema, candidate algorithm, and model configuration for a baseline. Run repeated samples where model variance matters.

### 18.5 End-to-end tests

Critical flows:

1. sign in on web and mobile
2. save a capture online
3. save a capture offline, restart the app, reconnect, and sync once
4. route a shopping list and append a second message
5. check off a shopping item on mobile and observe the change on web
6. route a workout log and correct a numeric field through tap-to-edit
7. send an ambiguous capture to Review
8. correct a destination and create a routing rule
9. undo an AI mutation
10. manually edit during an active organization job
11. search and open the updated note on the other client
12. export data
13. delete the account

### 18.6 Performance targets

Targets for the portfolio MVP:

- local capture acknowledgement feels immediate and does not wait for network or AI
- authenticated API acknowledgement p95 under 500 ms in the primary region, excluding cold-start outliers tracked separately
- typical organization receipt p95 under 8 seconds
- web LCP under 2.5 seconds for the authenticated shell on a representative connection
- web INP under 200 ms
- no capture loss in crash, retry, duplicate, and offline test matrices

Tune or revise targets from measured baselines. Do not hide failures by excluding slow successful jobs.

## 19. Observability and Cost Control

### Operational metrics

- capture acceptance count and error rate
- offline outbox age
- workflow queue depth and oldest age
- workflow attempts, failures, and dead letters
- organization latency by stage
- model latency, tokens, and estimated cost
- invalid plan rate
- auto, Review, and Inbox distribution
- correction and undo rates
- stale revision conflicts
- search indexing lag
- realtime delivery failures

### Product-behavior metrics

The go/no-go gates in Section 22 require product evidence, not only operational health. Instrument, with content excluded:

- captures per active user per day, and the share submitted without an explicit destination (Gate 1)
- auto, Review, and Inbox distribution trend over a user's first weeks (Gate 3)
- correction and undo rate trend after each correction, per user (Gate 4)
- repeat-mistake rate: identical correction applied more than once by the same user (Gate 4)
- week-two capture retention: users still capturing in their second week
- interactive engagement: share of list notes with at least one toggle and log notes with at least one field edit

### Tracing

One trace connects:

```text
capture ID -> workflow ID -> candidate manifest -> model response ID
           -> decision ID -> mutation ID -> note revision -> receipt ID
```

Trace metadata excludes note content.

### Cost strategy

- deterministic rules short-circuit the model
- bounded candidate context
- small structured-output model selected by evaluation for normal routes
- stronger model fallback only for allowed ambiguous cases if it measurably improves outcomes
- embeddings computed on changed chunks only
- no AI call for manual edits
- per-user daily budget with graceful Inbox fallback

## 20. Deployment and Operations

### Environments

- `local`: local Supabase stack, mock model adapter by default
- `preview`: isolated Supabase branch or project, Vercel preview, non-production AI budget
- `production`: protected Vercel and Supabase projects with separate secrets

Never point preview deployments at production user data.

### Web and backend

- Deploy `apps/web` to Vercel.
- Keep API routes and workflows in the same region as the primary database where practical.
- Protect internal workflow callbacks.
- Use migration checks before production promotion.
- Configure custom domain only after the working name passes review.

### Mobile

- Expo development builds for internal testing
- EAS preview channel for beta
- production iOS and Android builds after platform-specific privacy manifests, icons, screenshots, deep links, and deletion flows are complete
- runtime API environment pinned per build profile

### Database

- all schema changes through checked-in migrations
- production migrations run through CI with an explicit approval gate
- scheduled backups and a documented restore drill
- connection pooling configured for Vercel workloads
- vector indexes created only after representative data supports the selected index type and parameters

### CI checks

- formatting and lint
- strict TypeScript
- package-boundary test
- unit and contract tests
- migration lint and local apply-from-zero
- RLS tests
- deterministic mock-model scenarios
- web build
- Expo type and bundle checks
- Playwright critical path
- secret scanning and dependency audit

## 21. Milestones

Effort assumes one developer working part-time with AI assistance, including tests and documentation. Calendar time depends on native build and account setup. Do not trade milestone evidence for a promised date.

### Milestone 0: Design sprint and clickable prototype, 4-7 days

Deliver:

- journey map and finalized information architecture
- low-fidelity mobile and desktop wireframes
- dark-first semantic token sheet with contrast checks
- high-fidelity flagship mobile flow
- high-fidelity manual Notes, editor, Search, and Review web screens
- realistic loading, offline, processing, receipt, ambiguity, failure, and undo states
- clickable prototype for the shopping, workout, mindset, and ambiguous examples
- usability notes and resolved design decisions
- initial `DESIGN_SYSTEM.md`

Gate:

- a tester can capture without choosing a destination first
- a tester understands the routing receipt without an explanation
- Move, Review, manual edit, and Undo are discoverable
- the smallest supported phone layout works with the keyboard open
- desktop navigation fits on one line or one rail without ambiguous duplicate destinations
- contrast, focus, touch target, reduced-motion, and text-scaling requirements are annotated

### Milestone A: Repository and product contracts, 3-5 days

Deliver:

- monorepo bootstrap
- strict TypeScript and package boundaries
- local Supabase project
- shared IDs, schemas, errors, and time abstractions
- product requirements and initial design system documents
- deterministic fake organization model
- CI baseline

Gate:

- web and mobile shells compile
- packages test independently
- local database migrates from zero
- no production credentials are required for tests

### Milestone B: Manual notes vertical slice, 1-2 weeks

Deliver:

- authentication
- spaces and five note types
- create, read, edit, move, archive, search by text
- interactive checklist toggling on list and project notes through typed operations
- tags and note links
- revisions
- mobile and web navigation
- dark-first tokens and core states

Gate:

- a user can use the product as a normal synchronized notes app without AI
- checking an item off creates a revision, is undoable, and appears on the other client
- cross-user RLS suite passes
- manual edits survive refresh and cross-device access

### Milestone C: Durable capture and receipt, 1-2 weeks

Deliver:

- mobile SQLite outbox
- web IndexedDB draft and submission queue
- idempotent capture API
- durable workflow adapter with fake decisions
- processing status and receipts
- retry and failure states

Gate:

- offline capture survives app termination and syncs exactly once
- provider and workflow failures never lose the source capture
- a receipt can be observed on both clients

### Milestone D: AI create-or-append routing, 2-3 weeks

Deliver:

- candidate retrieval
- strict organization schema
- OpenAI adapter
- deterministic scoring policy
- create note, append raw text, list formatting, and log formatting
- Review queue
- evaluation harness

Gate:

- source-preservation suite has zero failures
- invalid model plans fail closed to Inbox or Review
- the golden routing set meets the selected auto-apply error threshold
- direct competitor examples do not require hard-coded demo branches

### Milestone E: Correction, undo, and personalization, 1-2 weeks

Deliver:

- correction flow
- mutation history and safe inverse operations
- editable routing rules
- bring-your-own-key management and model-effort settings
- duplicate-note suggestion
- generated expansion acceptance or rejection
- feedback metrics

Gate:

- every AI-applied mutation in scope can be undone or restored through revision history
- stale revisions cannot overwrite manual edits
- a correction affects later matching through visible rules or tested preference features

### Milestone F: Hybrid search and polish, 1-2 weeks

Deliver:

- full-text, trigram, and vector search
- note links and source-capture inspector
- tap-to-edit numeric fields on log entries with stepper quick-entry and prior-value placeholders
- accessibility pass
- loading, empty, offline, failure, and deleted states
- performance profiling
- export and account deletion

Gate:

- critical web and native accessibility flows pass
- search ignores stale and private embeddings
- export is human-readable and complete
- deletion reconciliation passes

### Milestone G: Portfolio release, 1-2 weeks

Deliver:

- Vercel production deployment
- internal mobile beta builds
- seeded demo account with clearly labeled synthetic data
- architecture diagram and demo video
- privacy policy, terms, security contact, and support path
- monitoring dashboards and restore drill
- launch-name decision

Gate:

- a fresh user can complete the flagship demonstration on mobile and inspect the same result on web
- CI, migrations, backups, alerts, and deletion flow have recorded evidence
- the README distinguishes implemented features from roadmap items

### Credible schedule

- Portfolio MVP through Milestone D: approximately 7-11 part-time weeks
- Strong personal beta through Milestone F: approximately 11-16 part-time weeks
- Release-quality web plus iOS and Android beta: approximately 12-18 part-time weeks

These ranges intentionally exceed the sum of the individual milestone estimates: they include integration work between milestones, rework from gate failures, and review overhead that per-milestone numbers do not capture.

Voice, imports, widgets, share extensions, and store review add separate platform work.

## 22. Go or No-Go Gates

### Gate 1: Does removing the filing decision change capture behavior?

Test a clickable or working prototype with representative users. Continue only if one-field capture and visible routing receipts are materially preferred to selecting a note first.

### Gate 2: Is the manual notes product good enough?

Do not connect a real model until manual navigation, editing, revisions, and search form a credible small notes app. AI cannot compensate for a confusing library.

### Gate 3: Is automatic routing trustworthy?

Auto-apply only categories whose wrong-destination rate is low enough on held-out cases and personal beta data. Keep ambiguous categories in Review. A high overall accuracy number cannot hide a harmful auto-apply subset.

### Gate 4: Does correction improve the system?

Verify that a user correction changes later decisions in a visible and predictable way. If the app repeatedly makes the same mistake, stop expanding features and fix personalization.

### Gate 5: Is native worth maintaining?

Continue both native platforms only if offline capture, keyboard behavior, share integration, or widgets show real value beyond the responsive web app. Otherwise ship iOS first or narrow the native surface.

### Gate 6: Is this ready for public personal data?

Require tested RLS, deletion, export, logging redaction, provider disclosure, backup restore, and incident contact before inviting users outside a controlled beta.

## 23. Initial Engineering Backlog

Create these issues after repository bootstrap:

1. Define versioned IDs, errors, note types, capture states, and organization operations.
2. Create the initial Supabase schema, grants, RLS policies, and cross-user tests.
3. Build the fake-model shopping-list vertical slice through a transactional note revision.
4. Implement the idempotent capture API and status endpoint.
5. Build the mobile SQLite outbox and restart recovery test.
6. Build Today, Notes, Capture, Review, and Search navigation shells.
7. Implement the Markdown editor and expected-revision save contract on both clients.
8. Implement mutation receipts and safe undo.
9. Build candidate retrieval with deterministic rules, full text, and recency before embeddings.
10. Define the strict organization JSON schema and hostile-output fixtures.
11. Add the OpenAI Responses adapter behind `OrganizationModel`.
12. Build the routing evaluation runner and baseline report.
13. Add private manual notes and assert they never enter model or embedding requests.
14. Add export and deletion reconciliation.
15. Deploy preview web and generate internal Expo builds.
16. Implement typed user operations — toggle, field edit, item edit and remove — through `POST /api/v1/notes/:id/operations` with the shared mutation and undo pipeline.
17. Implement the list and log Markdown projection with determinism tests and the re-parse versus structure-conflict rule.

## 24. Selected Defaults and Open Decisions

The plan proceeds with these defaults so implementation can start without waiting for more product choices:

| Decision | Selected default | Revisit trigger |
| --- | --- | --- |
| Name | Soft Index, provisional | trademark, store, package, or domain conflict |
| Audience | single-user personal notes | repeated household or collaboration demand |
| Platforms | responsive web plus Expo iOS and Android | native maintenance outweighs capture benefit |
| Input | text first | routing and sync gates pass |
| Note storage | Markdown canonical for prose types; `structured_data` canonical for list and log with deterministic Markdown projection | editor requirements exceed safe patching model |
| Interactive surfaces | checklist toggling and log field editing in MVP; `table` type, input templates, and workout plans in v1.1 | early usage shows tables or plans are the retention driver |
| Undo retention | full revision history kept; one-tap AI undo guaranteed 30 days | storage metrics justify pruning |
| Organization | rules, retrieval, strict model plan, policy | evaluation shows a simpler path performs better |
| Automation | balanced mode with Review for ambiguity | beta users choose cautious or automatic behavior |
| AI provider | OpenAI and Anthropic adapters behind one port; app key default, BYOK supported | privacy, cost, quality, or availability evidence |
| BYOK custody | Supabase Vault encrypted storage; server-side decryption only; no silent fallback | Vault limits or key-rotation evidence |
| Hosting | Vercel plus Supabase | operational limits or cost justify migration |
| Privacy | cloud sync, private manual note option, no E2EE claim | local-first product becomes the primary thesis |
| Collaboration | out of scope | solo workflow is stable and demand is validated |

Questions to answer through prototypes and beta evidence:

- Should today's shopping list remain one note per day or roll into one open list?
- Should a medium-confidence route apply with Undo or always wait in Review?
- How much generated expansion feels helpful before it feels intrusive?
- Should the default capture close immediately or remain open for rapid consecutive entries?
- Should onboarding starter spaces be opt-in, opt-out, or created lazily on first matching capture?
- Which corrections deserve a permanent rule suggestion?
- Is semantic search useful before a user has enough notes to justify embeddings?
- Does Android need the same first release timing as iOS?

## 25. Definition of Done for the First Public Portfolio Version

The project is ready to present when all of the following are true:

- A user can capture offline on mobile and close the app without losing the thought.
- The capture syncs once and produces a visible organization receipt.
- Shopping, workout, principle, project, and generic examples route through the same system.
- A second message can update the intended living note.
- The original capture remains inspectable.
- A shopping item can be checked off on one device and observed on the other, and a workout number can be corrected with a tap.
- Wrong routes can be moved and undone.
- Manual navigation and editing are obvious on mobile and web.
- A manual edit cannot be overwritten by a stale AI job.
- Search finds content by exact words, approximate words, date, space, and meaning.
- Private manual notes never enter model requests or embeddings.
- RLS, idempotency, crash recovery, deletion, and export have automated evidence.
- Web is deployed to Vercel and mobile has installable beta builds.
- The product explains its AI and privacy behavior plainly.
- The repository documents architecture, tradeoffs, test results, current limitations, and next steps.

## 26. Current Primary Risks

### Trust risk

One wrong append can make the user distrust all future automatic changes. Mitigate with conservative auto-apply bands, receipts, undo, revision history, and strong routing evaluation.

### Product sprawl

Notes products attract tasks, calendars, reminders, graphs, publishing, collaboration, and research features. Protect the create-or-append capture loop until it is excellent.

### Cross-platform editor complexity

A sophisticated block editor can consume the project. Start with canonical Markdown, platform-native editing behavior, and a constrained feature set.

### Sync and duplicate risk

Offline retry can duplicate captures or list items. Client IDs, idempotent APIs, transactional mutation IDs, and restart tests are mandatory.

### AI cost and latency

Calling a large model for every fragment will feel slow and expensive. Deterministic rules, bounded candidates, measured model selection, and Inbox fallback control the cost.

### Privacy mismatch

Personal notes are sensitive. A dark theme and reassuring copy do not create privacy. Claims must match the actual Vercel, Supabase, and model-provider data path.

### Naming risk

The notes category is crowded. Soft Index is a working title, not a cleared mark. Do not invest in final logo, domain, store assets, or legal copy before formal screening.

## 27. Research and Documentation Anchors

Product landscape reviewed while creating this plan:

- [Mem](https://mem.ai/)
- [Tana](https://outliner.tana.inc/)
- [Capacities mobile documentation](https://docs.capacities.io/reference/mobile)
- [Capacities daily notes](https://docs.capacities.io/reference/use-cases/daily-notes)
- [Reflect](https://reflect.app/home)
- [Rill](https://rill.md/)

Current implementation guidance to recheck at bootstrap and major upgrades:

- [Expo Router introduction](https://docs.expo.dev/router/introduction/)
- [Expo monorepo guidance](https://docs.expo.dev/guides/monorepos/)
- [Supabase React Native Auth](https://supabase.com/docs/guides/auth/quickstarts/react-native)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase vector columns](https://supabase.com/docs/guides/ai/vector-columns)
- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Vercel durable workflow overview](https://vercel.com/blog/a-new-programming-model-for-durable-execution)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

## Final Recommendation

Build Soft Index as a **capture router with a trustworthy notes product underneath it**.

The portfolio story is strongest when the demo shows more than a model classification call: offline capture, idempotent sync, hybrid retrieval, strict structured output, transactional revisions, conflict handling, reversible mutations, personal routing rules, search, privacy boundaries, native and web clients, and a durable hosted workflow.

Begin with the design sprint in Section 15.1 and Milestone 0. Once the core interaction has passed the design gate, the first implementation should not begin with voice, a graph, a rich block editor, or a landing page. Begin with one fake-model vertical slice:

```text
"shopping: milk and batteries"
  -> durable capture
  -> deterministic organization plan
  -> Shopping / today
  -> two unchecked items
  -> receipt
  -> undo
```

Make that flow survive duplicates, refreshes, offline restart, stale revisions, and failures. Then replace the fake planner with the evaluated structured-output model adapter. That order turns the idea into a reliable product instead of a compelling demo that loses notes.
