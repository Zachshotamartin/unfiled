#!/usr/bin/env bash

set -euo pipefail

f_trust_tmp_dir="$(mktemp -d)"
f_trust_database_url=""
cleanup() {
  local exit_code="$?"
  trap - EXIT
  if [[ -n "$f_trust_database_url" ]] && command -v psql >/dev/null 2>&1; then
    psql "$f_trust_database_url" --no-psqlrc --set ON_ERROR_STOP=1 \
      --command 'alter role unfiled_search_worker nologin password null' \
      >/dev/null 2>&1 || true
  fi
  rm -rf -- "$f_trust_tmp_dir"
  exit "$exit_code"
}
trap cleanup EXIT

if ! command -v psql >/dev/null 2>&1; then
  echo "The Milestone F trust-domain gate requires the PostgreSQL client." >&2
  exit 1
fi
if ! command -v supabase >/dev/null 2>&1; then
  echo "The Milestone F trust-domain gate requires the Supabase CLI." >&2
  exit 1
fi

supabase status -o env >"$f_trust_tmp_dir/supabase.env"
set -a
# Supabase emits shell-quoted local credentials. This temporary file is never printed.
# shellcheck source=/dev/null
source "$f_trust_tmp_dir/supabase.env"
set +a

f_trust_api_url="${API_URL:-}"
f_trust_database_url="${DB_URL:-}"
case "$f_trust_api_url" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *)
    echo "The Milestone F trust-domain gate is restricted to local Supabase." >&2
    exit 1
    ;;
esac
case "$f_trust_database_url" in
  postgresql://*@127.0.0.1:*/* | postgresql://*@localhost:*/*) ;;
  *)
    echo "The Milestone F trust-domain gate is restricted to local PostgreSQL." >&2
    exit 1
    ;;
esac

NEXT_PUBLIC_SUPABASE_URL="$f_trust_api_url" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
UNFILED_TEST_DATABASE_URL="$f_trust_database_url" \
NODE_ENV="test" \
  pnpm --filter @unfiled/search-service test:trust-domain
