# ADR-0020: Capture attachments for photos and voice notes

- Status: proposed
- Date: 2026-09-03
- Decision drivers: the owner wants photos and voice notes filed the way text is; every user-content field must stay sealed under the per-user key hierarchy; user content and its identifiers never enter URLs or logs; the JSON request cap is 250,000 bytes and a sealed plaintext is at most 1 MiB; the owner's provider may be Anthropic, which accepts images but not audio

## Context

Captures are text only: a sealed JSON payload with the owner's words and optional directions, filed by the organizer through the owner's own provider key. The owner asked on 2026-09-03 for image filing ("file an image and the ai should be able to file that into a text note… add text to an image note") and voice notes ("we need a transcription model for the ai. both claude and openai"). A photo does not fit inside the capture JSON, the phone renders note bodies inline-only, and neither provider adapter sends anything but one text part. Supabase Storage is not used anywhere in the system. See [MEDIA_CAPTURE_PLAN.md](../MEDIA_CAPTURE_PLAN.md) for the verified limits and the phased plan.

## Decision

1. **Photos and recordings are capture attachments**: separate sealed aggregates (`capture_attachment`) in Postgres jsonb envelopes, under the same key class as their capture, cascade-deleted with it, at most 700,000 bytes each, four photos and one recording per capture.
2. **Uploads are raw binary** to `POST /api/v1/captures/attachments` with a client-generated id as the idempotency key; the capture then references the ids. Reads go through `GET /api/v1/captures/attachments/{attachmentId}` with opaque ids only.
3. **The organizer shows images to the owner's provider** as a bounded field beside the text disclosure (OpenAI `input_image`, Anthropic `image` blocks) under prompt version `routing-v2`. The model never sees or emits attachment ids; the drain appends a deterministic `append_attachments` operation and materialization writes `unfiled-attachment:` references into the note body in the same atomic commit, so undo, move, and delete need no new logic.
4. **Transcription runs on the iPhone by default** with Apple's on-device speech recognition, so the owner sees and edits the words before anything is sent; OpenAI transcription under the owner's key is an opt-in engine; Anthropic has no audio input, so Claude-only owners use the on-device engine, and a recording that cannot be transcribed goes to Review with a typing field rather than being filed silently.
5. **Photos are stripped of location and other metadata** on the phone, always. Recordings are kept with the note by default and deletable per note.

## Alternatives considered

- **Supabase Storage for media.** Loses the single key hierarchy and single deletion path that the envelope tables already have, and signed URLs would carry identifiers of user content. Nothing in the repo uses Storage, so it would also be the first unaudited surface.
- **Base64 images inside the capture JSON.** The JSON reader's cap is fixed at 250,000 bytes and the sealed plaintext at 1 MiB, so a photo cannot share the payload with text at any useful size.
- **Multipart upload.** Needs a parser to audit for a single caller; raw binary with the type in the header is smaller and simpler.
- **Provider-only transcription.** Leaves Claude-only owners without voice notes, and puts the recording on the wire before the owner has seen the words.
- **Letting the model emit attachment references.** Would let a model move or drop media; deterministic attachment of the capture's own ids keeps media placement out of the model's hands.

## Consequences

Easier: one attachment model serves photos and voice; export, deletion, undo and move already cover envelopes and operations. Harder: the phone gains camera, microphone and speech permissions, a binary outbox, and a segmented note renderer; the organizer gains a second content part per provider and a 30 s deadline for image captures. Committed to: media never in URLs or logs, sealed at rest like text, and every phase gated by unit, database, contract, organizer, phone and live-gate tests before it ships. Would reopen this: Anthropic adding audio input (then provider transcription becomes available to Claude owners), or attachment sizes outgrowing the 1 MiB envelope bound.
