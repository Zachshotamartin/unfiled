#!/usr/bin/env bash
# Production release with hard gates. Refuses to deploy unless the live gate is green for HEAD
# against the current production; deploys the five Vercel projects; reruns the live gate against
# the new deployments; on red, promotes the previous deployments back and exits non-zero.
#
# Usage: scripts/operations/deploy-production.sh [--skip-phone]
# Requires: vercel CLI logged in and each app linked; git tree clean apart from apps/ios and
# CLAUDE_FABLE_HANDOFF.md; the gate secrets in the environment or the login keychain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERCEL="${VERCEL_BIN:-vercel}"
GATE="$ROOT/scripts/operations/live-gate/run.sh"
OUT_DIR="${UNFILED_GATE_DIR:-$ROOT/.live-gate}"
SKIP_PHONE="${1:-}"
mkdir -p "$OUT_DIR"
cd "$ROOT"
if [[ -n "$(git status --porcelain -- . ':!CLAUDE_FABLE_HANDOFF.md' ':!apps/ios' ':!.live-gate')" ]]; then
  echo "Working tree has uncommitted product changes; commit first so provenance matches." >&2
  exit 1
fi
commit="$(git rev-parse HEAD)"
ref="$(git rev-parse --abbrev-ref HEAD)"
message="$(git log -1 --format=%s)"

echo "== gate 1 of 2: live gate for $commit against current production"
"$GATE" production $SKIP_PHONE || { echo "Pre-deploy gate is red; not deploying." >&2; exit 1; }

previous="$OUT_DIR/deployments-previous.json"
current="$OUT_DIR/deployments-$commit.json"
[[ -f "$OUT_DIR/deployments-current.json" ]] && cp "$OUT_DIR/deployments-current.json" "$previous"
META=(-m "githubCommitSha=$commit" -m "githubCommitRef=$ref" -m "githubCommitMessage=$message" -m "githubCommitOrg=Zachshotamartin" -m "githubCommitRepo=unfiled" -m "githubCommitAuthorName=Zachary Martin" -m "githubCommitAuthorLogin=Zachshotamartin" -m "githubOrg=Zachshotamartin" -m "githubRepo=unfiled")
echo "{\"commit\":\"$commit\",\"deployments\":{" > "$current.tmp"
first=1
for app in organizer worker verifier search web; do
  echo "== deploying $app"
  log="$OUT_DIR/$app.deploy.log"
  (cd "apps/$app" && "$VERCEL" deploy --prod --yes --force "${META[@]}" -e "VERCEL_GIT_COMMIT_SHA=$commit" -b "VERCEL_GIT_COMMIT_SHA=$commit" >/dev/null 2>"$log")
  url="$(grep -oE "https://unfiled(-$app)?-[a-z0-9]+-zach-2267\.vercel\.app" "$log" | head -1)"
  id="$(cd "apps/$app" && "$VERCEL" inspect "$url" 2>&1 | awk '/^ *id/ {print $2; exit}')"
  [[ $first -eq 0 ]] && echo "," >> "$current.tmp"; first=0
  printf '"%s":{"url":"%s","id":"%s"}' "$app" "$url" "$id" >> "$current.tmp"
  echo "$app -> $url (id ${id:-unknown})"
done
echo "}}" >> "$current.tmp"
mv "$current.tmp" "$current"
cp "$current" "$OUT_DIR/deployments-current.json"

echo "== gate 2 of 2: live gate against the new deployments"
if "$GATE" production $SKIP_PHONE; then
  echo "== release GREEN: $commit is live and verified"
  exit 0
fi
echo "== post-deploy gate is RED; promoting the previous deployments back" >&2
if [[ -f "$previous" ]]; then
  for app in web search verifier worker organizer; do
    url="$(node -e 'console.log(require(process.argv[1]).deployments[process.argv[2]].url)' "$previous" "$app")"
    (cd "apps/$app" && "$VERCEL" promote "$url" --yes >/dev/null 2>&1) && echo "$app -> restored $url" || echo "$app -> restore FAILED; promote $url by hand" >&2
  done
  cp "$previous" "$OUT_DIR/deployments-current.json"
else
  echo "no previous deployment record; restore by hand from the Vercel dashboard" >&2
fi
exit 1
