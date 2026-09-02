# ADR-0014: Launch-name candidate and public-channel proof

- Status: accepted as a working identity; public release blocked on clearance and control
- Date: 2026-09-02
- Decision owner: product owner
- Related records: [ADR-0003](./ADR-0003-native-identifiers.md), [ADR-0010](./ADR-0010-native-ios-client-replacement.md), [NAME_CLEARANCE.md](../NAME_CLEARANCE.md), [BRAND_SYSTEM_UNFILED.md](../BRAND_SYSTEM_UNFILED.md)

## Context

The product needs one stable working identity across the repository, web client, native iPhone app, WidgetKit extension, design system, demo, and portfolio story. The product owner selected **Unfiled** and rejected continuing under an earlier placeholder name.

A creative selection is not the same as trademark clearance or operational control. The repository contains references to `unfiled.app`, candidate email addresses, native identifiers, and the Unfiled wordmark, but source code cannot prove:

- legal availability in an intended jurisdiction or product class;
- ownership or recovery control of a domain;
- mapping of that domain to the intended Vercel project and deployment commit;
- inbound/outbound delivery and monitoring of a mailbox;
- App Store display-name availability or Apple Developer registration;
- package, repository, or social-handle control; or
- the right to make a production, privacy, security, or availability claim.

ADR-0003 already accepted production-shaped native identifiers using the `com.zachshotamartin.unfiled` namespace. Those identifiers are technical identifiers and may be difficult to change after Apple records and user data exist. They must not be silently rewritten as part of a marketing rename.

## Decision

Use **Unfiled** as the selected launch candidate and working product identity while completing Milestone G.

This decision authorizes:

- repository and internal documentation names;
- implementation copy needed to test the product and brand system;
- the lowercase `unfiled` wordmark as a working creative asset;
- preparation of demo, architecture, status, roadmap, legal-draft, and portfolio materials; and
- continued use of ADR-0003's identifiers in source until an explicit superseding decision is accepted.

This decision does **not** declare:

- trademark or legal clearance;
- ownership of `unfiled.app` or any other domain;
- control of a Vercel project, alias, deployment, or DNS account;
- operation of `hello@`, `support@`, `security@`, or another mailbox;
- App Store name approval, Apple identifier registration, signing, or provisioning;
- control of package-registry or social accounts;
- a production launch; or
- completion of Milestone G.

No domain or mailbox becomes canonical merely because it appears in code or resolves publicly. Canonical status requires the non-secret control evidence specified in [NAME_CLEARANCE.md](../NAME_CLEARANCE.md).

## Public-copy rule while blocked

Before clearance and control evidence is accepted, public-facing release material must use language equivalent to:

> Unfiled is the selected launch candidate for this portfolio implementation. Formal name clearance and production channel control are still being completed.

Do not say “official domain,” “available now,” “production,” “cleared,” or “contact us at” unless the exact underlying channel has been proved and assigned an owner.

Brand phrases such as `Just write. It finds its place.` remain working creative copy. They must still pass ordinary legal, accessibility, product-truth, and channel review before publication.

## Native identifier rule

Until a superseding ADR says otherwise:

- keep the ADR-0003 host, widget, App Group, and environment-specific URL scheme values stable in source;
- treat a marketing display-name change separately from the opaque identifiers;
- do not create duplicate Apple records to experiment with names;
- do not claim the identifiers are registered based on unsigned Simulator builds; and
- preserve native SQLCipher/outbox/profile data through any later display-name migration.

If name clearance fails before Apple production registration, a superseding ADR may choose new identifiers after assessing migration and coexistence. If it fails after registration, the default evaluation is to retain opaque bundle/App Group identifiers and change only user-visible naming, subject to Apple rules and legal review.

## Required evidence before final acceptance

The release owner must complete and cite the evidence register in `docs/NAME_CLEARANCE.md` for the actual launch scope:

1. legal/trademark review;
2. App Store name and Apple Developer identifiers;
3. registrar, DNS, TLS, Vercel project/alias/deployment control;
4. monitored general, support, privacy, and security mailboxes;
5. selected package/repository/social/video channels; and
6. consistent reviewed privacy, terms, support, security, demo, README, and final-report copy.

Private evidence stays in the approved account or legal record. The public repository stores only dates, outcomes, non-secret references, and responsible owners.

## Failure and rename path

If Unfiled is not acceptable for the intended scope:

1. stop new public asset, paid media, store, and channel investment;
2. choose a new candidate through the same clearance process;
3. accept a superseding ADR covering display name, domain, contacts, native-identifier treatment, redirects, migration, and support continuity;
4. update the brand system and public content from one canonical inventory;
5. preserve authenticated user data, local encrypted stores, outboxes, deep-link compatibility, and deletion/export rights; and
6. keep a time-bounded redirect and vulnerability-reporting path for any previously published channel under the owner's control.

Do not partially rename only the UI while leaving conflicting policy, domain, App Store, email, or support identity.

## Consequences

Positive consequences:

- engineering and design can use one explicit working name;
- release copy has a clear claim boundary;
- domain resolution cannot be mistaken for project ownership;
- legal and operational work has a concrete evidence checklist; and
- native identifiers cannot drift through ad hoc marketing changes.

Costs and constraints:

- public launch remains blocked until human/account evidence exists;
- some draft copy must remain provisional;
- a failed clearance review may require a coordinated rename; and
- the final report must preserve pending rows rather than inferring completion from continued use of the name.

## Review trigger

Review this ADR when any of the following occurs:

- the clearance evidence reaches a clear, conditional, or rename-required outcome;
- a canonical domain or published mailbox is proposed;
- Apple production records or an App Store listing are created;
- ownership of a public channel changes;
- a legal conflict, impersonation risk, or deliverability failure is reported; or
- the product owner selects another launch candidate.

When the evidence is complete, amend the status through a new decision record or a narrowly documented status transition. Do not rewrite the history to imply clearance existed on 2026-09-02.
