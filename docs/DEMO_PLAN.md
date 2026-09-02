# Unfiled demo plan

Status: **planned; not yet recorded or accepted**

The Milestone G demo must show the real product loop without using personal data, hidden demo-only branches, prearranged credentials in source control, or edits that imply an unobserved success.

This plan produces two related artifacts:

1. an unedited acceptance recording that proves the fresh-user iPhone-to-web gate; and
2. a concise public portfolio video derived from separately logged, honest takes.

The artifact manifest and evidence templates live in [demo/](./demo/).

## Story to prove

Unfiled removes the filing decision at capture time while keeping organization inspectable and reversible:

> Write one message on the phone, let it reach the useful living note, inspect what changed, correct or undo it, and find the same result on the web.

The video must also show that AI is a bounded behavior, not the entire notes product. Manual note navigation, exact source preservation, explicit generated labels, lexical search, export/delete ownership, and privacy disclosure remain part of the trust story even if every one is not shown in the short edit.

## Required prerequisites

Do not record the acceptance take until all applicable prerequisites are true:

- a fresh, clearly labeled synthetic owner can sign in on the signed iPhone build and the hosted web environment;
- the iPhone and web client point to the same reviewed environment and API origin;
- exact deployment IDs and commit SHA are recorded privately and copied as non-secret provenance into the recording log;
- the provider, semantic-search, BYOK, and private-manual enablement states are known and accurately disclosed;
- the organizer, index, and receipt queues are healthy;
- the account contains no real email content, contacts, notes, notifications, photos, or clipboard data;
- screen-recording status bars, Focus mode, incoming calls, and notification previews cannot expose personal information;
- the capture date/timezone is fixed in the manifest, or the expected note titles are written date-independently;
- the public privacy/support surfaces match the environment being shown; and
- the operator has rehearsed the controls without pre-creating the acceptance account's destination notes.

If a prerequisite is false, record a clearly labeled implementation walkthrough instead of claiming the Milestone G acceptance gate.

## Synthetic inputs and expected behavior

Use these exact source strings. Do not substitute personal examples.

| #   | Source capture                                                                    | Required observable behavior                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `shopping: milk, spinach, batteries`                                              | The source is preserved. Three unchecked items appear in the current shopping note, and the receipt names the outcome and offers navigation plus Undo.                                                   |
| 2   | `bench 135 x 8, 145 x 6, 155 x 4; incline dumbbell 45 x 10 for 3 sets`            | The source is preserved. A current workout log is created or updated. Readable exercises/sets appear without inventing units, and numeric fields can be edited with the native numeric interaction.      |
| 3   | `Roosevelt method: tell people you can do it, then figure out how to do it later` | The exact thought is preserved in a Mindset/Principles destination or safely sent to Review. Any interpretation is visibly generated and does not assert the phrase's historical attribution as fact.    |
| 4   | `add bananas`                                                                     | With the current shopping context established, the capture appends one unchecked item to that active shopping note or presents an honest Review decision. It must not silently update an unrelated list. |

The video may show deterministic or reviewed provider output only through the real production-shaped application seam. If actual output differs, show the truthful Review path or repeat after diagnosing the environment; do not patch the database or replace the result in editing.

## Output A: unedited acceptance recording

Target duration: 4–8 minutes. One continuous take, except that authentication codes may be completed off-camera. Any authentication cut must occur before the application behavior being proved and must be disclosed in the recording log.

### Acceptance sequence

1. Show the signed build number, environment label, and empty/fresh account state without revealing credentials.
2. Lock the device, show that the Lock Screen widget exposes no protected note content, then tap it.
3. Confirm the app opens a blank, focused composer with the keyboard ready.
4. Submit the shopping capture. Show local durable acknowledgement, processing, the receipt, and the resulting checklist.
5. Check and uncheck one item with a one-handed control to establish that the result is a usable note, not static generated text.
6. Submit the workout capture. Open the workout note, show the preserved raw entry, tap one numeric field, change it, save it, and show the resulting revision.
7. Submit the Roosevelt capture. Show the original, the destination or Review state, and the generated/provenance label if an interpretation exists.
8. Submit `add bananas`. Open the resulting receipt and confirm the correct shopping destination.
9. Put the iPhone aside without signing out. Open the hosted web app in a clean browser session authenticated as the same synthetic owner.
10. Open the shopping, workout, and mindset results on the web. Confirm at least one state changed on iPhone is visible on web.
11. Run an all-notes lexical search. If AI-assisted search is enabled by completed gates, explicitly select its scope and show the provider disclosure before running it. Otherwise show lexical-only behavior and state that Production semantic search is disabled.
12. Perform one safe Undo or correction and show the resulting receipt/revision on both surfaces.
13. End on a screen containing no email address, token, internal project ID, or personal notification.

### Acceptance failures

Stop and mark the take failed if any of the following occurs:

