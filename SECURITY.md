# Security Policy

Unfiled handles personal notes, authentication credentials, encrypted content, and user-controlled AI-provider credentials. Security reports must be handled privately and must never expose another person's data.

## Current reporting status

Unfiled is a portfolio implementation and controlled-beta candidate. [GitHub private vulnerability reporting](https://github.com/Zachshotamartin/unfiled/security/advisories/new) was enabled for this repository and API-verified as active on 2026-09-02. It is the current verified private path for a suspected vulnerability. A report submitted there creates a private security advisory for repository maintainers; it must not be duplicated into a public issue.

That verification proves the repository reporting control only. The `/security` and `/.well-known/security.txt` web routes are implemented on the Milestone G branch and passed focused tests, typecheck, lint, and a Next.js production build. Their deployment at `https://unfiled-web.vercel.app` and any controlled canonical domain is recorded in `FINAL_REPORT.md`, not asserted here. Legal review, operator identity and jurisdiction decisions, custom-domain mapping, a separately monitored security mailbox, escalation coverage, and approved safe-harbor language remain pending.

Do not assume that an address at an aspirational or hardcoded domain is monitored. Do not place vulnerability details, personal data, tokens, note content, or proof-of-concept payloads in a public GitHub issue. The verified GitHub private channel resolves the repository-reporting prerequisite; it does not by itself make the product, domain, mailbox, or public security surface release-ready.

## Supported versions

There is no generally available production release yet. The main branch and the free private-beta deployment are development artifacts and receive security fixes on a best-effort basis. Vercel Preview deployments are intentionally not built. A release table will be added only after a signed native build and a deployed web release have immutable version identifiers.

## What to include

When reporting through the verified private channel, include only the minimum information needed to reproduce the issue:

- affected surface and release or deployment identifier;
- impact stated without copying user content;
- exact preconditions and a minimal reproduction against an account you control;
- content-free timestamps, request identifiers, and response status;
- whether any data was viewed, modified, or retained; and
- a safe way to coordinate follow-up.

Replace note text, email addresses, bearer tokens, cookies, provider keys, database identifiers, root-key identifiers, and device identifiers with synthetic values. Do not attach raw HAR files, production logs, database exports, crash archives, or screen recordings until a secure transfer method is agreed.

## Research boundaries

Good-faith testing must:

- use only accounts and content the researcher owns or has explicit written permission to test;
- stop immediately at the first sign of cross-account access or unexpected plaintext;
- avoid persistence, destructive actions, denial of service, automated high-volume traffic, social engineering, credential stuffing, and physical attacks;
- avoid accessing, downloading, retaining, or sharing another person's content;
- avoid testing third-party infrastructure outside the Unfiled configuration boundary; and
- allow reasonable time for remediation before disclosure.

If accidental access occurs, record only content-free evidence, stop testing, delete any local copy, and report the event through the verified private channel.

## In-scope areas after launch

- authenticated web and versioned API authorization;
- native session, Keychain, and SQLCipher boundaries;
- owner isolation and database row-level security;
- encrypted content envelopes, key context, replay protection, and deletion;
- organizer, index worker, verifier, and AI-assisted search trust separation;
- provider-key isolation: an OpenAI key must never reach Anthropic, a Claude key must never reach OpenAI, and neither may reach retrieval or an isolated non-organizer service;
- private-manual exclusion from AI-provider and retrieval paths; and
- secret, note-content, or token disclosure through responses, logs, traces, exports, or caches.

Third-party service outages and vulnerabilities that do not arise from Unfiled configuration are normally reported to that provider. A finding that exposes an Unfiled integration weakness remains in scope.

## Response process

The following are target operating practices, not a current service-level promise:

1. Privately acknowledge a complete report within 2 business days.
2. Assign a severity and containment owner without copying sensitive details into general project tools.
3. For suspected cross-user disclosure, auth bypass, content exposure, or key compromise, disable the affected path before feature work continues.
4. Confirm remediation with the reporter using synthetic data.
5. Coordinate disclosure timing and credit if requested.
6. Publish a content-free incident summary when doing so does not increase user risk.

Unfiled does not currently offer a bug bounty. Any future safe-harbor or reward program requires separate legal approval and will be stated explicitly; it must not be inferred from this document.

## Security model

Unfiled's target is application-encrypted storage with narrowly scoped server-side decryption. It is not end-to-end encrypted, zero knowledge, or immune to a compromised authorized application service. In the free private beta the content root keys are held in Vercel Sensitive Environment Variables bound to the exact project and environment ([ADR-0016](./docs/decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md)); this is not hardware-backed custody. AI-assisted content may be sent to the user's chosen provider (OpenAI or Anthropic), authenticated with the user's own key, only for an authorized organization or expansion operation; retrieval uses an in-process local-hash vector and sends nothing to a provider. Private-manual content is designed to stay outside every model and retrieval request. Checked-in implementation and local tests are not proof that cloud identities, backups, provider retention, or production deployment are configured correctly; that evidence is recorded in `FINAL_REPORT.md`.

See docs/SECURITY_AND_PRIVACY.md for the engineering threat model and docs/evidence/README.md for rules governing public release evidence.
