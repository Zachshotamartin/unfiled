#!/usr/bin/env bash

set -euo pipefail

trap 'echo "Milestone C HTTP E2E failed near line $LINENO." >&2' ERR

e2e_tmp_dir="$(mktemp -d)"
e2e_app_pid=""

cleanup() {
  local exit_code="$?"
  trap - EXIT
  if [[ -n "$e2e_app_pid" ]]; then
    kill "$e2e_app_pid" 2>/dev/null || true
    wait "$e2e_app_pid" 2>/dev/null || true
  fi
  if [[ "$exit_code" -ne 0 && -f "$e2e_tmp_dir/web.log" ]]; then
    tail -n 120 "$e2e_tmp_dir/web.log"
  fi
  rm -rf "$e2e_tmp_dir"
  exit "$exit_code"
}
trap cleanup EXIT

supabase status -o env >"$e2e_tmp_dir/supabase.env"
set -a
# Supabase CLI emits shell-quoted local credentials. This file is temporary and never printed.
# shellcheck source=/dev/null
source "$e2e_tmp_dir/supabase.env"
set +a

e2e_supabase_url="${API_URL:-http://127.0.0.1:54321}"
e2e_app_url="http://127.0.0.1:3100"
e2e_run_id="${E2E_RUN_ID:-$(date +%s)-$$}"
e2e_standalone_dir="$e2e_tmp_dir/standalone"

# Next's standalone output intentionally omits public/ and .next/static. Stage
# the complete deployable artifact so this gate catches broken UI assets too.
cp -R apps/web/.next/standalone "$e2e_standalone_dir"
cp -R apps/web/public "$e2e_standalone_dir/apps/web/public"
cp -R apps/web/.next/static "$e2e_standalone_dir/apps/web/.next/static"

NEXT_PUBLIC_SUPABASE_URL="$e2e_supabase_url" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
NEXT_PUBLIC_SITE_URL="$e2e_app_url" \
AUTH_RATE_LIMIT_PEPPER="ci-auth-rate-limit-pepper-000000000001" \
CI="true" \
UNFILED_ALLOW_INSECURE_LOCAL_SUPABASE_E2E="1" \
UNFILED_CONTENT_KEK_ID="ci-content-kek-v1" \
UNFILED_CONTENT_KEK="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
UNFILED_CONTENT_FINGERPRINT_KEY="AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" \
UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY="AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI" \
HOSTNAME="127.0.0.1" \
PORT="3100" \
  node "$e2e_standalone_dir/apps/web/server.js" \
  >"$e2e_tmp_dir/web.log" 2>&1 &
e2e_app_pid="$!"

for _ in $(seq 1 60); do
  if curl --fail --silent --output /dev/null "$e2e_app_url/api/health"; then
    break
  fi
  if ! kill -0 "$e2e_app_pid" 2>/dev/null; then
    echo "The built web server exited before becoming ready." >&2
    exit 1
  fi
  sleep 1
done
curl --fail --silent --show-error --output /dev/null "$e2e_app_url/api/health"
curl --fail --silent --show-error --output /dev/null \
  "$e2e_app_url/brand/unfiled-mark.svg"
e2e_hero_asset="$(find apps/web/.next/static/media -maxdepth 1 -name '01-hero.*.png' -print -quit)"
if [[ -z "$e2e_hero_asset" ]]; then
  echo "The built hero asset was not found." >&2
  exit 1
fi
curl --fail --silent --show-error --output /dev/null \
  "$e2e_app_url/_next/static/media/$(basename "$e2e_hero_asset")"

e2e_auth_response="$(
  curl --fail --silent --show-error \
    --request POST \
    --header "apikey: $ANON_KEY" \
    --header "content-type: application/json" \
    --data '{"email":"demo@unfiled.local","password":"unfiled-local-demo"}' \
    "$e2e_supabase_url/auth/v1/token?grant_type=password"
)"
e2e_access_token="$(
  printf '%s' "$e2e_auth_response" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (typeof value.access_token !== "string" || value.access_token.length === 0) process.exit(1);
      process.stdout.write(value.access_token);
    });
  '
)"

request_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local idempotency_key="${4:-}"
  local arguments=(
    --fail
    --silent
    --show-error
    --request "$method"
    --header "authorization: Bearer $e2e_access_token"
  )
  if [[ -n "$body" ]]; then
    arguments+=(--header "content-type: application/json" --data "$body")
  fi
  if [[ -n "$idempotency_key" ]]; then
    arguments+=(--header "idempotency-key: $idempotency_key")
  fi
  curl "${arguments[@]}" "$e2e_app_url/api/v1$path"
}

