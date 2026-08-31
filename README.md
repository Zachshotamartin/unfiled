# Unfiled

Unfiled is a mobile-first notes app that lets a person capture a thought before deciding where it belongs. The system keeps the original capture, proposes or applies a reversible organization action, and makes every result easy to inspect and correct.

Current status: **Milestones A, B, and the credential-free Milestone C Gate 3 are complete.** The current C.5a change set adds the expand-only encrypted-library schema, per-user managed-key contracts, four independently controlled AWS KMS roots, separate web/worker OIDC roles, an isolated worker scaffold, a dedicated non-bypass worker database role, and a service-only root-rewrap compare-and-swap RPC. Its account-bound Vercel, AWS, database-login, CloudTrail, rotation, and restore evidence remains human-owned in `HUMAN_SETUP.md`. C.5b–d must still migrate and cut over every note, history, workflow, search, export, and retention path; current manual-note storage is not yet fully encrypted and no mode is end-to-end encrypted.

Start with the [documentation index](./docs/README.md), the [brand system](./docs/BRAND_SYSTEM_UNFILED.md), or the [full build plan](./docs/BUILD_PLAN.md). The set covers product requirements with acceptance criteria, the complete AI routing specification, the database schema and RLS design, security and privacy (including encrypted bring-your-own-key support for OpenAI or Anthropic), the operations and test plan, the design system, open questions, and architecture decision records.

## Working product sentence

> Just write. It finds its place.

The product and repository are named Unfiled. Trademark, App Store, package-name, social-handle, and domain clearance remain required before public launch.
