# Stuck Circuit Breaker

## Trigger

Use when the organizer's circuit breaker for OpenAI or Anthropic remains open more than 15 minutes
after the provider appears healthy, oscillates repeatedly, or closes without satisfying its probe
policy. Search makes no provider request in the free beta.
The circuit breaker protects data and budget; bypassing it is not a recovery step.

## Authority

The release operator may keep the provider feature disabled, restart/roll back the owning service,
or deploy a reviewed fix. No operator may edit breaker state in durable storage, increase retry
budgets, or send user content as a test probe.

## Diagnose

1. Confirm environment, owning service, deployment hash, affected provider and registry-v2 model,
   configuration digest, breaker opened time, safe failure classes, and retry-after observations.
2. Verify provider status, DNS/TLS, egress, the affected users' own rate limits, credential
   revision, and service clock.
3. Inspect aggregate closed/open/half-open transitions and probe outcomes. Do not inspect provider
   bodies or capture/search content.
4. Determine whether instances disagree because state is process-local, a deployment is mixed, or
   clocks/configuration differ.
5. Verify capture Inbox fallback and search lexical-only degradation with a synthetic account.

Stop for security review if a probe carried private/default content, used an unknown credential/model,
or logged an authorization/header/body value.

## Recover

1. Keep the affected provider feature disabled while diagnosing.
2. Correct budget, credential, network, or provider configuration through its approved procedure.
3. If the breaker implementation/configuration regressed, roll back the owning deployment; do not
   hot-edit state.
4. Allow the configured cooldown to elapse. Use the built-in single bounded half-open probe with a
   non-sensitive synthetic fixture on a synthetic account holding a low-value key for that provider.
5. Require the configured success count before normal traffic. If it reopens, return to
   [provider outage](./provider-outage.md) and keep fallback active.

## Verification

- all active instances report one coherent breaker state and deployment;
- a forced provider failure reopens the breaker within policy without duplicate retries;
- capture remains durable and explicit search remains lexical-only while open;
- three allowed synthetic requests succeed after closing;
- token/cost budgets and alerting remain effective;
- privacy canary is zero-hit if logging/configuration changed.

## Evidence

Record state transitions and timestamps, safe failure counts, deployment/configuration digest,
provider status reference, recovery/rollback action, synthetic probe case IDs/outcomes, fallback
verification, re-enable approval, and follow-up for state-coordination or alert tuning.
