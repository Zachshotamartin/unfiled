# Unfiled roadmap

This roadmap separates remaining release work from ideas that are intentionally deferred. It is an ordered plan, not a delivery-date promise.

For the current claim-safe boundary, see [STATUS.md](./STATUS.md). The detailed implementation plan remains [BUILD_PLAN.md](./BUILD_PLAN.md).

## Now: complete Milestone G

### G1. Establish the launch identity

Deliver:

- complete the evidence checklist in [NAME_CLEARANCE.md](./NAME_CLEARANCE.md);
- decide whether **Unfiled** passes the intended legal and channel review;
- prove control of the canonical domain, project, and monitored mailboxes;
- record the outcome in [ADR-0014](./decisions/ADR-0014-launch-name-and-public-channels.md); and
- update public copy only after the evidence supports it.

Exit condition: the selected launch name and every public contact/channel used by the product have a dated owner and proof record. A resolving domain or working local configuration is insufficient.

### G1b. Capture without unlocking the phone (owner request, 2026-09-02)

The Lock Screen widget was removed on 2026-09-02 at the owner's direction (ADR-0017): WidgetKit
exposes no text input in any widget family and the Lock Screen rectangular family is fixed at half
width, so a widget could only ever open the app. Deliver instead: (1) a Siri App Shortcut whose intent
takes a dictation or text parameter, queues the capture in the SQLCipher outbox without opening the
app, and syncs on next launch; (2) an Action Button binding to that shortcut. Evidence: intent unit
tests, a device run from the Lock Screen with the phone locked, and the existing HTTP capture stages
unchanged. No widget of any family is planned.

### G1c. Password recovery and a dedicated sign-in limiter (after ADR-0018)

Sign-in is email and password with no verification step. Deliver self-service password reset once
an email sender exists (Supabase custom SMTP or an application mailer), and a sign-in throttle
keyed on failures per email and per IP that is independent of the sign-up quota. Evidence: handler
tests, an e2e stage for reset and throttle, and a live run on the deployed beta.

### G1d. Inbox filing for owners without a key

Today an owner with no saved provider key gets each capture saved and marked `failed` with
`provider_unavailable`; the web and iPhone clients show it in Capture activity with a Settings
prompt and a retry, and no note exists until a key is saved. The organizer produces no
`kept_in_inbox` receipt today. Deliver: an `inbox` commit outcome in the organizer SQL that
seals a `kept_in_inbox` receipt with reason `provider_key_missing` and sets the capture to
`inbox`, client rendering for that state, and an e2e stage that runs a no-key owner end to end. Include
unorganized captures in the account export: today the archive holds notes and a manifest, so a
capture that has not become a note is visible in Capture activity but absent from the export.

### G1e. Bring the web app to the Paper direction (after ADR-0019)

The iPhone app moved to the Paper direction on 2026-09-02; the Next.js app still uses the earlier
dark treatment. Deliver the same tokens (ground, ink, one green accent), the same type scale with
serif titles and serif thoughts, the mark once per page, and the tray-and-card glyph set in the web
app, with the composer and Notes library structured the same way. Evidence: the public pages and
the signed-in app rendered side by side with the phone.

### G2. Prove the hosted topology

Deliver:

- record deployment-to-commit and alias provenance for the five existing Vercel projects (`unfiled-web`, `unfiled-organizer`, `unfiled-worker`, `unfiled-verifier`, `unfiled-search`) without recording credentials;
- turn Vercel Authentication off on each project (Hobby offers only "Standard Protection", which would also gate the production aliases) and confirm the Ignored Build Step keeps Preview unbuilt;
- exercise the app-level OIDC verifier, the four dedicated database roles on the shared beta database, the Vercel Sensitive root-ring subsets, and provider-key entry through the product UI;
- record the remote application of migrations `20260902000000` and `20260902000001`, live canaries for both providers, root-ring rotation, restore, backup, and deletion evidence; and
- keep paid PITR, the irreversible storage contraction, and AWS KMS hardening explicitly deferred rather than implied.

Exit condition: every production claim maps to dated non-secret evidence recorded in `FINAL_REPORT.md`. Local mocks, policy-shape tests, DNS, and public TLS do not satisfy this condition.

### G3. Complete the public trust surface

Deliver:

- reviewed product privacy policy and terms;
- public security policy and `/.well-known/security.txt`;
- monitored support and security contacts;
- public support and account-deletion instructions;
- vendor, retention, AI-provider, backup, and data-rights disclosures that match the deployed path; and
- App Store privacy answers reconciled with the native privacy manifests.

Exit condition: policy text, product copy, actual configuration, and support operations agree. No E2EE, zero-retention, or zero-knowledge claim appears unless separately proved.

