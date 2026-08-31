# ADR-0001: Foundational technology and scope choices

- Status: accepted; mobile-client portion superseded by ADR-0010
- Date: 2026-08-30
- Last updated: 2026-08-31
- Decision drivers: solo part-time developer; portfolio-quality reliability bar; phone-first capture thesis; trust model (receipts, undo) as the differentiator; minimize novel infrastructure.

## Context

Unfiled needs a stack and scope posture before design and bootstrap. The product's risk is trust and reliability, not rendering; choices should spend complexity on durability and validation, not platform breadth.

## Decisions

1. **Monorepo: pnpm workspaces + Turborepo.** TypeScript remains canonical for the web, API, workflow, and shared server packages. The native iPhone client is Swift and consumes the same versioned HTTP/OpenAPI contract; it does not pretend to share a runtime with the web.
2. **Two clients, one backend:** Next.js on Vercel for web, API, and workflows; a native SwiftUI client for iPhone on iOS 17 or later. Screens are platform-specific. Contract fixtures, semantic design tokens, and behavior specifications keep the clients aligned. ADR-0010 records the client replacement and milestone boundary.
3. **Supabase** for auth, Postgres (RLS, pg_trgm, pgvector), realtime, and storage. RLS gives database-level per-user isolation testable in CI—central to the trust model.
4. **Durable organization via Vercel Workflows** behind an `OrganizationJobRunner` port; the narrow port allows a queue or dedicated worker to replace it on operational evidence.
5. **AI behind an `OrganizationModel` port with a provider registry** (see ADR-0002 for BYOK); strict schema-constrained output; model output is data, never authority.
6. **Canonical content per note type:** Markdown canonical for prose types; `structured_data` canonical for `list`/`log` with deterministic Markdown projection. This enables interactive surfaces without a custom block editor.
7. **One typed-operation pipeline for AI and user interactions**—identical validation, revision preconditions, mutation records, and undo. Two callers, one write boundary.
8. **Scope posture:** capture→route→receipt→correct→undo before breadth (no collaboration, publishing, graphs, voice, or imports in MVP). Design sprint (Milestone 0) precedes bootstrap.

## Alternatives considered

- **Local-first sync engine (CRDTs, e.g. Automerge/Yjs):** strongest offline story but weeks of sync-engine work orthogonal to the routing thesis; revisit only if local-first becomes the thesis (BUILD_PLAN §24).
- **One cross-platform UI runtime:** initially selected, then superseded after the Lock Screen, encrypted local persistence, platform navigation, and accessibility surfaces made the native boundary the more reliable choice. See ADR-0010.
- **Custom Node worker + queue (BullMQ/SQS) for jobs:** more control, more operations burden for one person; the port keeps this as an exit.
- **Convex / Firebase:** good developer experience; weaker fit for RLS-style testable isolation and SQL-level guarantees the trust model uses.
- **Rich block editor (ProseMirror/Lexical) from day one:** the known project-killer for a team this size; Markdown + typed structured data covers MVP.

## Consequences

The repository is no longer one-language end to end. Swift model and transport tests must prove compatibility with the versioned API and representative fixtures. The native client owns its local persistence, lifecycle, navigation, accessibility, and widget behavior; server packages remain independent of client frameworks. Projection determinism remains load-bearing and property-tested. The two-client choice doubles UI work for shared screens but protects the product's quick-capture quality. Port boundaries (`OrganizationModel`, `OrganizationJobRunner`) remain the sanctioned infrastructure escape hatches; bypassing them requires a superseding ADR.

## Superseded history

The first accepted version selected a cross-platform JavaScript client for two mobile operating systems and described TypeScript as universal. That decision is retained in version control as historical evidence, but ADR-0010 replaces it for all current planning, CI, setup, and release claims.
