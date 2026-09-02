# Organizer Lease Conflict and Forced-Review Spike

## Trigger and distinction

Use when lease-loss/conflict events rise, a job repeatedly replans, or forced-Review outcomes exceed
2% weekly, three times the 24-hour baseline, or 10% weekly. Separate:

- expected Review caused by ambiguous user intent;
- safe forced Review caused by revision, privacy, rule, or generation changes;
- infrastructure lease churn or stale deployment behavior;
- unsafe application behavior such as writing after lease loss.

Only the first two are normal product outcomes. Writing after lease loss, stale-CAS bypass, or a
cross-owner candidate is S1.

## Authority

The release operator may pause AI organization or roll back a deployment. The database operator may
inspect reviewed state aggregates. Product-policy thresholds or routing bands change only through a
reviewed code/evaluation release, never during incident response.

## Diagnose

1. Confirm organizer/web deployment hashes, database migration head, prompt/schema/model/routing-rule
   registry versions, and incident window.
2. Inspect aggregate lease acquired/lost/expired counts, job attempts, forced-Review reason-code
   buckets, current-revision conflicts, privacy/rule changes, provider latency, database timeout,
   and queue age.
3. Verify system clocks and platform duration remain inside the validated request/lease budget.
4. Compare rate by deployed version and by synthetic versus beta traffic using only aggregate or
   one-way pseudonymous cohorts.
5. Reproduce with frozen synthetic fixtures. Never inspect or replay a user's capture text.

Stop if a reason code is absent/unbounded, telemetry exposes decision content, a mutation commits
after lease loss, or an operator would need to change a row/lease manually.

## Contain and recover

1. If correctness is uncertain, disable AI organization. Durable capture continues to Inbox.
2. If a deployment or configuration version correlates with the spike, roll back the complete
   compatible service set. Do not change routing bands live.
3. For dependency latency, follow the provider, database, or key-custody runbook and keep forced Review as
   the safe outcome.
4. Let expired jobs recover through the bounded recovery RPC. Do not steal or clear leases manually.
5. If the spike is caused by a legitimate product pattern, keep traffic safe and open a product
   investigation using synthetic reproductions. Any future policy change must pass the deterministic
   corpus and live provider gate.

## Verification

- lease conflicts return to the prior baseline and no live expired lease remains;
- source/revision/privacy revalidation still forces Review rather than writing stale data;
- deterministic routing evaluation and lease/concurrency tests pass for the candidate fix;
- a response-loss replay does not produce a second decision or mutation;
- Review items expose only owner-authorized safe actions;
- queue and receipt latency remain within thresholds for 30 minutes.

## Escalation and evidence

Escalate to security for any stale/cross-owner write or telemetry disclosure; otherwise to database,
provider, or platform support based on the safe failure class.

Record rate/baseline, reason buckets, lease/latency aggregates, version comparison, synthetic case
IDs, containment, evaluation run references, re-enable approval, and unresolved product follow-up.
