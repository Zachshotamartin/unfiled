#!/usr/bin/env bash
# Runs a production release from a laptop, through exactly the same script CI runs
# (scripts/operations/release/release.mjs): migrations first, then the five services, then the
# live gate against production, with the previous deployments promoted back if the gate is red.
# Nothing about the release lives only here, so a local release and a CI release cannot differ.
#
# Usage: scripts/operations/deploy-production.sh [--skip-phone]
# Secrets come from the environment, a gitignored .env.live-gate at the repo root, or the login
# keychain, and are never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKIP_PHONE="${1:-}"
cd "$ROOT"

if [[ -n "$(git status --porcelain -- . ':!CLAUDE_FABLE_HANDOFF.md' ':!apps/ios' ':!apps/mobile' ':!.live-gate')" ]]; then
  echo "Working tree has uncommitted product changes; commit first so provenance matches." >&2
  exit 1
fi

keychain() { security find-generic-password -s "$1" -a "$2" -w 2>/dev/null || true; }
if [ -f "$ROOT/.env.live-gate" ]; then set -a; . "$ROOT/.env.live-gate"; set +a; fi
export UNFILED_GATE_OPENAI_API_KEY="${UNFILED_GATE_OPENAI_API_KEY:-$(keychain unfiled-gate OPENAI_API_KEY)}"
export UNFILED_GATE_CRON_SECRET="${UNFILED_GATE_CRON_SECRET:-$(keychain unfiled-beta-web-secret CRON_SECRET)}"

# The Vercel CLI's own login is a fine source for a local release; CI passes a token instead.
vercel_cli_auth="$HOME/Library/Application Support/com.vercel.cli/auth.json"
if [[ -z "${VERCEL_TOKEN:-}" && -f "$vercel_cli_auth" ]]; then
  VERCEL_TOKEN="$(node -e 'process.stdout.write(String(require(process.argv[1]).token ?? ""))' "$vercel_cli_auth")"
  export VERCEL_TOKEN
fi

# Project ids come from the local links when they are present, so a laptop release needs no
# extra configuration; CI supplies the same ids as secrets.
for app in organizer worker verifier search web; do
  link="$ROOT/apps/$app/.vercel/project.json"
  variable="VERCEL_PROJECT_ID_$(printf '%s' "$app" | tr '[:lower:]' '[:upper:]')"
  if [[ -z "${!variable:-}" && -f "$link" ]]; then
    export "$variable=$(node -e 'process.stdout.write(String(require(process.argv[1]).projectId ?? ""))' "$link")"
    if [[ -z "${VERCEL_ORG_ID:-}" ]]; then
      VERCEL_ORG_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).orgId ?? ""))' "$link")"
      export VERCEL_ORG_ID
    fi
  fi
done

node "$ROOT/scripts/operations/release/release.mjs"

if [[ "$SKIP_PHONE" != "--skip-phone" ]]; then
  echo "== phone gate against the release that just went out"
  "$ROOT/scripts/operations/live-gate/run.sh" production --phone-only
fi
