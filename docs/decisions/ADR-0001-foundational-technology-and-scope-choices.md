# ADR-0001: Foundational technology and scope choices

- Status: accepted
- Date: 2026-08-30
- Decision drivers: solo part-time developer; portfolio-quality reliability bar; phone-first capture thesis; trust model (receipts, undo) as the differentiator; minimize novel infrastructure.

## Context

Unfiled needs a stack and scope posture before design and bootstrap. The product's risk is trust and reliability, not rendering; choices should spend complexity on durability and validation, not platform breadth.

## Decisions

1. **Monorepo: pnpm workspaces + Turborepo**, shared TypeScript domain. One language across web, mobile, API, and workflow keeps contracts and tests shared.
2. **Two clients, one backend:** Next.js (Vercel) for web + API + workflows; Expo/React Native for iOS/Android. Not Expo-web-everywhere: the desktop editor and the native capture surface have different needs; they share domain logic and tokens, not screen implementations.
3. **Supabase** for auth, Postgres (RLS, pg_trgm, pgvector), realtime, storage. RLS gives database-level per-user isolation testable in CI — central to the trust model.
4. **Durable organization via Vercel Workflows** behind an `OrganizationJobRunner` port; narrow port so Supabase Queues or a worker can replace it on operational evidence.
5. **AI behind an `OrganizationModel` port with a provider registry** (see ADR-0002 for BYOK); strict schema-constrained output; model output is data, never authority.
6. **Canonical content per note type:** Markdown canonical for prose types; `structured_data` canonical for `list`/`log` with deterministic Markdown projection. Enables interactive surfaces without a custom block editor.
7. **One typed-operation pipeline for AI and user interactions** — identical validation, revision preconditions, mutation records, and undo. Two callers, one code path.
8. **Scope posture:** capture→route→receipt→correct→undo loop before any breadth (no collaboration, publishing, graphs, voice, imports in MVP). Design sprint (Milestone 0) precedes bootstrap.

## Alternatives considered

- **Local-first sync engine (CRDTs, e.g. Automerge/Yjs):** strongest offline story but weeks of sync-engine work orthogonal to the routing thesis; revisit only if local-first becomes the thesis (BUILD_PLAN §24).
- **Expo Router for web too:** one codebase, but web editor and marketing surface would fight React Native Web; rejected for editor quality.
- **Custom Node worker + queue (BullMQ/SQS) for jobs:** more control, more ops burden for one person; the port keeps this as an exit.
- **Convex / Firebase:** good DX; weaker fit for RLS-style testable isolation and SQL-level guarantees the trust model leans on.
- **Rich block editor (ProseMirror/Lexical) from day one:** the known project-killer for note apps at this team size; Markdown + typed structured data covers MVP.

## Consequences

Committed to TypeScript everywhere, Postgres semantics, and Vercel/Supabase operational envelopes. Projection determinism becomes load-bearing (property-tested). The two-client choice doubles UI work for screens — accepted for capture quality; Gate 5 explicitly revisits it. Port boundaries (`OrganizationModel`, `OrganizationJobRunner`) are the sanctioned escape hatches; bypassing them requires a superseding ADR.
