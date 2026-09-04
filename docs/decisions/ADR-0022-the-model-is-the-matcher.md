# ADR-0022: The model is the matcher

- Status: Accepted
- Date: 2026-09-04
- Related records: [ADR-0021](./ADR-0021-every-capture-is-filed.md), [AI_ROUTING_SPEC.md](../AI_ROUTING_SPEC.md)

## Context

The organizer filed only what the lexical scan could vouch for. A note was disclosed to the model
only when the capture shared a word with it, a title with it, or a near vector; an append was filed
unattended only when those same signals scored it above a bar. Two things followed that the owner
saw daily. A capture that shares no word with the note it belongs in -- "eggs for the weekend"
beside a list called Groceries -- never reached the model as a candidate, so the model could only
start another note, and the library filled with near-duplicates. And a new note took whatever title
the model wrote, which for "todo list, x, y, z" was the capture itself, so the note was named after
its first three items and a later "add w to my todo list" could not find it.

The free tier's embeddings are a lexical hash, not a semantic model. No threshold on them will ever
recognise that eggs are groceries. The model can.

## Decision

1. **Disclosure is on recall.** A verified complete scan discloses every open note it ranked, best
   first, up to the limit of eight. The scan's evidence orders the candidates and feeds the policy;
   it no longer decides what the model may see. Zero candidates are disclosed only when the owner
   has no open note.
2. **A note that holds this kind of thing files the capture.** An append the model chose into a note
   whose type is made of exactly this -- an item into a list, an entry into a log, a thought into a
   plain note -- files unattended unless a hard override applies. The score decides only the loose
   fit: a shapeless thought into a note built for something else needs corroboration (shared words,
   a title the capture names, the same day's note, a near vector) to clear 0.45. The weights are
   rebalanced so type compatibility carries 0.3 and the positive weights sum to exactly one.
3. **The model may refine a shapeless capture.** When the deterministic reading finds no structure
   (`freeform`), the model may say the capture is one item for a list or one entry for a log and
   append it there as a single item or entry. When the reading found structure -- a delimited list,
   a measured log line, a labelled principle or project update -- it is authoritative, and any
   other disagreement still goes to review as ambiguity.
4. **A title names the note, never the capture.** The prompt asks for a short noun phrase that names
   what the note is for, and forbids reusing the capture text or an item as the title. When the owner
   names a list in the capture ("todo list, x, y"; "packing: a, b"), that name is the title, only the
   rest is content, and the parser enforces it deterministically: the list's items exclude the name,
   the source-preservation check does not require the name in the body, and a new list note takes
   the name whatever the model proposed. The phone suggests the same title when the owner files a
   review by hand. The organizer prompt version is `routing-v3`; `routing-v4` (2026-09-04) adds the rule that a note the owner named -- in directions or in the capture -- is the destination, and the retriever discloses that note whatever its rank.
5. **The owner's possessive is not part of a title.** "add w to my todo list" resolves to a note
   titled "Todo list"; a note titled "My list" still matches its own phrase.

## Consequences

- The deterministic production-pipeline evaluation records the new behaviour: "add replacement
  cable" joins the Shopping list instead of starting a note, a capture torn between two identically
  titled journals is a question for the owner rather than a silent Inbox drop, an owner-named list
  is created under its name, and a shapeless item joins the list the model recognises.
- More is shown to the model per capture: up to eight open notes' titles, headings and tail
  snippets where before an unrelated capture disclosed none. The bound, the ephemeral aliases and
  the revalidation of every disclosed note are unchanged.
- A wrong append into a type-compatible note is now the model's mistake to make, and the receipt's
  undo is the correction. That is the trade the owner asked for: review is for what the organizer
  could not understand, not for what it understood and placed.
