#!/usr/bin/env bash
# The release gate. Every real operation the product offers runs against the target origin with
# synthetic accounts, from two clients: the HTTP API (Node) and the iPhone app's own model (XCTest
# on the simulator). Deploy and merge refuse to proceed unless this gate is green for the commit.
#
# Usage: scripts/operations/live-gate/run.sh [production|<origin>] [--skip-phone]
# Usage flags: --skip-phone runs the API gate only; --phone-only runs the simulator gate only.
#   UNFILED_GATE_API_SCRIPT  path of the API gate to run (default: this checkout's); the deploy
#                            script points it at the deployed commit's gate for the pre-deploy check
# Secrets are read from the environment or the login keychain and are never printed:
#   UNFILED_GATE_OPENAI_API_KEY   (or .env.live-gate at the repo root, or keychain "unfiled-gate"/"OPENAI_API_KEY")
#   UNFILED_GATE_CRON_SECRET      (or keychain service "unfiled-beta-web-secret" account "CRON_SECRET")
#   UNFILED_GATE_SUPABASE_URL     (or keychain "unfiled-gate"/"SUPABASE_URL")
#   UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY
#                                 (or keychain "unfiled-gate"/"SUPABASE_SERVICE_ROLE_KEY"). A
#                                 deployment that confirms addresses emails six digits before a new
#                                 account can sign in, so both gates confirm the synthetic account
#                                 they create through Supabase's admin API. Both values are
#                                 required, and a run without them stops here in seconds rather
#                                 than half running.
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
# A gitignored .env.live-gate at the repo root is the other way to supply the secrets.
if [ -f "$ROOT/.env.live-gate" ]; then set -a; . "$ROOT/.env.live-gate"; set +a; fi
export UNFILED_GATE_WEB_ORIGIN="$ORIGIN"
export UNFILED_GATE_OPENAI_API_KEY="${UNFILED_GATE_OPENAI_API_KEY:-$(keychain unfiled-gate OPENAI_API_KEY)}"
export UNFILED_GATE_CRON_SECRET="${UNFILED_GATE_CRON_SECRET:-$(keychain unfiled-beta-web-secret CRON_SECRET)}"
export UNFILED_GATE_SUPABASE_URL="${UNFILED_GATE_SUPABASE_URL:-$(keychain unfiled-gate SUPABASE_URL)}"
export UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY="${UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY:-$(keychain unfiled-gate SUPABASE_SERVICE_ROLE_KEY)}"
[ -n "$UNFILED_GATE_OPENAI_API_KEY" ] || echo "note: no organizer key; organizer-dependent steps will fail as no_key" >&2
# Neither gate can create a usable account on a deployment that confirms addresses without admin
# access, so a misconfigured run says what it needs before it builds anything or signs anyone up.
missing=""
[ -n "$UNFILED_GATE_SUPABASE_URL" ] || missing="UNFILED_GATE_SUPABASE_URL"
[ -n "$UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY" ] || missing="${missing:+$missing and }UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY"
if [ -n "$missing" ]; then
  echo "live gate cannot start: set $missing. A deployment that confirms addresses emails a code before a new account can sign in, so the gate confirms its own synthetic account through Supabase admin." >&2
  exit 2
fi

# The deploy path runs the deployed commit's gate by extracting that one file, so the module the
# gate imports travels next to it. Its only job is Supabase admin access, which every commit that
# has this gate reads the same way.
API_SCRIPT="${UNFILED_GATE_API_SCRIPT:-$ROOT/scripts/operations/live-gate/api-gate.mjs}"
API_SCRIPT_DIR="$(cd "$(dirname "$API_SCRIPT")" 2>/dev/null && pwd)"
if [ -n "$API_SCRIPT_DIR" ] && [ "$API_SCRIPT_DIR" != "$ROOT/scripts/operations/live-gate" ]; then
  cp "$ROOT/scripts/operations/live-gate/account-verification.mjs" "$API_SCRIPT_DIR/account-verification.mjs"
fi

status=0
if [ "$SKIP_PHONE" != "--phone-only" ]; then
  echo "== live gate: api ($ORIGIN, commit ${COMMIT:0:7})"
  UNFILED_GATE_OUTPUT="$OUT_DIR/api-$COMMIT.json" node "$API_SCRIPT" || status=1
fi

if [ "$SKIP_PHONE" != "--skip-phone" ]; then
  echo "== live gate: phone (simulator, the app's own model)"
  S="${UNFILED_GATE_DERIVED_DATA:-$OUT_DIR/derived-data}"
  ( cd "$ROOT/apps/ios" && TEST_RUNNER_UNFILED_LIVE_GATE=1 \
      TEST_RUNNER_UNFILED_LIVE_GATE_API_BASE_URL="$ORIGIN/api/v1" \
      TEST_RUNNER_UNFILED_LIVE_GATE_OPENAI_API_KEY="$UNFILED_GATE_OPENAI_API_KEY" \
      TEST_RUNNER_UNFILED_LIVE_GATE_SUPABASE_URL="$UNFILED_GATE_SUPABASE_URL" \
      TEST_RUNNER_UNFILED_LIVE_GATE_SUPABASE_SERVICE_ROLE_KEY="$UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY" \
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
