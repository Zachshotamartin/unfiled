#!/usr/bin/env bash
# Production release with hard gates. Refuses to deploy unless the live gate is green for HEAD
# against the current production; deploys the five Vercel projects; reruns the live gate against
# the new deployments; on red, promotes the previous deployments back and exits non-zero.
#
# Usage: scripts/operations/deploy-production.sh [--skip-phone]
# Requires: a current vercel CLI logged in (the API refuses old ones) with each app linked at
# apps/<app>/.vercel; git tree clean apart from apps/ios and
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

# Gate 1 asks whether what is live still works, so it runs the gate that matches the deployed
# commit (new steps that need the new deployment belong to gate 2). The phone gate is HEAD's
# code and may need the new server too, so gate 1 is the API gate only.
live_commit="$(curl -s --max-time 20 -D - -o /dev/null https://unfiled-web.vercel.app/api/health | tr -d '\r' | awk -F': ' 'tolower($1)=="x-unfiled-commit" {print $2}')"
deployed_gate="$OUT_DIR/api-gate-live-${live_commit:-unknown}.mjs"
if [[ -n "$live_commit" ]] && git cat-file -e "$live_commit:scripts/operations/live-gate/api-gate.mjs" 2>/dev/null; then
  git show "$live_commit:scripts/operations/live-gate/api-gate.mjs" > "$deployed_gate"
else
  cp "$ROOT/scripts/operations/live-gate/api-gate.mjs" "$deployed_gate"
fi
echo "== gate 1 of 2: what is live (${live_commit:0:7}) still works, with its own gate"
UNFILED_GATE_API_SCRIPT="$deployed_gate" "$GATE" production --skip-phone || { echo "Pre-deploy gate is red; not deploying." >&2; exit 1; }

previous="$OUT_DIR/deployments-previous.json"
current="$OUT_DIR/deployments-$commit.json"
[[ -f "$OUT_DIR/deployments-current.json" ]] && cp "$OUT_DIR/deployments-current.json" "$previous"
META=(-m "githubCommitSha=$commit" -m "githubCommitRef=$ref" -m "githubCommitMessage=$message" -m "githubCommitOrg=Zachshotamartin" -m "githubCommitRepo=unfiled" -m "githubCommitAuthorName=Zachary Martin" -m "githubCommitAuthorLogin=Zachshotamartin" -m "githubOrg=Zachshotamartin" -m "githubRepo=unfiled")
echo "{\"commit\":\"$commit\",\"deployments\":{" > "$current.tmp"
first=1
# Each project sets its own Root Directory (apps/<app>), so the CLI has to run from the repo
# root with that project's link in place; running inside apps/<app> makes Vercel look for
# apps/<app>/apps/<app> and refuse. The link for each app is kept beside its own source.
for app in organizer worker verifier search web; do
  echo "== deploying $app"
  log="$OUT_DIR/$app.deploy.log"
  link="apps/$app/.vercel/project.json"
  [[ -f "$link" ]] || { echo "apps/$app is not linked to its Vercel project ($link)" >&2; exit 1; }
  mkdir -p "$ROOT/.vercel"
  cp "$link" "$ROOT/.vercel/project.json"
  "$VERCEL" deploy --prod --yes --force "${META[@]}" -e "VERCEL_GIT_COMMIT_SHA=$commit" -b "VERCEL_GIT_COMMIT_SHA=$commit" >/dev/null 2>"$log"
  url="$(grep -oE "https://unfiled(-$app)?-[a-z0-9]+-zach-2267\.vercel\.app" "$log" | head -1)"
  id="$("$VERCEL" inspect "$url" 2>&1 | awk '/^ *id/ {print $2; exit}')"
  [[ $first -eq 0 ]] && echo "," >> "$current.tmp"; first=0
  printf '"%s":{"url":"%s","id":"%s"}' "$app" "$url" "$id" >> "$current.tmp"
  echo "$app -> $url (id ${id:-unknown})"
done
echo "}}" >> "$current.tmp"
mv "$current.tmp" "$current"
cp "$current" "$OUT_DIR/deployments-current.json"

echo "== gate 2 of 2: this commit's full gate against the new deployments"
if "$GATE" production $SKIP_PHONE; then
  echo "== release GREEN: $commit is live and verified"
  exit 0
fi
echo "== post-deploy gate is RED; promoting the previous deployments back" >&2
if [[ -f "$previous" ]]; then
  for app in web search verifier worker organizer; do
    url="$(node -e 'console.log(require(process.argv[1]).deployments[process.argv[2]].url)' "$previous" "$app")"
    cp "apps/$app/.vercel/project.json" "$ROOT/.vercel/project.json" 2>/dev/null || true
    "$VERCEL" promote "$url" --yes >/dev/null 2>&1 && echo "$app -> restored $url" || echo "$app -> restore FAILED; promote $url by hand" >&2
  done
  cp "$previous" "$OUT_DIR/deployments-current.json"
else
  echo "no previous deployment record; restore by hand from the Vercel dashboard" >&2
fi
exit 1