private_search_json() {
  local label="$1"
  local body="$2"
  local response_body="$e2e_tmp_dir/search-$label.json"
  local response_headers="$e2e_tmp_dir/search-$label.headers"
  local result
  local status
  local effective_url

  result="$(
    curl --silent --show-error \
      --request POST \
      --header "authorization: Bearer $e2e_access_token" \
      --header "content-type: application/json" \
      --header "cache-control: no-store" \
      --data "$body" \
      --dump-header "$response_headers" \
      --output "$response_body" \
      --write-out $'%{http_code}\n%{url_effective}' \
      "$e2e_app_url/api/v1/search"
  )"
  status="$(printf '%s\n' "$result" | sed -n '1p')"
  effective_url="$(printf '%s\n' "$result" | sed -n '2p')"
  if [[ "$status" != "200" || "$effective_url" != "$e2e_app_url/api/v1/search" ]]; then
    echo "Private search did not use the exact no-query POST endpoint." >&2
    return 1
  fi

  node -e '
    const fs = require("node:fs");
    const headers = fs.readFileSync(process.argv[1], "utf8").replaceAll("\r", "");
    const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const exactKeys = (input, expected) =>
      JSON.stringify(Object.keys(input).sort()) === JSON.stringify([...expected].sort());
    if (!/^cache-control:\s*private, no-store\s*$/imu.test(headers)) process.exit(1);
    if (!/^pragma:\s*no-cache\s*$/imu.test(headers)) process.exit(1);
    if (!/^content-type:\s*application\/json; charset=utf-8\s*$/imu.test(headers)) process.exit(1);
    if (!exactKeys(value, ["items", "pageInfo"])) process.exit(1);
    if (!Array.isArray(value.items) || !exactKeys(value.pageInfo, ["hasMore", "nextCursor"])) {
      process.exit(1);
    }
    if (typeof value.pageInfo.hasMore !== "boolean") process.exit(1);
    if (value.pageInfo.nextCursor !== null && typeof value.pageInfo.nextCursor !== "string") {
      process.exit(1);
    }
    const itemKeys = [
      "archivedAt",
      "noteId",
      "snippet",
      "spacePath",
      "title",
      "type",
      "updatedAt"
    ];
    if (value.items.some((item) => !exactKeys(item, itemKeys))) process.exit(1);
  ' "$response_headers" "$response_body"
}

e2e_session="$(request_json GET /auth/session)"
printf '%s' "$e2e_session" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.user?.id !== "11111111-1111-4111-8111-111111111111") process.exit(1);
  });
'

e2e_create_key="milestone-b-http-create-$e2e_run_id"
e2e_create="$(
  request_json POST /notes \
    "{\"idempotencyKey\":\"$e2e_create_key\",\"title\":\"HTTP gate note\",\"type\":\"generic\",\"bodyMarkdown\":\"alpha literal%$e2e_run_id literal_$e2e_run_id\",\"privacy\":\"ai_assisted\"}" \
    "$e2e_create_key"
)"
read -r e2e_note_id e2e_create_mutation_id < <(
  printf '%s' "$e2e_create" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 1 || value.note?.title !== "HTTP gate note") {
        console.error("Create response note contract mismatch", JSON.stringify(value));
        process.exit(1);
      }
      if (value.undo?.eligible !== true || value.replayed !== false) {
        console.error("Create response replay/undo contract mismatch", JSON.stringify(value));
        process.exit(1);
      }
      process.stdout.write(value.note.id + " " + value.mutationId + "\n");
    });
  '
)

e2e_create_replay="$(
  request_json POST /notes \
    "{\"idempotencyKey\":\"$e2e_create_key\",\"title\":\"HTTP gate note\",\"type\":\"generic\",\"bodyMarkdown\":\"alpha literal%$e2e_run_id literal_$e2e_run_id\",\"privacy\":\"ai_assisted\"}" \
    "$e2e_create_key"
)"
printf '%s' "$e2e_create_replay" | E2E_NOTE_ID="$e2e_note_id" E2E_MUTATION_ID="$e2e_create_mutation_id" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.id !== process.env.E2E_NOTE_ID || value.mutationId !== process.env.E2E_MUTATION_ID || value.replayed !== true) process.exit(1);
  });
'

