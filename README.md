# Unfiled

Unfiled is a mobile-first notes app that lets a person capture a thought before deciding where it belongs. The system keeps the original capture, proposes or applies a reversible organization action, and makes every result easy to inspect and correct.

Current status: **Milestones A, B, and the credential-free Milestone C Gate 3 are complete.** C.5a supplies the expand-only encrypted-library and managed-KMS custody boundary. The current C.5b change set implements the typed encrypted aggregate, service-only envelope/CAS and rollout RPCs, resumable verification-aware backfill, and managed note/capture adapters. Private-manual captures can use the encrypted path now; a fresh AI-assisted capture deliberately fails closed until C.5c supplies the organizer's atomic encrypted writer, and the production repository factory has not switched to these adapters. C.5d still has to remove the plaintext storage/search contract. Account-bound Vercel, AWS, database-login, CloudTrail, rotation, restore, Apple signing, and physical-iPhone evidence remains human-owned in `HUMAN_SETUP.md`. The product is not yet fully encrypted at rest and no mode is end-to-end encrypted.

Start with the [documentation index](./docs/README.md), the [brand system](./docs/BRAND_SYSTEM_UNFILED.md), or the [full build plan](./docs/BUILD_PLAN.md). The set covers product requirements with acceptance criteria, the complete AI routing specification, the database schema and RLS design, security and privacy (including encrypted bring-your-own-key support for OpenAI or Anthropic), the operations and test plan, the design system, open questions, and architecture decision records.

## Working product sentence

> Just write. It finds its place.

The product and repository are named Unfiled. Trademark, App Store, package-name, social-handle, and domain clearance remain required before public launch.
