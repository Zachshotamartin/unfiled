#!/usr/bin/env bash

# A release may only ship a commit whose tests have already passed. This asks GitHub which runs of
# each required CI workflow exist for the exact commit under release and requires every one of them
# to have concluded successfully. Nothing is inferred from a branch name: a merge whose CI went red
# never becomes releasable, and a merge whose CI is still running is waited for, not skipped.
#
# The release is started by the server workflow finishing; the phone workflow (ci-ios.yml) may
# still be running for the same commit, so a run in progress is polled until it concludes or the
# wait runs out. When the commit touched nothing under apps/ios that workflow reports in seconds.
#
# Environment:
#   GH_TOKEN                 a token with actions: read on this repository
#   GITHUB_REPOSITORY        owner/name, set by Actions
#   RELEASE_SHA              the forty-character commit being released
#   UNFILED_CI_WORKFLOWS     space-separated workflow files to require (default "ci.yml ci-ios.yml")
#   UNFILED_CI_WAIT_MINUTES  how long to wait for a run still in progress (default 30)

set -euo pipefail

readonly CI_WORKFLOWS="${UNFILED_CI_WORKFLOWS:-ci.yml ci-ios.yml}"
readonly WAIT_MINUTES="${UNFILED_CI_WAIT_MINUTES:-30}"
readonly POLL_SECONDS=30
readonly LISTING_ATTEMPTS=5
readonly LISTING_PAUSE_SECONDS=6

fail() {
  printf 'Release refused: %s\n' "$1" >&2
  exit 1
}

[[ -n "${GITHUB_REPOSITORY:-}" ]] || fail 'GITHUB_REPOSITORY is not set.'
[[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "RELEASE_SHA is not a commit: ${RELEASE_SHA:-<unset>}"
[[ "${WAIT_MINUTES}" =~ ^[0-9]+$ ]] || fail "UNFILED_CI_WAIT_MINUTES is not a number: ${WAIT_MINUTES}"

# Every conclusion of every run of one workflow for the commit, one per line; a run that has not
# concluded reads "in_progress". An unreadable API leaves the commit unreleasable.
conclusions_of() {
  gh api \
    "repos/${GITHUB_REPOSITORY}/actions/workflows/$1/runs?head_sha=${RELEASE_SHA}&per_page=100" \
    --jq '.workflow_runs[] | .conclusion // "in_progress"'
}

require_green() {
  local workflow="$1"
  local deadline=$((SECONDS + WAIT_MINUTES * 60))
  local listing_attempt=1
  local conclusions

  while :; do
    conclusions="$(conclusions_of "${workflow}")" ||
      fail "Could not read the ${workflow} runs for ${RELEASE_SHA} from GitHub."

    if printf '%s\n' "${conclusions}" | grep -qx 'success'; then
      printf '%s is green for %s.\n' "${workflow}" "${RELEASE_SHA}"
      return 0
    fi

    # The runs listing can lag a run that was only just created, so an empty listing is asked
    # again a few times before it means the run does not exist.
    if [[ -z "${conclusions}" ]]; then
      if ((listing_attempt < LISTING_ATTEMPTS)); then
        printf 'Attempt %d of %d found no %s run for %s yet.\n' \
          "${listing_attempt}" "${LISTING_ATTEMPTS}" "${workflow}" "${RELEASE_SHA}" >&2
        listing_attempt=$((listing_attempt + 1))
        sleep "${LISTING_PAUSE_SECONDS}"
        continue
      fi
      fail "No ${workflow} run exists for ${RELEASE_SHA}. Nothing was deployed."
    fi

    if printf '%s\n' "${conclusions}" | grep -qx 'in_progress'; then
      if ((SECONDS < deadline)); then
        printf '%s is still running for %s; waiting (%d s left).\n' \
          "${workflow}" "${RELEASE_SHA}" "$((deadline - SECONDS))" >&2
        sleep "${POLL_SECONDS}"
        continue
      fi
      fail "${workflow} was still running for ${RELEASE_SHA} after ${WAIT_MINUTES} minutes. Nothing was deployed."
    fi

    fail "No successful ${workflow} run exists for ${RELEASE_SHA} (conclusions: $(printf '%s' "${conclusions}" | tr '\n' ' ')). Nothing was deployed."
  done
}

for workflow in ${CI_WORKFLOWS}; do
  require_green "${workflow}"
done
printf 'CI is green for %s.\n' "${RELEASE_SHA}"