e2e_update_key="milestone-b-http-update-$e2e_run_id"
e2e_update="$(
  request_json PATCH "/notes/$e2e_note_id" \
    "{\"expectedRevision\":1,\"idempotencyKey\":\"$e2e_update_key\",\"title\":\"HTTP gate note edited\"}" \
    "$e2e_update_key"
)"
e2e_update_mutation_id="$(
  printf '%s' "$e2e_update" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || value.note?.title !== "HTTP gate note edited") process.exit(1);
      process.stdout.write(value.mutationId);
    });
  '
)"

e2e_stale_status="$(
  curl --silent --show-error \
    --output "$e2e_tmp_dir/stale.json" \
    --write-out '%{http_code}' \
    --request PATCH \
    --header "authorization: Bearer $e2e_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: milestone-b-http-stale-$e2e_run_id" \
    --data "{\"expectedRevision\":1,\"idempotencyKey\":\"milestone-b-http-stale-$e2e_run_id\",\"title\":\"must not win\"}" \
    "$e2e_app_url/api/v1/notes/$e2e_note_id"
)"
[[ "$e2e_stale_status" == "409" ]]
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "stale_revision") process.exit(1);
' "$e2e_tmp_dir/stale.json"

e2e_undo_update_key="milestone-b-http-undo-update-$e2e_run_id"
e2e_undo_update="$(
  request_json POST "/mutations/$e2e_update_mutation_id/undo" \
    "{\"expectedRevision\":2,\"idempotencyKey\":\"$e2e_undo_update_key\"}" \
    "$e2e_undo_update_key"
)"
printf '%s' "$e2e_undo_update" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.currentRevision !== 3 || value.note?.title !== "HTTP gate note") process.exit(1);
  });
'

e2e_second_key="milestone-b-http-create-second-$e2e_run_id"
e2e_second="$(
  request_json POST /notes \
    "{\"idempotencyKey\":\"$e2e_second_key\",\"title\":\"HTTP link target\",\"type\":\"generic\",\"bodyMarkdown\":\"beta literalX$e2e_run_id literalY$e2e_run_id\",\"privacy\":\"ai_assisted\"}" \
    "$e2e_second_key"
)"
read -r e2e_second_note_id e2e_second_create_mutation < <(
  printf '%s' "$e2e_second" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.undo?.eligible !== true) process.exit(1);
      process.stdout.write(value.note.id + " " + value.mutationId + "\n");
    });
  '
)

e2e_undo_create_key="milestone-b-http-undo-create-$e2e_run_id"
e2e_undo_create="$(
  request_json POST "/mutations/$e2e_second_create_mutation/undo" \
    "{\"expectedRevision\":1,\"idempotencyKey\":\"$e2e_undo_create_key\"}" \
    "$e2e_undo_create_key"
)"
e2e_undo_create_mutation="$(
  printf '%s' "$e2e_undo_create" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || typeof value.note?.deletedAt !== "string") process.exit(1);
      if (value.undo?.eligible !== true) process.exit(1);
      process.stdout.write(value.mutationId);
    });
  '
)"

e2e_redo_create_key="milestone-b-http-redo-create-$e2e_run_id"
e2e_redo_create="$(
  request_json POST "/mutations/$e2e_undo_create_mutation/undo" \
    "{\"expectedRevision\":2,\"idempotencyKey\":\"$e2e_redo_create_key\"}" \
    "$e2e_redo_create_key"
)"
printf '%s' "$e2e_redo_create" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.currentRevision !== 3 || value.note?.deletedAt !== null) process.exit(1);
  });
'

e2e_tag_key="milestone-b-http-tag-create-$e2e_run_id"
e2e_tag_name="http-$e2e_run_id"
e2e_tag_updated_name="http-renamed-$e2e_run_id"
e2e_tag="$(
  request_json POST /tags \
    "{\"idempotencyKey\":\"$e2e_tag_key\",\"name\":\"$e2e_tag_name\"}" \
    "$e2e_tag_key"
)"
e2e_tag_id="$(
  printf '%s' "$e2e_tag" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => process.stdout.write(JSON.parse(input).tag.id));
  '
)"
e2e_tag_update_key="milestone-b-http-tag-update-$e2e_run_id"
request_json PATCH "/tags/$e2e_tag_id" \
  "{\"expectedRevision\":1,\"idempotencyKey\":\"$e2e_tag_update_key\",\"name\":\"$e2e_tag_updated_name\"}" \
  "$e2e_tag_update_key" | E2E_TAG_UPDATED_NAME="$e2e_tag_updated_name" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.tag?.name !== process.env.E2E_TAG_UPDATED_NAME || value.tag?.currentRevision !== 2) process.exit(1);
    });
  '

