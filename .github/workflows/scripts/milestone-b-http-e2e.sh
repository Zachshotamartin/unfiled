#!/usr/bin/env bash

set -euo pipefail

trap 'echo "Milestone B HTTP E2E failed near line $LINENO." >&2' ERR

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

NEXT_PUBLIC_SUPABASE_URL="$e2e_supabase_url" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
NEXT_PUBLIC_SITE_URL="$e2e_app_url" \
HOSTNAME="127.0.0.1" \
PORT="3100" \
  node apps/web/.next/standalone/apps/web/server.js \
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

request_json GET '/search?q=HTTP%20gate&archive=exclude&limit=10' | E2E_NOTE_ID="$e2e_note_id" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (!value.items.some((item) => item.noteId === process.env.E2E_NOTE_ID)) process.exit(1);
  });
'

request_json GET "/search?q=literal%25$e2e_run_id&archive=exclude&limit=10" | E2E_NOTE_ID="$e2e_note_id" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.items.length !== 1 || value.items[0]?.noteId !== process.env.E2E_NOTE_ID) process.exit(1);
  });
'

request_json GET "/search?q=literal_$e2e_run_id&archive=exclude&limit=10" | E2E_NOTE_ID="$e2e_note_id" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.items.length !== 1 || value.items[0]?.noteId !== process.env.E2E_NOTE_ID) process.exit(1);
  });
'

request_json GET '/review-items?state=open&limit=30' | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (!Array.isArray(value.items) || typeof value.pageInfo?.hasMore !== "boolean") process.exit(1);
  });
'

request_json POST /auth/sign-out | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (JSON.parse(input).signedOut !== true) process.exit(1);
  });
'

echo "Milestone B local HTTP E2E passed."
