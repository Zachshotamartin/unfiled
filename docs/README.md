# Unfiled Product Documentation

This directory is the planning and implementation-reference set for **Unfiled**. Milestones A and B are implemented, and the credential-free Gate 2 code gate is recorded green. Cloud-preview, physical-device, and usability evidence remains human-owned in `HUMAN_SETUP.md`; no document should imply that evidence has already been collected. Milestones C through G remain sequenced roadmap work.

## Reading order

1. [BUILD_PLAN.md](./BUILD_PLAN.md) — the spine: product thesis, decisions, architecture, milestones, and gates. Read first.
2. [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) — user stories with acceptance criteria and edge cases, mapped to milestones.
3. [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) — the organization pipeline in full: rules, candidates, prompt, schema, validation, scoring, and the evaluation corpus.
4. [DATA_MODEL.md](./DATA_MODEL.md) — DDL for every table, RLS policies, transactional functions, structured-data schemas, and retention.
5. [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) — threat model, data path disclosure, redaction rules, deletion pipeline, and incident response.
6. [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md) — environments, CI, the enumerated test inventory, release checklists, backups, and monitoring.
7. [BRAND_SYSTEM_UNFILED.md](./BRAND_SYSTEM_UNFILED.md) — identity, voice, cross-platform application, asset manifest, and production handoff rules.
8. [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) — tokens, components, states, and accessibility rules. Initial skeleton; completed during Milestone 0.
9. [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md) — deferred decisions with defaults, options, and decision triggers.
10. [GLOSSARY.md](./GLOSSARY.md) — the product vocabulary used consistently across documents and code.
11. [decisions/](./decisions/) — architecture decision records: [ADR-0001 foundational choices](./decisions/ADR-0001-foundational-technology-and-scope-choices.md), [ADR-0002 BYOK provider strategy](./decisions/ADR-0002-byok-provider-strategy.md), [ADR-0003 immutable native identifiers](./decisions/ADR-0003-native-identifiers.md), and [ADR-0004 structured note canonical data](./decisions/ADR-0004-structured-note-canonical-data-and-stable-items.md).
12. [HUMAN_SETUP.md](../HUMAN_SETUP.md) — account, cloud-preview, browser, canary-log, performance, and physical-device gates that cannot run credential-free in CI.

## Document status

| Document                | Status                                                                       | Owned by milestone                  |
| ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| BUILD_PLAN.md           | Current; Milestones A and B complete; Gate 2 code gate green                 | revised at each milestone gate      |
| PRODUCT_REQUIREMENTS.md | Complete for MVP scope                                                       | revised at each milestone gate      |
| AI_ROUTING_SPEC.md      | Complete; weights and thresholds are initial values pending evaluation       | Milestone D                         |
| DATA_MODEL.md           | Initial migrations landed; checked-in migrations are authoritative           | Milestone A and every schema change |
| SECURITY_AND_PRIVACY.md | Complete for planning; checklist gates public beta                           | Milestone G / Gate 6                |
| OPERATIONS_TEST_PLAN.md | Current; Milestone B local HTTP gate recorded, cloud gates remain human      | every milestone                     |
| BRAND_SYSTEM_UNFILED.md | Selected v1 creative direction; name clearance and vector production pending | Milestone 0                         |
| DESIGN_SYSTEM.md        | Initial skeleton with token draft                                            | Milestone 0                         |
| OPEN_QUESTIONS.md       | Live document                                                                | continuous                          |
| GLOSSARY.md             | Live document                                                                | continuous                          |

## Milestone B Gate 2 evidence

The milestone owner recorded the credential-free aggregate Gate 2 code decision as green on 2026-08-30. Preview/browser/device evidence that requires cloud accounts or hardware remains listed in `HUMAN_SETUP.md` and is not claimed here.

| Evidence                                                                 | Recorded result                   |
| ------------------------------------------------------------------------ | --------------------------------- |
| contracts lint, typecheck, 24 tests, coverage, and build                 | pass                              |
| API client lint, typecheck, 9 tests, coverage, and build                 | pass                              |
| web lint/typecheck and 60 tests; mobile lint/typecheck and 61 tests      | pass                              |
| generated OpenAPI freshness and absence of the unimplemented `/captures` | pass                              |
| fresh database reset and warning-level lint                              | pass; zero lint findings          |
| complete pgTAP suite                                                     | pass; 15 files / 636 assertions   |
| built-app/local-Supabase HTTP E2E                                        | pass twice consecutively          |
| web responsive/auth smoke                                                | pass at desktop and 390 px mobile |
| aggregate credential-free Gate 2 decision                                | **green — 2026-08-30**            |

## Rules for maintaining this set

- A change to scope, schema, or contract lands in the owning document in the same change set as the code, never after.
- BUILD_PLAN.md stays the summary; when it disagrees with a companion document on a detail, the companion document wins and BUILD_PLAN.md gets corrected.
- Every non-obvious decision gets an ADR; ADRs are never edited after acceptance, only superseded.
- Open questions move from OPEN_QUESTIONS.md into an ADR when decided; they are not deleted.