e2e_link_tag_key="milestone-b-http-link-tag-$e2e_run_id"
request_json POST "/notes/$e2e_note_id/tags" \
  "{\"expectedRevision\":3,\"idempotencyKey\":\"$e2e_link_tag_key\",\"tagId\":\"$e2e_tag_id\"}" \
  "$e2e_link_tag_key" >/dev/null

e2e_link_key="milestone-b-http-link-note-$e2e_run_id"
e2e_link="$(
  request_json POST "/notes/$e2e_note_id/links" \
    "{\"expectedRevision\":4,\"idempotencyKey\":\"$e2e_link_key\",\"toNoteId\":\"$e2e_second_note_id\",\"linkType\":\"related\"}" \
    "$e2e_link_key"
)"
e2e_link_id="$(
  request_json GET "/notes/$e2e_note_id/links" | E2E_TARGET_ID="$e2e_second_note_id" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const link = value.items.find((item) => item.toNoteId === process.env.E2E_TARGET_ID);
      if (!link || link.targetTitle !== "HTTP link target") process.exit(1);
      process.stdout.write(link.id);
    });
  '
)"
printf '%s' "$e2e_link" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (JSON.parse(input).note?.currentRevision !== 5) process.exit(1);
  });
'

e2e_unlink_key="milestone-b-http-unlink-note-$e2e_run_id"
e2e_wrong_link_status="$(
  curl --silent --show-error \
    --output "$e2e_tmp_dir/wrong-link.json" \
    --write-out '%{http_code}' \
    --request DELETE \
    --header "authorization: Bearer $e2e_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: milestone-b-http-wrong-link-$e2e_run_id" \
    --data "{\"expectedRevision\":5,\"idempotencyKey\":\"milestone-b-http-wrong-link-$e2e_run_id\",\"toNoteId\":\"$e2e_second_note_id\",\"linkType\":\"related\"}" \
    "$e2e_app_url/api/v1/notes/$e2e_note_id/links/lnk_00000000000000000000000000"
)"
[[ "$e2e_wrong_link_status" == "404" ]]

request_json DELETE "/notes/$e2e_note_id/links/$e2e_link_id" \
  "{\"expectedRevision\":5,\"idempotencyKey\":\"$e2e_unlink_key\",\"toNoteId\":\"$e2e_second_note_id\",\"linkType\":\"related\"}" \
  "$e2e_unlink_key" >/dev/null

e2e_unlink_tag_key="milestone-b-http-unlink-tag-$e2e_run_id"
request_json DELETE "/notes/$e2e_note_id/tags/$e2e_tag_id" \
  "{\"expectedRevision\":6,\"idempotencyKey\":\"$e2e_unlink_tag_key\"}" \
  "$e2e_unlink_tag_key" >/dev/null

e2e_private_search_canary="literal%$e2e_run_id"
private_search_json \
  title \
  '{"query":"HTTP gate","archive":"exclude","limit":10}'
E2E_NOTE_ID="$e2e_note_id" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!value.items.some((item) => item.noteId === process.env.E2E_NOTE_ID)) process.exit(1);
' "$e2e_tmp_dir/search-title.json"

private_search_json \
  percent \
  "{\"query\":\"$e2e_private_search_canary\",\"archive\":\"exclude\",\"limit\":10}"
E2E_NOTE_ID="$e2e_note_id" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.items.length !== 1 || value.items[0]?.noteId !== process.env.E2E_NOTE_ID) process.exit(1);
' "$e2e_tmp_dir/search-percent.json"

private_search_json \
  underscore \
  "{\"query\":\"literal_$e2e_run_id\",\"archive\":\"exclude\",\"limit\":10}"
E2E_NOTE_ID="$e2e_note_id" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.items.length !== 1 || value.items[0]?.noteId !== process.env.E2E_NOTE_ID) process.exit(1);
' "$e2e_tmp_dir/search-underscore.json"

