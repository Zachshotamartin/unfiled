# ADR-0004: Structured note canonical data and stable item identity

- Status: accepted
- Date: 2026-08-30
- Decision drivers: interactive edits need durable identities; manual Markdown edits must not silently target the wrong item; list and log rendering must be deterministic; revision restore and undo must reproduce exact prior state.

## Context

Unfiled supports five note types. Generic, principle, and project notes are written primarily as Markdown. Lists and logs also need interactive controls, including checklist toggles and later numeric field editing. A line number or item label is not a safe long-lived identity: users can reorder lines, duplicate text, or edit a note on another device between reading and writing it.

The shared contracts already provide typed list items, log entries, and project checklist items with prefixed ULID identifiers. Milestone B must decide which representation is authoritative and how IDs survive a manual Markdown edit.

## Decision

`structured_data` is canonical for list and log notes. Their Markdown is a byte-deterministic projection generated from validated structured data. Ordering is explicit (`ordinal` for list items, timestamp then ID for log entries), field ordering is stable, line endings are normalized, and interactive operations address stable `itm_*` or `ent_*` identifiers.

Markdown remains canonical for generic, principle, and project notes. Project notes additionally store a structured checklist index containing stable item ID, text, checked state, ordinal, and source line index. On a manual project edit, reconciliation preserves an ID by normalized exact text first and prior line position second. Duplicate normalized checklist text or a line that cannot be reconciled safely returns `structure_conflict`; Unfiled never guesses which duplicate item the user intended.

Manual list Markdown is parsed back into structured items under the same fail-closed rule. Exact normalized text preserves identity, ordinal position is the deterministic fallback, and ambiguous duplicate text returns `structure_conflict`.

Every successful typed operation creates a new immutable full-snapshot revision. Its mutation records the prior snapshot or typed inverse needed for undo. Restoring an older revision creates another revision; history is never rewritten. This adopts the full-snapshot default in OQ-12 until its documented storage trigger is reached.

## Alternatives considered

- Markdown canonical for every note type: easy to inspect, but interactive list/log edits would rely on fragile line offsets and make deterministic field updates difficult.
- Structured data canonical for every note type: simplifies machines, but makes normal prose editing needlessly constrained and risks losing author formatting.
- Generate new IDs after every manual edit: simple reconciliation, but breaks optimistic UI, inverse mutations, backlinks to structured entries, and cross-device identity.
- Match duplicate items by nearest line and continue: appears convenient but can mutate the wrong user content, violating the fail-closed requirement.

## Consequences

List and log writes must regenerate Markdown in the same transaction as their structured update. Project and manually edited list saves must run reconciliation before persistence. Clients treat `structure_conflict` as a recoverable Review/conflict state and preserve the local draft. Property and replay tests gate projection determinism, stable IDs, stale revisions, inverse undo, and immutable history.
