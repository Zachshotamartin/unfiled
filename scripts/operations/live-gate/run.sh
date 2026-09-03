#!/usr/bin/env bash
# The release gate. Every real operation the product offers runs against the target origin with
# synthetic accounts, from two clients: the HTTP API (Node) and the iPhone app's own model (XCTest
# on the simulator). Deploy and merge refuse to proceed unless this gate is green for the commit.
#
# Usage: scripts/operations/live-gate/run.sh [production|<origin>] [--skip-phone]
# Secrets are read from the environment or the login keychain and are never printed:
#   UNFILED_GATE_OPENAI_API_KEY   (or keychain service "unfiled-gate" account "OPENAI_API_KEY")
#   UNFILED_GATE_CRON_SECRET      (or keychain service "unfiled-beta-web-secret" account "CRON_SECRET")
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TARGET="${1:-production}"
SKIP_PHONE="${2:-}"
case "$TARGET" in
  production) ORIGIN="https://unfiled-web.vercel.app" ;;
  http*) ORIGIN="$TARGET" ;;
  *) echo "unknown target: $TARGET" >&2; exit 2 ;;
esac
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
OUT_DIR="${UNFILED_GATE_DIR:-$ROOT/.live-gate}"
mkdir -p "$OUT_DIR"
keychain() { security find-generic-password -s "$1" -a "$2" -w 2>/dev/null || true; }
export UNFILED_GATE_WEB_ORIGIN="$ORIGIN"
export UNFILED_GATE_OPENAI_API_KEY="${UNFILED_GATE_OPENAI_API_KEY:-$(keychain unfiled-gate OPENAI_API_KEY)}"
export UNFILED_GATE_CRON_SECRET="${UNFILED_GATE_CRON_SECRET:-$(keychain unfiled-beta-web-secret CRON_SECRET)}"
[ -n "$UNFILED_GATE_OPENAI_API_KEY" ] || echo "note: no organizer key; organizer-dependent steps will fail as no_key" >&2

status=0
echo "== live gate: api ($ORIGIN, commit ${COMMIT:0:7})"
UNFILED_GATE_OUTPUT="$OUT_DIR/api-$COMMIT.json" node "$ROOT/scripts/operations/live-gate/api-gate.mjs" || status=1

if [ "$SKIP_PHONE" != "--skip-phone" ]; then
  echo "== live gate: phone (simulator, the app's own model)"
  S="${UNFILED_GATE_DERIVED_DATA:-$OUT_DIR/derived-data}"
  ( cd "$ROOT/apps/ios" && TEST_RUNNER_UNFILED_LIVE_GATE=1 \
      TEST_RUNNER_UNFILED_LIVE_GATE_API_BASE_URL="$ORIGIN/api/v1" \
      TEST_RUNNER_UNFILED_LIVE_GATE_OPENAI_API_KEY="$UNFILED_GATE_OPENAI_API_KEY" \
      xcodebuild -project Unfiled.xcodeproj -scheme Unfiled -configuration Debug -sdk iphonesimulator \
        -destination "platform=iOS Simulator,name=${UNFILED_GATE_SIMULATOR:-iPhone 17 Pro}" \
        -derivedDataPath "$S" -only-testing:UnfiledTests/LiveGateTests test > "$OUT_DIR/phone-$COMMIT.log" 2>&1 ) || status=1
  grep -E "^(pass|FAIL)  |live gate \(phone\)|TEST (SUCCEEDED|FAILED)" "$OUT_DIR/phone-$COMMIT.log" | sed 's/^.*\(pass\|FAIL\)  /\1  /' || true
fi

if [ $status -eq 0 ]; then
  printf '{"commit":"%s","origin":"%s","finishedAt":"%s","status":"green"}\n' "$COMMIT" "$ORIGIN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT_DIR/gate-$COMMIT.json"
  echo "== live gate GREEN for $COMMIT"
else
  rm -f "$OUT_DIR/gate-$COMMIT.json"
  echo "== live gate RED for $COMMIT" >&2
fi
exit $status