# Search accepts only strict JSON POST bodies. Query text must never enter the
# URL, and even rejected requests retain the private no-store response policy.
e2e_search_invalid_canary="private-search-invalid-$e2e_run_id"
e2e_search_invalid_status="$(
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_access_token" \
    --header "content-type: application/json" \
    --data "{\"query\":\"$e2e_search_invalid_canary\",\"unexpected\":true}" \
    --dump-header "$e2e_tmp_dir/search-invalid.headers" \
    --output "$e2e_tmp_dir/search-invalid.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/search"
)"
[[ "$e2e_search_invalid_status" == "400" ]]
E2E_SEARCH_CANARY="$e2e_search_invalid_canary" node -e '
  const fs = require("node:fs");
  const headers = fs.readFileSync(process.argv[1], "utf8").replaceAll("\r", "");
  const serialized = fs.readFileSync(process.argv[2], "utf8");
  const value = JSON.parse(serialized);
  if (!/^cache-control:\s*private, no-store\s*$/imu.test(headers)) process.exit(1);
  if (!/^pragma:\s*no-cache\s*$/imu.test(headers)) process.exit(1);
  if (value.code !== "validation_failed") process.exit(1);
  if (serialized.includes(process.env.E2E_SEARCH_CANARY)) process.exit(1);
' "$e2e_tmp_dir/search-invalid.headers" "$e2e_tmp_dir/search-invalid.json"

e2e_search_url_field_status="$(
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_access_token" \
    --header "content-type: application/json" \
    --data '{"query":"HTTP gate","archive":"exclude","limit":10}' \
    --dump-header "$e2e_tmp_dir/search-url-field.headers" \
    --output "$e2e_tmp_dir/search-url-field.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/search?limit=10"
)"
[[ "$e2e_search_url_field_status" == "400" ]]
node -e '
  const headers = require("node:fs")
    .readFileSync(process.argv[1], "utf8")
    .replaceAll("\r", "");
  if (!/^cache-control:\s*private, no-store\s*$/imu.test(headers)) process.exit(1);
  if (!/^pragma:\s*no-cache\s*$/imu.test(headers)) process.exit(1);
' "$e2e_tmp_dir/search-url-field.headers"

e2e_search_get_status="$(
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_access_token" \
    --dump-header "$e2e_tmp_dir/search-get.headers" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/search"
)"
[[ "$e2e_search_get_status" == "405" ]]
node -e '
  const headers = require("node:fs")
    .readFileSync(process.argv[1], "utf8")
    .replaceAll("\r", "");
  if (!/^allow:\s*POST\s*$/imu.test(headers)) process.exit(1);
  if (!/^cache-control:\s*private, no-store\s*$/imu.test(headers)) process.exit(1);
' "$e2e_tmp_dir/search-get.headers"

if grep --fixed-strings --quiet "$e2e_private_search_canary" "$e2e_tmp_dir/web.log"; then
  echo "Private search text appeared in the web server log." >&2
  exit 1
fi

request_json GET '/review-items?state=open&limit=30' | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (!Array.isArray(value.items) || typeof value.pageInfo?.hasMore !== "boolean") process.exit(1);
  });
'

e2e_capture_id="cap_$(node -e '
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = require("node:crypto").randomBytes(26);
  process.stdout.write(Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(""));
')"
e2e_capture_canary="encrypted-capture-$e2e_run_id"
e2e_capture_created_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
e2e_capture_body="{\"clientCaptureId\":\"$e2e_capture_id\",\"rawContent\":\"$e2e_capture_canary\",\"source\":\"web\",\"clientCreatedAt\":\"$e2e_capture_created_at\",\"clientTimezone\":\"UTC\",\"privacy\":\"ai_assisted\",\"expansionDisabled\":false}"
e2e_capture_create="$(request_json POST /captures "$e2e_capture_body" "$e2e_capture_id")"
e2e_capture_job_id="$(
  printf '%s' "$e2e_capture_create" | E2E_CAPTURE_ID="$e2e_capture_id" E2E_CAPTURE_CANARY="$e2e_capture_canary" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.capture?.id !== process.env.E2E_CAPTURE_ID) process.exit(1);
      if (value.capture?.rawContent !== process.env.E2E_CAPTURE_CANARY) process.exit(1);
      if (value.capture?.status !== "queued" || value.replayed !== false) process.exit(1);
      if (typeof value.jobId !== "string" || !value.jobId.startsWith("job_")) process.exit(1);
      process.stdout.write(value.jobId);
    });
  '
)"

request_json POST /captures "$e2e_capture_body" "$e2e_capture_id" | \
  E2E_CAPTURE_ID="$e2e_capture_id" E2E_CAPTURE_JOB_ID="$e2e_capture_job_id" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.capture?.id !== process.env.E2E_CAPTURE_ID) process.exit(1);
      if (value.jobId !== process.env.E2E_CAPTURE_JOB_ID || value.replayed !== true) process.exit(1);
    });
  '