- a capture is lost, duplicated, or shown as saved without durable acknowledgement;
- the recording hides an error, provider fallback, or Review outcome and later presents success;
- the iPhone and web views are not the same owner/environment;
- private-manual content enters an AI/provider path;
- a receipt, source link, edit, or Undo points to the wrong note/revision;
- a stale or incomplete semantic generation is represented as current;
- any real personal data, credential, OTP, access token, project identifier, or secret is exposed; or
- the spoken claims exceed [STATUS.md](./STATUS.md).

## Output B: public portfolio edit

Target duration: 90–150 seconds, 16:9 master at 1080p or higher, with a captioned 9:16 derivative only if the crop preserves controls and disclosure text.

### Storyboard

| Time      | Picture                                            | Narration or title                                                     | Proof carried forward                                                              |
| --------- | -------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0:00–0:08 | Lock Screen widget into focused composer           | “Most notes fail before the first word: where should this go?”         | Native capture starts without a title/folder choice; widget contains no note text. |
| 0:08–0:25 | Shopping capture becomes receipt and checklist     | “Unfiled saves the thought first, then shows exactly where it landed.” | Durable acknowledgement, preserved source, useful structured note, visible Undo.   |
| 0:25–0:45 | Workout capture and tap-to-edit number             | “Lists and logs stay normal, editable notes.”                          | Structured extraction does not trap the user behind AI.                            |
| 0:45–1:02 | Roosevelt thought, generated label, source context | “Interpretation is labeled. The original stays close.”                 | No false attribution, provenance visible.                                          |
| 1:02–1:18 | `add bananas` appends to current list              | “A follow-up can update the right living note.”                        | Contextual append, no new untitled fragment.                                       |
| 1:18–1:38 | Web opens same notes and runs search               | “The phone and web share one backend and one revision history.”        | Cross-device result; search scope is explicit.                                     |
| 1:38–1:55 | Correction or Undo, then architecture/title frame  | “Every change is inspectable, correctable, and reversible.”            | Trust loop and honest architecture status.                                         |
| 1:55–2:05 | Closing mark and status label                      | “Unfiled — portfolio implementation; public-beta gates in progress.”   | No production or legal-clearance overclaim.                                        |

The portfolio edit may remove dead time, but it must preserve event order. Speed ramps, recreated audio, zooms, and composite device framing must not change the apparent outcome or hide a failure. Use a visible “sped up” label if processing time is compressed.

## Visual and audio direction

- Use the Ink, Graphite, Warm Paper, Persimmon, and Fog palette from the brand system.
- Favor real product capture over concept art. Brand reference images may introduce sections but must not be presented as live screens.
- Keep all text readable at the final export size. Do not crop provider disclosures, error states, receipt status, or Undo controls.
- Record at native resolution and edit on a 24 or 30 fps timeline. Avoid interpolation that makes typing or transitions look synthetic.
- Narration is calm, factual, and sparse. Do not use “magic,” “second brain,” “only you can read,” “zero retention,” or “end-to-end encrypted.”
- Include burned-in captions only for social derivatives. The canonical video must also ship with the sidecar WebVTT file and transcript.
- Use no copyrighted music without a documented license. Silence or a simple owned sound bed is acceptable.
- Normalize spoken audio without clipping. Keep UI sounds and notification audio off unless intentionally demonstrated.

## Privacy and security recording rules

- Use a dedicated synthetic mailbox and account. Never reuse a personal Apple ID view, email inbox, browser profile, password manager, clipboard, or notification center in the recording.
- Never capture an OTP, magic link, password, API key, JWT, cookie, QR enrollment code, Vercel project ID, AWS account ID, database connection string, or support-console screen.
- Do not commit the recording account secret, recovery code, mailbox rule, or provider credential.
- Use only text in [demo/SYNTHETIC_DATA.md](./demo/SYNTHETIC_DATA.md).
- Clear recent-app thumbnails and browser autocomplete before recording.
- Keep crash reports, terminal output, network inspectors, cloud dashboards, and logs out of the public edit. Non-secret evidence belongs in the recording log or final report.
- Delete or rotate the recording account after its intended demo lifecycle and record the action without publishing recovery data.

## Publication gate

Before publishing, two reviewers—or the project owner in two separate review passes—must confirm:

1. the video matches the recorded build and deployment provenance;
2. every statement is supported by current status evidence;
3. no personal or secret material appears frame-by-frame or in audio;
4. generated content is labeled and no historical attribution is invented;
5. the synthetic-data label is visible in the description or opening/closing slate;
6. captions match the final audio and timing;
7. the architecture and privacy descriptions match the deployed configuration; and
8. the canonical URL, transcript, captions, checksum, and recording log are complete.

Record that decision in [demo/ACCEPTANCE_CHECKLIST.md](./demo/ACCEPTANCE_CHECKLIST.md) and [demo/RECORDING_LOG.md](./demo/RECORDING_LOG.md). Until those files contain real evidence, the demo status remains **planned**.
