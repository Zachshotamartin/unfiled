#!/usr/bin/env bash

# A release may only ship a commit whose tests have already passed. This asks GitHub which CI runs
# exist for the exact commit under release and requires one of them to have concluded successfully.
# Nothing is inferred from a branch name or from a run that is still going: a merge that arrives
# while CI is running is not releasable yet, and a merge whose CI went red never becomes releasable.
#
# Environment:
#   GH_TOKEN             a token with actions: read on this repository
#   GITHUB_REPOSITORY    owner/name, set by Actions
#   RELEASE_SHA          the forty-character commit being released
#   UNFILED_CI_WORKFLOW  the CI workflow file to require (default ci.yml)

set -euo pipefail

readonly CI_WORKFLOW="${UNFILED_CI_WORKFLOW:-ci.yml}"
readonly ATTEMPTS=5
readonly ATTEMPT_PAUSE_SECONDS=6

fail() {
  printf 'Release refused: %s\n' "$1" >&2
  exit 1
}

[[ -n "${GITHUB_REPOSITORY:-}" ]] || fail 'GITHUB_REPOSITORY is not set.'
[[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "RELEASE_SHA is not a commit: ${RELEASE_SHA:-<unset>}"

# The runs listing can lag a run that has only just finished, so this asks a few times before it
# concludes there is no green run. It concludes nothing else: an absent, failed, cancelled or
# still-running CI run all leave the commit unreleasable, and so does an unreadable API.
attempt=1
while ((attempt <= ATTEMPTS)); do
  conclusions="$(
    gh api \
      "repos/${GITHUB_REPOSITORY}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${RELEASE_SHA}&per_page=100" \
      --jq '.workflow_runs[] | .conclusion // "in_progress"'
  )" || fail "Could not read the ${CI_WORKFLOW} runs for ${RELEASE_SHA} from GitHub."

  if printf '%s\n' "${conclusions}" | grep -qx 'success'; then
    printf 'CI is green for %s.\n' "${RELEASE_SHA}"
    exit 0
  fi

  printf 'Attempt %d of %d found no green %s run for %s (conclusions: %s).\n' \
    "${attempt}" "${ATTEMPTS}" "${CI_WORKFLOW}" "${RELEASE_SHA}" \
    "$(printf '%s' "${conclusions:-none}" | tr '\n' ' ')" >&2
  if ((attempt < ATTEMPTS)); then
    sleep "${ATTEMPT_PAUSE_SECONDS}"
  fi
  attempt=$((attempt + 1))
done

fail "No successful ${CI_WORKFLOW} run exists for ${RELEASE_SHA}. Nothing was deployed."