# The web app durably queues encrypted work and only wakes the isolated
# organizer. Milestone D's planner is intentionally unavailable in this lane,
# so the HTTP gate must not expect an in-process deterministic organization.
e2e_capture_detail="$(request_json GET "/captures/$e2e_capture_id")"
printf '%s' "$e2e_capture_detail" | \
  E2E_CAPTURE_ID="$e2e_capture_id" \
  E2E_CAPTURE_JOB_ID="$e2e_capture_job_id" \
  E2E_CAPTURE_CANARY="$e2e_capture_canary" \
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.capture?.id !== process.env.E2E_CAPTURE_ID) process.exit(1);
      if (value.capture?.rawContent !== process.env.E2E_CAPTURE_CANARY) process.exit(1);
      if (value.capture?.status !== "queued") process.exit(1);
      if (value.capture?.jobId !== process.env.E2E_CAPTURE_JOB_ID) process.exit(1);
      if (value.capture?.receipt !== null) process.exit(1);
    });
  '

e2e_stored_capture="$(
  curl --fail --silent --show-error \
    --request POST \
    --header "apikey: $SERVICE_ROLE_KEY" \
    --header "authorization: Bearer $SERVICE_ROLE_KEY" \
    --header "content-type: application/json" \
    --data "{\"p_owner_id\":\"11111111-1111-4111-8111-111111111111\",\"p_capture_id\":\"$e2e_capture_id\"}" \
    "$e2e_supabase_url/rest/v1/rpc/get_capture_storage_attestation"
)"
printf '%s' "$e2e_stored_capture" | \
  E2E_CAPTURE_ID="$e2e_capture_id" E2E_CAPTURE_CANARY="$e2e_capture_canary" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.captureId !== process.env.E2E_CAPTURE_ID) process.exit(1);
    if (JSON.stringify(value).includes(process.env.E2E_CAPTURE_CANARY)) process.exit(1);
    if (value.rawTextTombstoned !== true || value.envelopeV1 !== true) process.exit(1);
    if (value.suiteA256Gcm !== true || value.fingerprintShapeValid !== true) process.exit(1);
    if ("raw_text" in value || "rawContent" in value || "contentEnvelope" in value) process.exit(1);
  });
'

if grep --fixed-strings --quiet "$e2e_capture_canary" "$e2e_tmp_dir/web.log"; then
  echo "Capture plaintext appeared in the web server log." >&2
  exit 1
fi

e2e_capture_delete_key="milestone-c-http-capture-delete-$e2e_run_id"
request_json DELETE "/captures/$e2e_capture_id" \
  "{\"idempotencyKey\":\"$e2e_capture_delete_key\",\"removeInsertedContent\":false,\"expectedNoteRevisions\":[]}" \
  "$e2e_capture_delete_key" | E2E_CAPTURE_ID="$e2e_capture_id" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.captureId !== process.env.E2E_CAPTURE_ID || value.replayed !== false) process.exit(1);
      if (value.removedInsertedContent !== false || value.contentRemovalMutations?.length !== 0) process.exit(1);
    });
  '

e2e_deleted_capture_status="$(
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_access_token" \
    --output "$e2e_tmp_dir/deleted-capture.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_capture_id"
)"
[[ "$e2e_deleted_capture_status" == "404" ]]
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "not_found") process.exit(1);
' "$e2e_tmp_dir/deleted-capture.json"

# Leave the shared local database reusable for a subsequent test pass. The API
# deliberately soft-deletes notes, which removes their searchable plaintext
# projections without bypassing the same revision/idempotency contracts used by
# clients.
e2e_delete_note_key="milestone-b-http-delete-note-$e2e_run_id"
request_json DELETE "/notes/$e2e_note_id" \
  "{\"expectedRevision\":7,\"idempotencyKey\":\"$e2e_delete_note_key\"}" \
  "$e2e_delete_note_key" >/dev/null
e2e_delete_second_key="milestone-b-http-delete-second-$e2e_run_id"
request_json DELETE "/notes/$e2e_second_note_id" \
  "{\"expectedRevision\":3,\"idempotencyKey\":\"$e2e_delete_second_key\"}" \
  "$e2e_delete_second_key" >/dev/null

request_json POST /auth/sign-out | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (JSON.parse(input).signedOut !== true) process.exit(1);
  });
'

echo "Milestone C local HTTP E2E passed."
