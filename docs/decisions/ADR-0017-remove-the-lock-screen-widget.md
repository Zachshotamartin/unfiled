# ADR-0017: Remove the Lock Screen widget

Status: accepted (2026-09-02). Supersedes the widget portions of ADR-0010.

## Context

The native app shipped a WidgetKit Lock Screen extension whose only action was an App Intent that
opened the app to a focused capture composer. On the first physical-device install the owner found
it half width and unable to accept text, and rejected it: a capture surface that cannot take input
has no value for this product. Two Apple platform limits are fixed: WidgetKit exposes no text input
in any widget family, and the Lock Screen rectangular family is always half width.

## Decision

Remove the `QuickCaptureWidget` target, its App Intent, the App Group entitlement and container,
the widget snapshot store, the custom URL scheme, and every CI and release-evidence check that
asserted their presence. The `ios_lock_screen_widget` capture source stays in the shared contracts
and database enum for compatibility with existing rows; no iOS code produces it any more.

Capture without unlocking the phone will be pursued through a Siri App Shortcut with a dictation or
text parameter that queues the capture in the SQLCipher outbox without opening the app, and an
Action Button binding to that shortcut (docs/ROADMAP.md G1b). No widget of any family is planned.

## Consequences

- Personal-team signing no longer needs an App Group capability.
- The unsigned CI job still carries the historical name `iOS app and widget (unsigned simulator)`
  because branch protection references it; rename it in a follow-up that also updates the rule.
- Historical plans and demo transcripts (docs/BUILD_PLAN.md, docs/demo) keep their widget
  references as records of earlier milestones.
