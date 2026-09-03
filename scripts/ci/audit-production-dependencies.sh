#!/usr/bin/env bash
# Fails the build on a high or critical advisory in the production dependency graph, and only on
# that. `pnpm audit` exits non-zero both when it finds advisories and when it cannot reach the
# registry, so a registry timeout used to fail every lane for reasons that had nothing to do with
# the change under test. Unreachable is retried, then reported and allowed through; an advisory
# is always a failure.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
attempts="${UNFILED_AUDIT_ATTEMPTS:-3}"
output=""

for attempt in $(seq 1 "$attempts"); do
  output="$(pnpm audit --prod --audit-level high 2>&1)"
  status=$?
  if [ $status -eq 0 ]; then
    echo "$output"
    echo "No high or critical advisories in the production dependency graph."
    exit 0
  fi
  # An advisory report names what it found; a transport failure never does.
  if printf '%s' "$output" | grep -qiE "vulnerabilit|advisor|severity"; then
    echo "$output"
    echo "High or critical advisories found in the production dependency graph." >&2
    exit 1
  fi
  echo "Attempt $attempt of $attempts could not reach the registry." >&2
  if [ "$attempt" -lt "$attempts" ]; then sleep $((attempt * 15)); fi
done

echo "$output" >&2
echo "::warning::The npm advisory registry was unreachable after $attempts attempts; the production dependency audit did not run for this commit."
exit 0
