#!/usr/bin/env bash
# Fails the build on a high or critical advisory in the production dependency graph, and only on
# that. `pnpm audit` exits non-zero both when it finds advisories and when it cannot reach the
# registry, so a registry timeout used to fail every lane for reasons that had nothing to do with
# the change under test.
#
# The verdict is read from the JSON report rather than from prose, so a real advisory can never be
# mistaken for a network failure. pnpm's own fetch retries are turned off and the timeout is
# short, because this script does the retrying: layering one backoff on another turned "npm is
# down" into four minutes of waiting.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
attempts="${UNFILED_AUDIT_ATTEMPTS:-3}"
export npm_config_fetch_retries=0
export npm_config_fetch_timeout="${UNFILED_AUDIT_TIMEOUT_MS:-20000}"
report=""

for attempt in $(seq 1 "$attempts"); do
  report="$(pnpm audit --prod --audit-level high --json 2>/dev/null)"
  verdict="$(
    printf '%s' "$report" | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        let value;
        try {
          value = JSON.parse(input);
        } catch {
          process.stdout.write("unreachable");
          return;
        }
        const counts = value?.metadata?.vulnerabilities ?? {};
        const serious = Number(counts.high ?? 0) + Number(counts.critical ?? 0);
        process.stdout.write(serious > 0 ? String(serious) : "clean");
      });
    '
  )"
  case "$verdict" in
    clean)
      echo "No high or critical advisories in the production dependency graph."
      exit 0
      ;;
    unreachable)
      echo "Attempt $attempt of $attempts could not reach the advisory registry." >&2
      [ "$attempt" -lt "$attempts" ] && sleep $((attempt * 5))
      ;;
    *)
      echo "$report"
      echo "$verdict high or critical advisories in the production dependency graph." >&2
      exit 1
      ;;
  esac
done

echo "::warning::The npm advisory registry was unreachable after $attempts attempts; the production dependency audit did not run for this commit."
exit 0
