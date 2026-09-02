# Semantic-Search Disablement

## Purpose and triggers

Disable AI-assisted search when its root-key subset, database identity, one-use tickets, app-level
OIDC caller verification, generation coverage, privacy dispatch, latency, or telemetry cannot be
trusted. In the free beta the AI-assisted scope is lexical-strength local-hash retrieval
(`unfiled-local-hash-v1`) over the encrypted index with no provider request; "semantic search" below
refers to that scope. Safe disablement means all user search is handled by the owner-authorized
lexical path; it does not mean sending more queries to the search service.

Immediate disablement is required for:

- private/default query or content crossing the semantic boundary;
- stale/incomplete generation use, ticket replay, wrong-caller success, or unexpected RPC/KMS allow;
- query/embedding/result content in any durable sink;
- semantic failures without lexical fallback;
- unknown search deployment/embedding-profile/root/configuration.

## Authority

The release operator may disable semantic dispatch or roll back the search/web deployment. The
security owner controls re-enable after privacy/custody findings. Database/root-ring changes use
their own authorized runbooks.

## Disable

1. Confirm environment, web/search deployment hashes, current feature state, incident, and safe
   rollback target.
2. Activate the reviewed control that makes web ignore semantic results and issue no new search
   tickets: remove `UNFILED_SEARCH_ORIGIN` from the web Production scope and redeploy web. If that is
   unavailable, roll back web to the last lexical-only deployment and keep the search project
   unreachable from web.
3. Stop any semantic synthetic monitor that submits query material; keep shallow liveness and
   content-free readiness monitoring.
4. Do not disable lexical search, manual notes, export, deletion, or durable capture unless separately
   unsafe.
5. Let already claimed one-use tickets expire. Do not extend, reclaim, inspect, or delete tickets by
   direct table edits.

## Verify disablement

Using a synthetic owner and unique non-sensitive query:

- all/default/private/manual searches return only lexical results or the documented lexical empty
  state;
- web creates no semantic ticket and makes no request to the search service;
- search-service query count remains zero for the verification window (there is no provider usage
  to check in local-hash mode);
- POST/no-store and URL query privacy remain correct;
- stale/incomplete generation state cannot change the lexical result;
- user disclosure accurately says AI-assisted search is unavailable/disabled.

Search the configured sinks for the synthetic query digest and require zero plaintext hits. Never
put the query itself in evidence.

## Diagnose and recover

Follow the matching index, key-custody, database-login, or deployment runbook. A candidate fix must
pass ticket normalization/digest parity, 30-second expiry, single-claim race, replay/wrong-caller/
wrong-secret denial, exact five-RPC ACL, no-owner request shape, root-subset denials,
stale-generation fallback, cursor binding, owner hydration, and canary tests.

Re-enable only after:

1. the exact search deployment, embedding profile (`unfiled-local-hash-v1`/512), database identity,
   OIDC caller configuration, root subset, and active generation are recorded and verified;
2. one synthetic explicit AI-assisted query succeeds;
3. injected root/coverage failure yields lexical-only;
4. private/default queries create no search traffic;
5. cloud canary-log audit is zero-hit;
6. release operator and, when applicable, security owner approve.

## Rollback, escalation, and evidence

Rollback must keep web/search contracts compatible and cannot reuse organizer/worker credentials,
provider keys, roles, or root material. Escalate any unexpected allow or disclosure as S1.

Record trigger, disable/verify times, deployment/configuration/generation digests, feature state,
traffic zero-count evidence, lexical verification, root cause/fix, ticket/ACL/root/canary
results, approvals, and user-visible limitation.
