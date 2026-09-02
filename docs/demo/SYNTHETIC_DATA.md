# Synthetic demo data

Status: **manifest selected; hosted provisioning not yet proved**

Every person, capture, note, destination, and account shown in an Unfiled demo must be fictional. This manifest avoids accidental personal disclosure and makes the expected product behavior repeatable.

## Two separate demo owners

Use separate owners for separate purposes:

1. **Fresh acceptance owner:** begins with no destination notes and proves that a new user can complete the flagship iPhone flow and inspect it on web.
2. **Seeded portfolio owner:** contains a small, clearly labeled synthetic library for browsing, search, backlinks, Review, export, and support demonstrations.

Do not reuse either account for personal notes, routine development, provider administration, or support access.

## Prohibited provisioning shortcut

`supabase/seed.sql` is a deterministic local/test fixture. It contains fixed local users, stable IDs, direct table writes, and a checked-in local-only password. It must never be applied to Preview or Production and must never be used as proof of a hosted demo account.

Provision hosted demo data only through the same reviewed owner-authorized product APIs and UI available to a normal owner. Do not patch encrypted rows or copy envelopes between owners.

## Account profile

Use values controlled by the release owner but do not commit the actual routable mailbox or authentication details.

| Field         | Synthetic value or rule                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Display name  | `Synthetic Demo`                                                                                                            |
| Locale        | `en-US`                                                                                                                     |
| Timezone      | `America/Los_Angeles`                                                                                                       |
| Account label | A visible `Synthetic data` note or profile label                                                                            |
| Email         | Dedicated controlled alias; record only a redacted form such as `demo+…@example.invalid` in public evidence                 |
| Provider mode | Record the actual enabled mode in `RECORDING_LOG.md`; never imply BYOK or semantic search is enabled if its gate is pending |

The literal `.invalid` address above is documentation notation and must not be used to authenticate. The real controlled mailbox belongs in the operator's secret manager, not this repository.

## Fresh acceptance captures

Submit in this order:

1. `shopping: milk, spinach, batteries`
2. `bench 135 x 8, 145 x 6, 155 x 4; incline dumbbell 45 x 10 for 3 sets`
3. `Roosevelt method: tell people you can do it, then figure out how to do it later`
4. `add bananas`

Assertions:

- the exact source text remains inspectable;
- shopping creates or updates one current list containing distinct unchecked items;
- workout extraction preserves every unparsed fragment and invents no unit;
- the principle thought is preserved, while any interpretation is explicitly generated and makes no historical-attribution claim;
- the follow-up reaches the current shopping context or an honest Review outcome;
- every applied change has an inspectable receipt and appropriate Undo/correction control; and
- the same current revisions are visible to the same owner on web.

Do not require a locale-specific title such as an English month name in automated acceptance. Record the actual title/date and verify its semantic destination and owner.

## Seeded portfolio library

Create this small library through normal application operations. Titles may receive the current date according to product behavior.

### Life space

**Shopping** — list, AI-assisted

- oat milk
- spinach
- batteries
- bananas

**Push workout** — log, AI-assisted

- bench press: 135 × 8, 145 × 6, 155 × 4
- incline dumbbell press: 45 × 10 for 3 sets
- one prior entry for the same exercise so the tap-to-edit placeholder can be shown

**Mindset** — principle, AI-assisted

- exact captured thought: `Tell people you can do it, then figure out what the commitment requires.`
- a separately labeled generated interpretation that avoids attributing the idea to a historical person

**Weekend errands** — list, private-manual

- return library books
- replace porch light

This private-manual note exists to prove manual navigation and lexical search. Do not select it for an AI-assisted search or provider demonstration.

### Projects space

**Unfiled demo polish** — project, private-manual

```markdown
## Next

- Record the fresh-user acceptance take.
- Verify captions against the final audio.
- Publish the architecture text alternative.
```

**Garden notes** — generic, AI-assisted

```markdown
Move basil to the brighter window. Check the soil on Thursday.
```

Link Garden notes to Weekend errands only through a normal owner-authorized link action so backlinks can be demonstrated without synthetic database writes.

## Review fixture

Create ambiguity through a normal capture only if the current policy naturally returns Review. A safe candidate is:

> `pick up charger for the trip`

Do not force a Review row in the database. If the product confidently routes it, record that outcome and use another reviewed synthetic phrase. Do not publish a phrase selected from private user data.

## Dates and clocks

- Record the environment timezone and wall-clock date in the recording log.
- Prefer “current shopping note” and “current workout” in narration so the edit remains understandable later.
- Do not change the device clock to manufacture a title unless the entire environment is an isolated, documented test environment.
- If takes cross midnight, discard or explicitly reset the synthetic owner rather than splicing inconsistent dates together.

## Provisioning procedure

1. Create the controlled synthetic owner through the supported authentication flow.
2. Confirm the environment and owner label before entering any content.
3. Create the spaces and notes through product UI/API paths.
4. Submit the synthetic captures and wait for durable receipts.
5. Verify source, note, revision, privacy, generated-block, link, search, export, and deletion behavior through owner-authorized reads.
6. Record only counts, IDs safe for the evidence record, commit/deployment/build versions, and pass/fail outcomes. Do not copy plaintext notes into operational logs.
7. Reset by using supported account deletion or by creating a new synthetic owner. Never truncate shared hosted tables.

## Retirement

After the demo lifecycle:

1. remove public access to any raw recording;
2. delete the synthetic account through the supported account-deletion flow;
3. verify the content-free deletion receipt and reconciliation result;
4. revoke or rotate any dedicated demo access mechanism;
5. record the date and backup-expiry expectation without publishing secrets; and
6. retain only the accepted public edit and its provenance for as long as the portfolio needs it.
