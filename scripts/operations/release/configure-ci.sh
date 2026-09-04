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

# The CLI login is a session, not an API token: the API answers 403 to it. Only a token created
# at https://vercel.com/account/tokens can deploy or read what is deployed.
[ -n "${VERCEL_TOKEN:-}" ] || {
  echo "VERCEL_TOKEN is not set. Create one at https://vercel.com/account/tokens, then run:" >&2
  echo "  VERCEL_TOKEN=... scripts/operations/release/configure-ci.sh" >&2
  exit 1
}
command -v gh >/dev/null || { echo "The GitHub CLI is required (run: brew install gh && gh auth login)." >&2; exit 1; }
if [ -f "$ROOT/.env.live-gate" ]; then set -a; . "$ROOT/.env.live-gate"; set +a; fi
keychain() { security find-generic-password -s "$1" -a "$2" -w 2>/dev/null || true; }

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
chmod 700 "$staging"

node - "$staging" <<'NODE'
const fs = require("node:fs");
const [, , staging] = process.argv;
const token = process.env.VERCEL_TOKEN;
if (typeof token !== "string" || token.length < 20) {
  console.error("VERCEL_TOKEN is not a usable token.");
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

# Each value comes from the environment first, then the login keychain. `set -e` is why these
# are written as `if` blocks rather than `[ -n "$x" ] && ...`: a bare test that fails ends the
# whole script, so a single absent value used to abort the run without a word about which one.
stage() {
  if [ -n "$2" ]; then
    printf '%s' "$2" > "$staging/$1"
  else
    echo "  (absent: $1)" >&2
  fi
}

stage UNFILED_GATE_OPENAI_API_KEY \
  "${UNFILED_GATE_OPENAI_API_KEY:-$(keychain unfiled-gate OPENAI_API_KEY)}"
stage UNFILED_GATE_CRON_SECRET \
  "${UNFILED_GATE_CRON_SECRET:-$(keychain unfiled-beta-web-secret CRON_SECRET)}"
# The live gate confirms its own synthetic account through Supabase's admin API, because a
# deployment that confirms addresses will not let a new account sign in otherwise. Without these
# two the gate stops at exit 2 -- and it runs after the five deploys, so a release that lacked
# them put new code in front of every owner and only then discovered it could verify none of it.
stage UNFILED_GATE_SUPABASE_URL \
  "${UNFILED_GATE_SUPABASE_URL:-$(keychain unfiled-gate SUPABASE_URL)}"
stage UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY \
  "${UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY:-$(keychain unfiled-gate SUPABASE_SERVICE_ROLE_KEY)}"
stage SUPABASE_DB_URL "${SUPABASE_DB_URL:-}"

for path in "$staging"/*; do
  name="$(basename "$path")"
  gh secret set "$name" < "$path" && echo "set $name"
done

for required in UNFILED_GATE_SUPABASE_URL UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY; do
  if [ ! -f "$staging/$required" ]; then
    echo
    echo "$required is not set, so the live gate cannot start and a release will refuse."
    echo "Take it from the Supabase dashboard for the project the deployment uses"
    echo "(Project settings, API keys) and store it in the login keychain:"
    echo "  printf 'value: ' && read -rs V && echo && \\"
    echo "    security add-generic-password -U -s unfiled-gate -a ${required#UNFILED_GATE_} -w \"\$V\" && unset V"
    echo "then run this script again."
  fi
done

if [ ! -f "$staging/SUPABASE_DB_URL" ]; then
  echo
  echo "SUPABASE_DB_URL was not set: releases cannot apply migrations without it."
  echo "Take the connection string from Supabase (Project settings, Database, Connection string,"
  echo "URI, with the password filled in) and run:"
  echo "  SUPABASE_DB_URL='postgresql://...' scripts/operations/release/configure-ci.sh"
fi