### G4. Produce the native beta evidence

Deliver:

- select the final Release configuration;
- inspect a signed archive for the exact host, privacy, and environment settings;
- distribute an internal TestFlight build;
- run the physical-iPhone matrix on the oldest supported iOS release and the current release; and
- verify SQLCipher, Keychain protected-data behavior, offline outbox recovery, sign-out, account deletion, and accessibility.

Exit condition: the signed build and physical-device results are recorded with build numbers and dates. Simulator success remains separate evidence.

### G5. Prepare and record the demonstration

Deliver:

- provision a clearly labeled synthetic account through supported owner-authorized paths;
- capture the unedited fresh-user acceptance recording;
- produce the concise portfolio edit using the same honest behavior;
- publish captions, transcript, artifact provenance, and the recording checklist under [demo/](./demo/); and
- link the canonical video from the final report and portfolio.

Exit condition: a fresh user completes the flagship iPhone flow and opens the same result on the web. The recording contains no personal data, credentials, private notification content, or hidden fallback represented as Production.

### G6. Finish operations and release reporting

Deliver:

- content-free monitoring dashboards and alert ownership;
- provider outage (both providers), queue recovery, rollback, migration, credential rotation, key-custody outage, restore, export-support, and suspected-exposure runbooks;
- a restore drill performed within the required release window;
- fresh CI, migration, dependency, security, deletion, and export evidence; and
- `FINAL_REPORT.md` with implementation, deployment, native, demo, legal, security, known-limit, and roadmap sections.

Exit condition: the report contains links, run IDs, deployment/build identifiers, dates, and honest pending rows. It never infers account or device evidence from source code.

## Public beta follow-through

After the Milestone G exit gate:

- stage access rather than opening unrestricted public-data use immediately;
- watch capture loss, receipt latency, queue age, provider failures, corrections, search degradation, export, and deletion reconciliation;
- keep a rollback decision owner and documented stop conditions;
- verify policy and support copy after every provider or retention change; and
- repeat the native archive/device gate for every release candidate.

## Deferred product work

The following items are roadmap ideas, not implemented release features unless a later accepted decision says otherwise:

| Candidate                                          | Current boundary           | Required before implementation                                                                                                                                                                              |
| -------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imports                                            | Deferred                   | File-format, size, parser, privacy, provenance, and deduplication design plus hostile-file tests.                                                                                                           |
| Voice capture                                      | Deferred                   | Recording disclosure, transcription provider/privacy decision, permissions, background behavior, and accessibility review.                                                                                  |
| Home Screen widget variants                        | Out of scope               | Separate value case, redaction model, timeline budget, and device matrix.                                                                                                                                   |
| Share extension                                    | Deferred                   | Extension-safe encrypted staging, content limits, source attribution, App Group isolation, and restart tests.                                                                                               |
| Interactive tables                                 | Deferred v1.1 candidate    | Typed-column schema, editing semantics, accessibility, export, conflict, and migration design.                                                                                                              |
| Planned workout sessions and rest timers           | Deferred v1.1 candidate    | Template model, timer lifecycle, notifications, accessibility, and background execution design.                                                                                                             |
| Android client                                     | Out of the current release | Separate scope, architecture decision, secure local-store design, widget/system integration, signing, store, and device-test plan.                                                                          |
| Additional AI providers beyond OpenAI and Claude   | Hidden until proved        | Concrete adapter, custody and retention review, strict schema compatibility, registry version change, and provider-by-tier evaluation gate. OpenAI and Claude are implemented under ADR-0015.               |
| Semantic (provider) embeddings and AWS KMS custody | Deferred paid hardening    | A funded deployment decision, provider data-control review, a new index generation, and the ADR-0006/ADR-0016 custody evidence. The free beta uses local-hash retrieval and the Vercel Sensitive root ring. |
| Strict E2EE mode                                   | Research only              | A new architecture decision for device enrollment, recovery, multi-device sync, local search, organization, export, and loss handling. Current server-side AI architecture is not E2EE.                     |
| Knowledge graph and autonomous agents              | Outside the product thesis | Evidence that they improve capture and retrieval without weakening control or turning Unfiled into a general research workspace.                                                                            |

## Roadmap discipline

A future item moves into “implemented” only when all of these are true:

1. its scope and user value are explicit;
2. security, privacy, failure, accessibility, migration, and deletion behavior are designed;
3. tests and acceptance evidence exist;
4. the user-visible documentation matches the shipped behavior; and
5. [STATUS.md](./STATUS.md) and the final report are updated with evidence.

Design references, dormant schema fields, prototypes, and tests for an adjacent capability do not make a roadmap item shipped.
