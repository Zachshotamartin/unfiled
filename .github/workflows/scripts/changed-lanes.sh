#!/usr/bin/env bash

# Names which CI lanes a change can affect, from the files it touches, so a pull request that only
# edits the phone app does not rebuild the servers and a server change does not rent a macOS
# runner. Two lanes are named:
#
#   ios  anything under apps/ios, the iOS workflow, or its scripts
#   web  anything that is not purely iOS
#
# package.json and pnpm-lock.yaml belong to both: the ios:* scripts and the XcodeGen pin live there.
#
# Usage: changed-lanes.sh <base-sha> <head-sha>
# Prints exactly two lines, "web=true|false" and "ios=true|false", in GITHUB_OUTPUT form.
#
# The comparison is the merge base of the two commits against the head, which is what the pull
# request shows. Whenever the answer cannot be computed -- an unknown base (a new branch), a base
# git no longer has (a force push), or an unreadable diff -- every lane runs. Skipping is only ever
# the result of a diff that was actually read.

set -euo pipefail

readonly BASE_SHA="${1:-}"
readonly HEAD_SHA="${2:-}"
readonly IOS_ONLY_PATTERN='^(apps/ios/|\.github/workflows/ci-ios\.yml$|\.github/workflows/scripts/ios-)'
readonly SHARED_PATTERN='^(package\.json|pnpm-lock\.yaml)$'

emit() {
  printf 'web=%s\nios=%s\n' "$1" "$2"
}

run_everything() {
  printf 'changed-lanes: %s; every lane runs.\n' "$1" >&2
  emit true true
  exit 0
}

[[ "${BASE_SHA}" =~ ^[0-9a-f]{7,40}$ && ! "${BASE_SHA}" =~ ^0+$ ]] ||
  run_everything "the base commit is unknown (${BASE_SHA:-unset})"
[[ "${HEAD_SHA}" =~ ^[0-9a-f]{7,40}$ ]] ||
  run_everything "the head commit is unknown (${HEAD_SHA:-unset})"

merge_base="$(git merge-base "${BASE_SHA}" "${HEAD_SHA}" 2>/dev/null)" ||
  run_everything "no merge base between ${BASE_SHA} and ${HEAD_SHA}"
files="$(git diff --name-only "${merge_base}" "${HEAD_SHA}" 2>/dev/null)" ||
  run_everything "could not diff ${merge_base}..${HEAD_SHA}"

web=false
ios=false
while IFS= read -r file; do
  [[ -n "${file}" ]] || continue
  if [[ "${file}" =~ ${IOS_ONLY_PATTERN} ]]; then
    ios=true
  elif [[ "${file}" =~ ${SHARED_PATTERN} ]]; then
    ios=true
    web=true
  else
    web=true
  fi
done <<<"${files}"

printf 'changed-lanes: %s file(s) between %s and %s.\n' \
  "$(printf '%s\n' "${files}" | grep -c . || true)" "${merge_base:0:7}" "${HEAD_SHA:0:7}" >&2
emit "${web}" "${ios}"
