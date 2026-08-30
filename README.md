# Unfiled

Unfiled is a mobile-first notes app that lets a person capture a thought before deciding where it belongs. The system keeps the original capture, proposes or applies a reversible organization action, and makes every result easy to inspect and correct.

Current status: **Milestones A and B are implemented, and the credential-free Gate 2 code gate is green.** Milestone B includes passwordless auth, manual-notes web and mobile surfaces, five note types, immutable revisions, optimistic concurrency, undo/redo, spaces, tags, note links, search, Review reads, shared OpenAPI contracts, local Supabase persistence, and a built-app HTTP acceptance gate. Cloud-preview, physical-device, and usability evidence remains explicitly human-owned in `HUMAN_SETUP.md`; it is not represented as completed. The durable capture endpoint and organization loop, production AI routing, offline sync completion, and release hardening remain sequenced Milestones C through G.

Start with the [documentation index](./docs/README.md), the [brand system](./docs/BRAND_SYSTEM_UNFILED.md), or the [full build plan](./docs/BUILD_PLAN.md). The set covers product requirements with acceptance criteria, the complete AI routing specification, the database schema and RLS design, security and privacy (including encrypted bring-your-own-key support for OpenAI or Anthropic), the operations and test plan, the design system, open questions, and architecture decision records.

## Working product sentence

> Just write. It finds its place.

The product and repository are named Unfiled. Trademark, App Store, package-name, social-handle, and domain clearance remain required before public launch.
