# ADR-0019: The Paper design direction and the Desk model for the iPhone app

- Status: accepted
- Date: 2026-09-02
- Decided by: the owner, after the first physical-device install of the Milestone G beta

## Context

The first install exposed the beta's visual state rather than a defect list: screen titles in five sizes (56, 52, 42, 38, and 34 points plus the system large title), monospace uppercase labels and monospace body text, stock system symbols at mixed weights, a segmented control and radio cards from the toolkit, the wordmark repeated inside empty states, a near-black ground, and a composer with no way to lower the keyboard. Consistency passes did not answer the owner's objection, which was to the direction itself: black grounds and stock symbols read as unconsidered.

Three directions were mocked side by side on the same two screens (a tinted sage ground, a light "Paper" ground, and a frosted light gradient). The owner chose Paper and rejected any black ground. The owner also rejected the five-tab structure (Today, Notes, capture, Review, Search): each tab held one thin list, Review could live inside another screen, and Search was not worth a destination. Four interaction models were weighed (a chronological River, a Desk with an Inbox and a Library, a note-centric Notebook, a day-per-page Journal); the owner chose the Desk.

## Decision

1. **Ground and ink.** A cool light ground (`#F3F4F6`) with ink text (`#14171B`), secondary text (`#626B76`), hairlines (`#DDE1E6`), white surfaces, and a pressed surface (`#E6E8EC`). One accent, a deep green (`#1E6B57`), carries state dots, links, and the primary action. No black grounds anywhere in the app.
2. **Type.** One scale, defined once in `UnfiledType`: `display` (large title, serif, semibold), `title` (title 2, serif, semibold), `heading` (body, semibold), `body`, `secondary` (subheadline), `caption` (footnote, medium), `label` (caption, semibold, uppercase, tracked), `thought` (body, serif), and `composer` (title 3, serif). Screen titles and everything the user wrote (captures, note bodies, the composer) set in the serif; controls and metadata in the sans. No monospace except literal codes such as deletion receipts.
3. **The mark.** Once per screen, top-left, on the two tab screens (Inbox, Library). Never inside content, empty states, or pushed screens that carry a back button. The mark's colors follow the ground: ink tray, green card.
4. **Glyphs.** No system symbols on the main screens. Every icon is drawn in `UnfiledGlyph` from the mark's own vocabulary: an open tray, a slanted card (tilted 14°, like the mark's card), and square-capped strokes. The bar shows a card dropping into the tray (Inbox), a new card with a plus (capture), and a stack of cards (Library); every other icon is a tray, a card, or a stroke in the same hand, and any new tab icon must be a slanted card.
5. **Components.** `ScreenHeader`, `IconButton`, `Chip`, `StatusDot`, `EditorialEyebrow` (sans, not monospace), `SectionRule`, and an `EmptyLedgerView` that is a sentence and at most one action. Chips replace segmented controls and radio cards; cards appear only where the user decides something.
6. **The Desk model.** Two destinations and one action: Inbox, capture, Library. The Inbox is where thoughts land: a capture card first, then "Needs you" (review decisions as cards with their actions inline, failed captures with Retry, and a persistent key card until a provider key exists), then the Filed stream as rows. The Library is where filed things live: one search entry that hands the page to search in place, spaces as a grid of cards including a synthetic Unfiled space for notes without one, then notes grouped by day; a space pushes its own page. Review and Search are no longer tabs. Cards are for acting and browsing into; rows are for reading. The composer keeps its slide-up sheet, gains a keyboard Done bar and interactive dismissal, a labeled mode pill instead of a plus circle, and a placeholder. Settings is short groups of rows with sub-pages, the key entry first, and no managed-access option when the deployment cannot fund it. There is one way to create: the composer. A capture written in Private mode becomes a private note in the Unfiled space directly while online (falling back to the local outbox offline), and the note editor exists only for editing a note that already exists; its kind, privacy, and space are labeled chip rows, not menus.
7. **Motion.** One system in `UnfiledMotion`: three springs (quick, settle, emphasis), four haptic events (tap, selection, saved, warning), one press style for every tappable element, transitions for tab content, for search rising into place, and for rows arriving, a glyph nudge when a tab is selected, and a loading mark that is the app's own card dropping into the tray in place of every spinner. Reduce Motion is honored at the definitions. No inline animation definitions anywhere else.
8. **Spacing.** Named tokens in `UnfiledTheme` (screen padding, header-to-section distance, row padding) instead of per-screen numbers, so every tab opens the same way and pushed screens share one header distance.

## Consequences

- The web app still carries the earlier dark treatment; bringing it to Paper is separate work.
- Glyph quality is now the app's responsibility: new screens must draw from `UnfiledGlyph`, not from system symbols, and additions must follow the tray, card, and stroke rule.
- The Review list requests 50 items per page, the ceiling the encrypted reader accepts, instead of the contract's 100; the contract's documented maximum should be aligned with the reader in a later change.
- Snapshot references and any screenshots in documentation predate this direction and need regenerating.
