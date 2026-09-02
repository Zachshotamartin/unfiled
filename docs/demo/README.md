# Unfiled demo artifacts

Status: **no accepted recording is linked yet**

This directory stores the text, provenance, and acceptance record for the Milestone G demonstration. Large binary video files are intentionally not committed. Publish the canonical video through the approved portfolio/CDN host, then record its stable URL and checksum here.

## Artifact manifest

| Artifact                      | Repository location or external record                 | Status                                    |
| ----------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Demo plan and storyboard      | [`../DEMO_PLAN.md`](../DEMO_PLAN.md)                   | Drafted                                   |
| Synthetic-data manifest       | [`SYNTHETIC_DATA.md`](./SYNTHETIC_DATA.md)             | Drafted; hosted account not proved        |
| Narration transcript          | [`TRANSCRIPT.md`](./TRANSCRIPT.md)                     | Draft; must be reconciled to final edit   |
| English captions              | [`unfiled-demo.en.vtt`](./unfiled-demo.en.vtt)         | Draft timing; not evidence of a recording |
| Unedited acceptance recording | External URL and checksum pending                      | Not recorded/accepted                     |
| Public portfolio edit         | External URL and checksum pending                      | Not recorded/accepted                     |
| Poster/thumbnail              | External or later small optimized asset                | Not created                               |
| Acceptance checklist          | [`ACCEPTANCE_CHECKLIST.md`](./ACCEPTANCE_CHECKLIST.md) | Pending real run                          |
| Recording provenance          | [`RECORDING_LOG.md`](./RECORDING_LOG.md)               | Template only                             |

## Canonical publication record

Complete this section only after publication. Do not place credentials, signed URLs containing bearer tokens, account IDs, or private dashboard links here.

| Field                    | Value                                 |
| ------------------------ | ------------------------------------- |
| Public video URL         | Pending                               |
| Acceptance recording URL | Pending; may remain access-controlled |
| Poster URL               | Pending                               |
| Transcript version       | Draft                                 |
| Caption version          | Draft                                 |
| Final video SHA-256      | Pending                               |
| Source commit SHA        | Pending final recording               |
| Web deployment ID/commit | Pending non-secret evidence           |
| Native version/build     | Pending signed build                  |
| Recording date           | Pending                               |
| Acceptance date          | Pending                               |

## Storage rules

- Keep raw recordings in an access-controlled project folder with the shortest useful retention.
- Do not upload raw takes to a public issue, pull request, or generic file-sharing link.
- Review deleted takes for accidental secrets before assuming trash is sufficient; rotate any exposed credential immediately.
- Prefer an immutable or versioned public URL for the accepted edit. If the media is replaced, update its checksum and acceptance date.
- A public video is a product demonstration, not security evidence by itself. The final report must link the independent deployment, test, device, restore, and policy records.

## Recording rule

Only material that passes [`ACCEPTANCE_CHECKLIST.md`](./ACCEPTANCE_CHECKLIST.md) may be described as the Milestone G demo. A concept animation, Simulator-only walkthrough, deterministic local fixture, or recording from an unproved deployment must carry that narrower label.
