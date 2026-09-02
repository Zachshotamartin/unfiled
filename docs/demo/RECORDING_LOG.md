# Demo recording log

Status: **template; contains no recording evidence yet**

Create one copy of the tables below per accepted take. Keep credentials, raw account identifiers, personal email addresses, access-controlled dashboard URLs, and signed media links out of this file.

## Take identity

| Field                              | Value                                                 |
| ---------------------------------- | ----------------------------------------------------- |
| Take ID                            | Pending                                               |
| Purpose                            | Acceptance / public edit / implementation walkthrough |
| Started at                         | Pending ISO 8601 timestamp                            |
| Ended at                           | Pending ISO 8601 timestamp                            |
| Operator                           | Pending                                               |
| Result                             | Pending                                               |
| Raw-media retention location/owner | Pending non-secret description                        |

## Build and environment provenance

| Field                                | Value                                         |
| ------------------------------------ | --------------------------------------------- |
| Source commit SHA                    | Pending                                       |
| Source tree clean                    | Pending                                       |
| Web environment                      | Pending                                       |
| Web deployment ID and commit mapping | Pending                                       |
| Web canonical origin                 | Pending after control proof                   |
| Organizer deployment ID/commit       | Pending                                       |
| Worker deployment ID/commit          | Pending                                       |
| Verifier deployment ID/commit        | Pending                                       |
| Search deployment ID/commit          | Pending or disabled                           |
| Native version/build                 | Pending                                       |
| Signed archive evidence reference    | Pending                                       |
| iPhone model / iOS                   | Pending                                       |
| Browser / version                    | Pending                                       |
| Account label                        | Synthetic; public record must remain redacted |
| Timezone                             | Pending                                       |

## Feature gates during the take

| Feature                         | Actual state                  | Evidence reference |
| ------------------------------- | ----------------------------- | ------------------ |
| Application encryption contract | Pending                       |
| App-default provider routing    | Pending                       |
| BYOK                            | Pending; do not infer enabled |
| Semantic search                 | Pending; do not infer enabled |
| Private-manual path             | Pending                       |
| Note retention execution        | Pending                       |
| Export                          | Pending                       |
| Account deletion/replay         | Pending                       |

## Event log

Record only event time, synthetic input label, outcome code/status, destination label, and evidence timestamp. Do not paste credentials or infrastructure logs.

| Timecode | Event                 | Expected                                           | Observed | Pass/fail |
| -------- | --------------------- | -------------------------------------------------- | -------- | --------- |
| Pending  | Widget opens composer | Content-free widget; focused blank input           | Pending  | Pending   |
| Pending  | Shopping capture      | Preserved source, three items, receipt             | Pending  | Pending   |
| Pending  | Checklist interaction | Supported item state update                        | Pending  | Pending   |
| Pending  | Workout capture/edit  | Preserved source, fields, revision                 | Pending  | Pending   |
| Pending  | Principle capture     | Preserved source, generated label or honest Review | Pending  | Pending   |
| Pending  | Add bananas           | Correct current list or honest Review              | Pending  | Pending   |
| Pending  | Web inspection        | Same owner and current revisions                   | Pending  | Pending   |
| Pending  | Search                | Explicit, accurately enabled scope                 | Pending  | Pending   |
| Pending  | Correction/Undo       | Correct receipt and revision                       | Pending  | Pending   |

## Edits applied to public version

| Source range | Edit    | Reason  | Could it change perceived outcome or latency? | Disclosure |
| ------------ | ------- | ------- | --------------------------------------------- | ---------- |
| Pending      | Pending | Pending | Pending                                       | Pending    |

## Privacy review

| Review                                        | Result  | Reviewer/date |
| --------------------------------------------- | ------- | ------------- |
| Frame-by-frame secret and personal-data scan  | Pending | Pending       |
| Audio/transcript personal-data scan           | Pending | Pending       |
| Product-claim review against `docs/STATUS.md` | Pending | Pending       |
| Caption and disclosure review                 | Pending | Pending       |

## Published artifacts

| Artifact             | Stable URL or repository path   | SHA-256 / version     |
| -------------------- | ------------------------------- | --------------------- |
| Acceptance recording | Pending                         | Pending               |
| Public edit          | Pending                         | Pending               |
| Poster               | Pending                         | Pending               |
| Transcript           | `docs/demo/TRANSCRIPT.md`       | Pending final version |
| English WebVTT       | `docs/demo/unfiled-demo.en.vtt` | Pending final version |

## Final notes

Record known limitations and any visible degraded/Review behavior here. A failed take remains useful evidence; label it failed and do not overwrite its outcome with a later take.
