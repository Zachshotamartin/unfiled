# Provider Data Controls Evidence Template

## Candidate and ownership

- Candidate commit:
- Provider:
- Organizer project opaque digest:
- Search project opaque digest:
- Evaluation project opaque digest:
- Configuration date:
- Account owner:
- Security reviewer:

Keep provider project IDs, service-account IDs, keys, invoices, and console exports in restricted evidence.

## Separation and scope

| Assertion                                                             | State   | Safe observation |
| --------------------------------------------------------------------- | ------- | ---------------- |
| Organizer, search, and evaluation use separate projects/keys          | pending |                  |
| Organizer key is available only to the organizer deployment           | pending |                  |
| Search key is available only to the search deployment                 | pending |                  |
| Evaluation key is never installed in a deployed service               | pending |                  |
| Models/endpoints are pinned to reviewed choices                       | pending |                  |
| Arbitrary tools, browsing, files, and model overrides are unavailable | pending |                  |
| Rate and spend limits are configured                                  | pending |                  |
| Rotation/revocation owner is assigned and tested                      | pending |                  |
| BYOK is resolved only through the live-lease path                     | pending |                  |

## Data controls

- Responses application storage setting:
- Embeddings storage behavior (n/a in the free beta: retrieval is `unfiled-local-hash-v1` in process):
- Provider(s) exercised with a user key (OpenAI / Anthropic):
- Abuse-monitoring retention:
- Modified Abuse Monitoring approval:
- Zero Data Retention approval:
- Training/data-sharing opt-in state:
- Provider region or transfer posture:
- Policy/documentation review date:

The Responses store setting must not be represented as a blanket zero-retention control. If a control is not explicitly approved for the exact project and endpoint, record the ordinary provider posture.

## Live evaluation and canary

- Deterministic routing gate:
- Production-component seam:
- Credentialed stochastic evaluation report digest:
- Model/prompt/schema pins:
- Worst-of safety result:
- Latency/token/cost summary:
- Canary-log audit reference:
- Outage/fallback result:

## Result

- Organizer provider readiness: pending
- Search provider readiness: pending
- BYOK production readiness: pending
- Restricted evidence reference:
- Combined SHA-256:
- Reviewer sign-off:
