# Organizer Backlog

## Trigger and risk

Use when organizer queue oldest age exceeds two minutes, terminal/retry rate rises, recovery cron
fails, or users have durable captures without timely receipts. A backlog is not permission to run
unbounded drains: leases, provider budgets, database capacity, and idempotency boundaries remain in
force.

## Authority

The release operator may pause new AI organization, invoke the authenticated recovery drain, and
adjust claim/concurrency only within already validated limits. The database operator may run
reviewed aggregate diagnostics. Only a reviewed deployment may change bounds or retry policy.

## Diagnose

1. Confirm exact web and organizer deployment hashes, environment, recovery-cron delivery, and
   app-level OIDC caller readiness.
2. Query reviewed content-free aggregates: jobs by state, oldest eligible age, lease count/age,
   recovered/requeued/dead-lettered count, attempt buckets, safe failure codes, and receipt latency.
3. Check exact organizer database identity, eleven-RPC allowlist, pool saturation, statement
   timeouts, root-ring status, and per-provider (OpenAI/Anthropic) safe error class, including
   `provider_key_invalid` and no-key Inbox fallbacks.
4. Compare accepted-capture count with jobs and terminal receipts. Use counts/digests, never capture
   IDs or text in the incident record.
5. Determine whether the backlog is capacity, dependency outage, poison/invalid-plan, lease churn,
   deployment mismatch, or scheduler failure.

Stop and escalate as S1 if counts imply an accepted capture is missing or duplicated, a cross-owner
write is possible, or a job bypassed the exact lease/RPC boundary. Use the provider/key-custody/
database runbook for the corresponding dependency failure.

## Recover

1. If safe fallback is working but the queue is growing, disable new AI organization while
   preserving durable capture and Inbox behavior.
2. Repair scheduler/OIDC caller configuration or roll back the mismatched service deployment.
3. Invoke one authenticated content-free recovery drain. Record start/end counts and outcome, not the
   response body.
4. Repeat only after leases from the prior wave settle. Never run overlapping manual drains or alter
   lease tokens/state directly.
5. Raise claim/concurrency only to a configuration already covered by deadline, database, provider,
   and lease tests. Reduce it again if timeouts, throttling, or pool contention rise.
6. Poison jobs follow the implemented retry/dead-letter terminal path. Do not edit plans, ciphertext,
   attempt counters, or destinations to clear the queue.
7. Re-enable AI organization for synthetic traffic, then a small cohort, while observing queue age
   and receipt reconciliation.

## Verification

- oldest eligible age remains below two minutes for 30 minutes;
- no orphan accepted capture, duplicate job, duplicate receipt, or live expired lease exists;
- dead-letter growth stops and each terminal state has a safe documented reason;
- one response-loss replay returns the original receipt without another mutation;
- Inbox fallback and manual notes remain usable during an injected organizer failure;
- monitoring and recovery cron report fresh success.

## Rollback, escalation, and evidence

If the backlog began with a deployment, use [deployment rollback](./deployment-rollback.md) for the
complete compatible set. If recovery cannot reduce age within the page threshold, keep AI disabled
and page the database/provider/key-recovery owner as appropriate.

Record deployment digest, trigger/clear times, aggregate state/age buckets, dependency classification,
manual drain count/outcomes, configuration before/after, reconciliation result, feature state, and
approvals.
