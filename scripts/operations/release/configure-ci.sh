#!/usr/bin/env bash
# Gives GitHub Actions what a release needs, from credentials that are already on this machine.
# Values are piped straight into `gh secret set` and are never printed.
#
# Usage: scripts/operations/release/configure-ci.sh
# Needs: the Vercel CLI logged in (`vercel login`), the GitHub CLI logged in (`gh auth login`),
# and, for migrations, the production database URL in SUPABASE_DB_URL or .env.live-gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

auth_file="$HOME/Library/Application Support/com.vercel.cli/auth.json"
[ -f "$auth_file" ] || { echo "Vercel CLI is not logged in on this machine (run: vercel login)." >&2; exit 1; }
command -v gh >/dev/null || { echo "The GitHub CLI is required (run: brew install gh && gh auth login)." >&2; exit 1; }
if [ -f "$ROOT/.env.live-gate" ]; then set -a; . "$ROOT/.env.live-gate"; set +a; fi
keychain() { security find-generic-password -s "$1" -a "$2" -w 2>/dev/null || true; }

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
chmod 700 "$staging"

node - "$auth_file" "$staging" <<'NODE'
const fs = require("node:fs");
const [, , authPath, staging] = process.argv;
const token = JSON.parse(fs.readFileSync(authPath, "utf8")).token;
if (typeof token !== "string" || token.length < 20) {
  console.error("The Vercel CLI login does not carry a usable token.");
  process.exit(1);
}
const names = {
  "unfiled-web": "WEB",
  "unfiled-organizer": "ORGANIZER",
  "unfiled-worker": "WORKER",
  "unfiled-verifier": "VERIFIER",
  "unfiled-search": "SEARCH"
};
const write = (name, value) => fs.writeFileSync(`${staging}/${name}`, value, { mode: 0o600 });
(async () => {
  const response = await fetch("https://api.vercel.com/v9/projects?limit=100", {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json();
  if (!Array.isArray(body?.projects)) {
    console.error(`Vercel refused the project listing (status ${response.status}).`);
    process.exit(1);
  }
  const projects = body.projects.filter((project) => names[project.name]);
  const missing = Object.keys(names).filter(
    (name) => !projects.some((project) => project.name === name)
  );
  if (missing.length > 0) {
    console.error(`This Vercel login cannot see: ${missing.join(", ")}.`);
    process.exit(1);
  }
  write("VERCEL_TOKEN", token);
  write("VERCEL_ORG_ID", projects[0].accountId);
  for (const project of projects) write(`VERCEL_PROJECT_ID_${names[project.name]}`, project.id);
  console.log(`Prepared ${projects.length + 2} Vercel values.`);
})();
NODE

gate_key="${UNFILED_GATE_OPENAI_API_KEY:-$(keychain unfiled-gate OPENAI_API_KEY)}"
cron_secret="${UNFILED_GATE_CRON_SECRET:-$(keychain unfiled-beta-web-secret CRON_SECRET)}"
[ -n "$gate_key" ] && printf '%s' "$gate_key" > "$staging/UNFILED_GATE_OPENAI_API_KEY"
[ -n "$cron_secret" ] && printf '%s' "$cron_secret" > "$staging/UNFILED_GATE_CRON_SECRET"
[ -n "${SUPABASE_DB_URL:-}" ] && printf '%s' "$SUPABASE_DB_URL" > "$staging/SUPABASE_DB_URL"

for path in "$staging"/*; do
  name="$(basename "$path")"
  gh secret set "$name" < "$path" && echo "set $name"
done

if [ ! -f "$staging/SUPABASE_DB_URL" ]; then
  echo
  echo "SUPABASE_DB_URL was not set: releases cannot apply migrations without it."
  echo "Take the connection string from Supabase (Project settings, Database, Connection string,"
  echo "URI, with the password filled in) and run:"
  echo "  SUPABASE_DB_URL='postgresql://...' scripts/operations/release/configure-ci.sh"
fi
