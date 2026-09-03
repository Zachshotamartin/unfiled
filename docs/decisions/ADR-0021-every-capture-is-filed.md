# ADR-0021: Every capture is filed; there is no manual mode

- Status: accepted
- Date: 2026-09-03
- Decided by: the owner, twice, on the shape of the product

## Context

Unfiled shipped two capture modes. "Organize for me" sealed a capture under the `ai_assisted` key class, gave it a job, and let the organizer file it through the owner's own provider key. "Private manual" sealed under the other key class, which the organizer's database login cannot unwrap, and became a note directly without a provider. The composer asked which one on every capture, Library labelled the private ones, search offered a scope for the split, and the web app carried a "New note" page that authored notes by hand.

The owner removed the search scope first ("there should not be a picker for all notes or ai assisted notes. there is no separation there") and then named the product rule: "there is no such thing as manual notes… this is not a manual note taking platform. although you can edit notes."

## Decision

1. **Every capture is filed by the organizer.** The composer no longer asks; captures are always `ai_assisted`. The privacy control, the private-note-on-save path, and the Library's "Private" label are gone from the phone, and the web app no longer offers a page for writing a note from scratch.
2. **Notes are still edited.** The editor keeps its create path, which is how the live gate makes a note without waiting on a provider, and how a note gets its text changed.
3. **Both key classes stay in the schema.** `private_manual` remains the class for routing rules, taxonomy, and owner interactions, which never reach a provider. Nothing about the key hierarchy or the organizer's custody boundary changes; only the product's capture surface does.

## Alternatives considered

- **Keep the per-capture chooser.** It made the owner re-decide on every capture something they had already decided about the product, and it was the last crowded control in the composer row.
- **Move it to Settings as an account default.** Still a mode, still two shapes of note to explain, for a product whose whole claim is that it files what you write.
- **Remove the `private_manual` key class entirely.** It carries surfaces that have nothing to do with capture, so removing it would weaken the parts that legitimately never leave the owner's trust domain.

## Consequences

Easier: one capture path to build, test and explain; the composer's row loses its last mode control; Library shows notes without qualifying them. Harder: nothing in the product creates a note that the organizer cannot read, so an owner who wants a note kept from their provider has no capture route to it today. Committed to: the organizer being the only way a capture becomes a note. Would reopen this: an owner asking for content their provider must never see.
