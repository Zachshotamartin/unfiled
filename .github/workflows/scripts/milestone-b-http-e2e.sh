#!/usr/bin/env bash

set -euo pipefail

trap 'echo "Milestones B–E1 HTTP E2E failed near line $LINENO." >&2' ERR

if ! command -v psql >/dev/null 2>&1; then
  echo "The Milestones B–E1 HTTP E2E requires the PostgreSQL psql client." >&2
  exit 1
fi
e2e_psql_version="$(psql --version)"
case "$e2e_psql_version" in
  "psql (PostgreSQL) "[0-9]*) ;;
  *)
    echo "The PostgreSQL client returned an unrecognized version: $e2e_psql_version" >&2
    exit 1
    ;;
esac
printf 'Milestones B–E1 HTTP E2E PostgreSQL client: %s\n' "$e2e_psql_version"

e2e_tmp_dir="$(mktemp -d)"
e2e_app_pid=""
e2e_encrypted_owner_id=""
e2e_stage="bootstrap"

cleanup() {
  local exit_code="$?"
  trap - EXIT
  if [[ -n "$e2e_app_pid" ]]; then
    kill "$e2e_app_pid" 2>/dev/null || true
    wait "$e2e_app_pid" 2>/dev/null || true
  fi
  if [[ -n "${e2e_encrypted_owner_id:-}" && -n "${SERVICE_ROLE_KEY:-}" ]]; then
    curl --silent --output /dev/null \
      --request DELETE \
      --header "apikey: $SERVICE_ROLE_KEY" \
      --header "authorization: Bearer $SERVICE_ROLE_KEY" \
      "${e2e_supabase_url:-http://127.0.0.1:54321}/auth/v1/admin/users/$e2e_encrypted_owner_id" \
      || true
  fi
  if [[ "$exit_code" -ne 0 && -f "$e2e_tmp_dir/web.log" ]]; then
    printf 'Milestones B–E1 HTTP E2E stopped at stage: %s\n' "$e2e_stage" >&2
    # Keep failure diagnostics bounded without ever echoing a plaintext test
    # canary if the application has regressed and logged one.
    tail -n 120 "$e2e_tmp_dir/web.log" | \
      E2E_LOG_CANARY_A_TITLE="${e2e_e1_sensitive_title_a:-}" \
      E2E_LOG_CANARY_A_BODY="${e2e_e1_sensitive_body_a:-}" \
      E2E_LOG_DESTINATION_A="${e2e_e1_destination_title_a:-}" \
      E2E_LOG_CANARY_B_TITLE="${e2e_e1_sensitive_title_b:-}" \
      E2E_LOG_CANARY_B_BODY="${e2e_e1_sensitive_body_b:-}" \
      E2E_LOG_DESTINATION_B="${e2e_e1_destination_title_b:-}" \
      E2E_LOG_SOURCE_LATER_B="${e2e_e1_later_title_b:-}" \
      E2E_LOG_CANARY_C_TITLE="${e2e_e1_sensitive_title_c:-}" \
      E2E_LOG_CANARY_C_BODY="${e2e_e1_sensitive_body_c:-}" \
      E2E_LOG_DESTINATION_C="${e2e_e1_destination_title_c:-}" \
      E2E_LOG_SOURCE_LATER_C="${e2e_e1_source_later_title_c:-}" \
      E2E_LOG_CANARY_D_TITLE="${e2e_e1_sensitive_title_d:-}" \
      E2E_LOG_CANARY_D_BODY="${e2e_e1_sensitive_body_d:-}" \
      E2E_LOG_PRIVATE_DESTINATION_D="${e2e_e1_private_destination_title_d:-}" \
      E2E_LOG_SOURCE_LATER_D="${e2e_e1_source_later_title_d:-}" \
      E2E_LOG_AI_TARGET_TITLE_D="${e2e_e1_ai_target_title_d:-}" \
      E2E_LOG_AI_TARGET_BODY_D="${e2e_e1_ai_target_body_d:-}" \
      E2E_LOG_CAPTURE_CANARY="${e2e_capture_canary:-}" \
      E2E_LOG_SEARCH_CANARY="${e2e_private_search_canary:-}" node -e '
        let input = "";
        process.stdin.on("data", (chunk) => (input += chunk));
        process.stdin.on("end", () => {
          for (const [name, value] of Object.entries(process.env)) {
            if (name.startsWith("E2E_LOG_") && typeof value === "string" && value.length > 0) {
              input = input.replaceAll(value, "[REDACTED]");
            }
          }
          process.stdout.write(input);
        });
      ' || true
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
if [[ ! "$e2e_run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]]; then
  echo "E2E_RUN_ID must contain 1-32 safe identifier characters." >&2
  exit 1
fi
e2e_standalone_dir="$e2e_tmp_dir/standalone"

case "$e2e_supabase_url" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *)
    echo "The HTTP E2E fixture may provision users only in local Supabase." >&2
    exit 1
    ;;
esac

service_rpc_json() {
  local function_name="$1"
  local body="$2"
  curl --fail --silent --show-error \
    --request POST \
    --header "apikey: $SERVICE_ROLE_KEY" \
    --header "authorization: Bearer $SERVICE_ROLE_KEY" \
    --header "content-type: application/json" \
    --data "$body" \
    "$e2e_supabase_url/rest/v1/rpc/$function_name"
}

e2e_contract_readiness_before="$(
  service_rpc_json get_encrypted_storage_contract_readiness '{}'
)"
E2E_READINESS="$e2e_contract_readiness_before" node -e '
  const value = JSON.parse(process.env.E2E_READINESS);
  if (value.contractVersion !== 1 || !/^[0-9a-f]{64}$/u.test(value.readinessDigest)) {
    process.exit(1);
  }
'

# E1's owner-interaction endpoints are encrypted-only by contract. Provision a
# dedicated empty owner, register all four local custody slots, and move that
# owner through the same attested rollout RPCs used in production. The seeded
# demo owner remains on the historical compatibility path for the B/C checks.
e2e_encrypted_email="milestone-e1-$e2e_run_id@unfiled.local"
e2e_encrypted_password="Unfiled-e1-local-$e2e_run_id"
e2e_encrypted_user_body="$({
  E2E_EMAIL="$e2e_encrypted_email" E2E_PASSWORD="$e2e_encrypted_password" node -e '
    process.stdout.write(JSON.stringify({
      email: process.env.E2E_EMAIL,
      password: process.env.E2E_PASSWORD,
      email_confirm: true
    }));
  '
})"
e2e_encrypted_user="$({
  curl --fail --silent --show-error \
    --request POST \
    --header "apikey: $SERVICE_ROLE_KEY" \
    --header "authorization: Bearer $SERVICE_ROLE_KEY" \
    --header "content-type: application/json" \
    --data "$e2e_encrypted_user_body" \
    "$e2e_supabase_url/auth/v1/admin/users"
})"
e2e_encrypted_owner_id="$({
  printf '%s' "$e2e_encrypted_user" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id)) {
        process.exit(1);
      }
      process.stdout.write(value.id);
    });
  '
})"

e2e_key_ids=(
  "milestone-e1.ai.object.v1"
  "milestone-e1.ai.mac.v1"
  "milestone-e1.private.object.v1"
  "milestone-e1.private.mac.v1"
)
e2e_key_classes=("ai_assisted" "ai_assisted" "private_manual" "private_manual")
e2e_key_purposes=("object_wrap" "content_mac" "object_wrap" "content_mac")
e2e_key_root_ids=(
  "85000000-0000-4000-8000-000000000001"
  "85000000-0000-4000-8000-000000000002"
  "85000000-0000-4000-8000-000000000003"
  "85000000-0000-4000-8000-000000000004"
)
e2e_key_material_bytes=(17 18 19 20)

for e2e_key_index in "${!e2e_key_ids[@]}"; do
  e2e_register_body="$({
    node -e '
      const [ownerId, keyId, keyClass, purpose, rootId, byteValue] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({
        p_owner_id: ownerId,
        p_key_id: keyId,
        p_key_class: keyClass,
        p_key_purpose: purpose,
        p_key_version: 1,
        p_kms_key_id: "arn:aws:kms:us-west-2:123456789012:key/" + rootId,
        p_wrapped_intermediate_key: "\\x" + Number(byteValue).toString(16).padStart(2, "0").repeat(32)
      }));
    ' "$e2e_encrypted_owner_id" "${e2e_key_ids[$e2e_key_index]}" \
      "${e2e_key_classes[$e2e_key_index]}" "${e2e_key_purposes[$e2e_key_index]}" \
      "${e2e_key_root_ids[$e2e_key_index]}" "${e2e_key_material_bytes[$e2e_key_index]}"
  })"
  service_rpc_json register_user_content_key "$e2e_register_body" >/dev/null
  e2e_activate_body="$({
    node -e '
      process.stdout.write(JSON.stringify({p_owner_id: process.argv[1], p_key_id: process.argv[2]}));
    ' "$e2e_encrypted_owner_id" "${e2e_key_ids[$e2e_key_index]}"
  })"
  service_rpc_json activate_user_content_key "$e2e_activate_body" >/dev/null
done

e2e_rollout_body="$({
  node -e '
    process.stdout.write(JSON.stringify({
      p_owner_id: process.argv[1],
      p_expected_state: process.argv[2],
      p_next_state: process.argv[3]
    }));
  ' "$e2e_encrypted_owner_id" expanded dual_write
})"
service_rpc_json advance_content_encryption_rollout "$e2e_rollout_body" >/dev/null
e2e_backfill_body="$({
  node -e '
    process.stdout.write(JSON.stringify({
      p_owner_id: process.argv[1],
      p_batch_reference: process.argv[2],
      p_expected_cursor: null
    }));
  ' "$e2e_encrypted_owner_id" "milestone-e1-empty-$e2e_run_id"
})"
service_rpc_json complete_content_encryption_backfill "$e2e_backfill_body" >/dev/null
e2e_rollout_body="$({
  node -e '
    process.stdout.write(JSON.stringify({
      p_owner_id: process.argv[1],
      p_expected_state: "dual_write",
      p_next_state: "encrypted_read"
    }));
  ' "$e2e_encrypted_owner_id"
})"
service_rpc_json advance_content_encryption_rollout "$e2e_rollout_body" >/dev/null

e2e_scrub_id="$({
  node -e 'process.stdout.write(require("node:crypto").randomUUID())'
})"
e2e_scrub_body="$({
  node -e '
    process.stdout.write(JSON.stringify({
      p_owner_id: process.argv[1],
      p_scrub_id: process.argv[2],
      p_expected_state: "encrypted_read"
    }));
  ' "$e2e_encrypted_owner_id" "$e2e_scrub_id"
})"
service_rpc_json prepare_content_plaintext_scrub "$e2e_scrub_body" >/dev/null
e2e_scrub_batch_body="$({
  node -e '
    process.stdout.write(JSON.stringify({
      p_owner_id: process.argv[1],
      p_scrub_id: process.argv[2],
      p_expected_cursor: null,
      p_limit: 25
    }));
  ' "$e2e_encrypted_owner_id" "$e2e_scrub_id"
})"
e2e_scrub_batch="$({
  service_rpc_json scrub_content_plaintext_batch "$e2e_scrub_batch_body"
})"
e2e_scrub_cursor="$({
  printf '%s' "$e2e_scrub_batch" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.complete !== true || value.processedCount !== 0 || value.cursor !== null) {
        process.exit(1);
      }
      process.stdout.write("null");
    });
  '
})"
e2e_scrub_complete_body="$({
  node -e '
    const cursor = process.argv[3] === "null" ? null : process.argv[3];
    process.stdout.write(JSON.stringify({
      p_owner_id: process.argv[1],
      p_scrub_id: process.argv[2],
      p_expected_cursor: cursor
    }));
  ' "$e2e_encrypted_owner_id" "$e2e_scrub_id" "$e2e_scrub_cursor"
})"
service_rpc_json complete_content_plaintext_scrub "$e2e_scrub_complete_body" >/dev/null
e2e_rollout_body="$({
  node -e '
    process.stdout.write(JSON.stringify({
      p_owner_id: process.argv[1],
      p_expected_state: "encrypted_read",
      p_next_state: "encrypted_only"
    }));
  ' "$e2e_encrypted_owner_id"
})"
e2e_final_rollout="$({
  service_rpc_json advance_content_encryption_rollout "$e2e_rollout_body"
})"
printf '%s' "$e2e_final_rollout" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.state !== "encrypted_only" || value.readMode !== "encrypted") process.exit(1);
  });
'

e2e_local_key_ring="$({
  E2E_OWNER_ID="$e2e_encrypted_owner_id" node -e '
    const bindings = [
      ["ai_assisted", "object_wrap", "milestone-e1.ai.object.v1", 17],
      ["ai_assisted", "content_mac", "milestone-e1.ai.mac.v1", 18],
      ["private_manual", "object_wrap", "milestone-e1.private.object.v1", 19],
      ["private_manual", "content_mac", "milestone-e1.private.mac.v1", 20]
    ];
    process.stdout.write(JSON.stringify({
      version: 1,
      keys: bindings.map(([keyClass, purpose, keyId, byteValue]) => ({
        ownerId: process.env.E2E_OWNER_ID,
        keyClass,
        purpose,
        keyId,
        keyVersion: 1,
        status: "active",
        keyMaterial: Buffer.alloc(32, byteValue).toString("base64url")
      }))
    }));
  '
})"

# Next's standalone output intentionally omits public/ and .next/static. Stage
# the complete deployable artifact so this gate catches broken UI assets too.
cp -R apps/web/.next/standalone "$e2e_standalone_dir"
cp -R apps/web/public "$e2e_standalone_dir/apps/web/public"
cp -R apps/web/.next/static "$e2e_standalone_dir/apps/web/.next/static"

# Next's generated standalone launcher hard-codes NODE_ENV=production. Rewrite
# only the disposable staged copy so the security-enforced local key resolver
# can run in its permitted test identity; the built repository artifact and
# every production launch path remain byte-for-byte untouched.
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const source = fs.readFileSync(path, "utf8");
  const anchor = "process.env.NODE_ENV = \u0027production\u0027";
  const replacement =
    "process.env.NODE_ENV = process.env.UNFILED_HTTP_E2E_NODE_ENV || \u0027production\u0027";
  if (source.split(anchor).length !== 2) process.exit(1);
  fs.writeFileSync(path, source.replace(anchor, replacement));
' "$e2e_standalone_dir/apps/web/server.js"

NEXT_PUBLIC_SUPABASE_URL="$e2e_supabase_url" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
NEXT_PUBLIC_SITE_URL="$e2e_app_url" \
NODE_ENV="test" \
UNFILED_HTTP_E2E_NODE_ENV="test" \
AUTH_RATE_LIMIT_PEPPER="ci-auth-rate-limit-pepper-000000000001" \
CI="true" \
UNFILED_ALLOW_INSECURE_LOCAL_SUPABASE_E2E="1" \
UNFILED_E1_HTTP_DIAGNOSTICS="1" \
UNFILED_KEY_CUSTODIAN="local" \
UNFILED_LOCAL_KEY_RING_V1="$e2e_local_key_ring" \
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
        process.stderr.write("Create response note contract mismatch.\n");
        process.exit(1);
      }
      if (value.undo?.eligible !== true || value.replayed !== false) {
        process.stderr.write("Create response replay/undo contract mismatch.\n");
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

# E1 runs only on an owner whose library crossed the official encryption
# rollout boundary. Authenticate that dedicated owner without changing the
# historical demo session used by the surrounding compatibility checks.
e2e_encrypted_auth_body="$({
  E2E_EMAIL="$e2e_encrypted_email" E2E_PASSWORD="$e2e_encrypted_password" node -e '
    process.stdout.write(JSON.stringify({
      email: process.env.E2E_EMAIL,
      password: process.env.E2E_PASSWORD
    }));
  '
})"
e2e_encrypted_auth_response="$({
  curl --fail --silent --show-error \
    --request POST \
    --header "apikey: $ANON_KEY" \
    --header "content-type: application/json" \
    --data "$e2e_encrypted_auth_body" \
    "$e2e_supabase_url/auth/v1/token?grant_type=password"
})"
e2e_encrypted_access_token="$({
  printf '%s' "$e2e_encrypted_auth_response" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (typeof value.access_token !== "string" || value.access_token.length === 0) process.exit(1);
      process.stdout.write(value.access_token);
    });
  '
})"

e2e_encrypted_request_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local idempotency_key="${4:-}"
  local arguments=(
    --fail
    --silent
    --show-error
    --request "$method"
    --header "authorization: Bearer $e2e_encrypted_access_token"
  )
  if [[ -n "$body" ]]; then
    arguments+=(--header "content-type: application/json" --data "$body")
  fi
  if [[ -n "$idempotency_key" ]]; then
    arguments+=(--header "idempotency-key: $idempotency_key")
  fi
  curl "${arguments[@]}" "$e2e_app_url/api/v1$path"
}

e2e_encrypted_session="$(e2e_encrypted_request_json GET /auth/session)"
printf '%s' "$e2e_encrypted_session" | E2E_OWNER_ID="$e2e_encrypted_owner_id" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.user?.id !== process.env.E2E_OWNER_ID) process.exit(1);
    if (value.user.id === "00000000-0000-0000-0000-000000000000") process.exit(1);
    if (value.user.id === "11111111-1111-4111-8111-111111111111") process.exit(1);
  });
'

assert_private_cache_headers() {
  local headers_path="$1"
  node -e '
    const headers = require("node:fs").readFileSync(process.argv[1], "utf8").replaceAll("\r", "");
    if (!/^cache-control:\s*private, no-store\s*$/imu.test(headers)) process.exit(1);
    if (!/^pragma:\s*no-cache\s*$/imu.test(headers)) process.exit(1);
  ' "$headers_path"
}

assert_private_response_headers() {
  local headers_path="$1"
  assert_private_cache_headers "$headers_path"
  node -e '
    const headers = require("node:fs").readFileSync(process.argv[1], "utf8").replaceAll("\r", "");
    if (!/^content-type:\s*application\/json; charset=utf-8\s*$/imu.test(headers)) process.exit(1);
  ' "$headers_path"
}

assert_e1_json_status() {
  local expected_status="$1"
  local actual_status="$2"
  local response_path="$3"
  if [[ "$actual_status" == "$expected_status" ]]; then
    return 0
  fi
  E2E_STAGE="$e2e_stage" E2E_EXPECTED_STATUS="$expected_status" \
    E2E_ACTUAL_STATUS="$actual_status" node -e '
      const fs = require("node:fs");
      const safeToken = (value, pattern) =>
        typeof value === "string" && pattern.test(value) ? value : "unknown";
      let responseCode = "unknown";
      try {
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        responseCode = safeToken(value?.code, /^[a-z][a-z0-9_]{0,63}$/u);
      } catch {}
      const stage = safeToken(process.env.E2E_STAGE, /^[a-z0-9][a-z0-9-]{0,79}$/u);
      const expected = safeToken(process.env.E2E_EXPECTED_STATUS, /^[0-9]{3}$/u);
      const actual = safeToken(process.env.E2E_ACTUAL_STATUS, /^[0-9]{3}$/u);
      process.stderr.write(
        `E1 HTTP status mismatch at ${stage}: expected ${expected}, received ${actual} (${responseCode}).\n`
      );
    ' "$response_path"
  return 1
}

e2e_new_entity_id() {
  local prefix="$1"
  node -e '
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const bytes = require("node:crypto").randomBytes(26);
    const suffix = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    process.stdout.write(process.argv[1] + "_" + suffix);
  ' "$prefix"
}

# Runs the captured message through the official encrypted organizer
# prepare/commit RPC boundary. The checked-in helper temporarily enables only
# the dedicated local organizer login, consumes authentic prepared wrap
# reservations/MACs, proves persisted verification parity, and restores the
# role to NOLOGIN before returning.
setup_e1_interaction_fixture() {
  local label="$1"
  local source_title="$2"
  local capture_text="$3"
  local destination_title="$4"
  local destination_privacy="${5:-ai_assisted}"
  local destination_key="milestone-e1-$label-destination-$e2e_run_id"
  local destination_response
  local source_note_id
  local source_mutation_id
  local destination_note_id
  local capture_id
  local capture_created_at
  local capture_body
  local capture_response
  local job_id
  local fixture_input
  local fixture_response
  local decision_id
  local e2e_organizer_password

  case "$destination_privacy" in
    ai_assisted | private_manual) ;;
    *)
      echo "The E1 destination privacy fixture is invalid." >&2
      return 1
      ;;
  esac

  capture_id="$(e2e_new_entity_id cap)"
  capture_created_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  capture_body="$({
    E2E_CAPTURE_ID="$capture_id" E2E_CAPTURE_TEXT="$capture_text" \
      E2E_CREATED_AT="$capture_created_at" node -e '
        process.stdout.write(JSON.stringify({
          clientCaptureId: process.env.E2E_CAPTURE_ID,
          rawContent: process.env.E2E_CAPTURE_TEXT,
          source: "web",
          clientCreatedAt: process.env.E2E_CREATED_AT,
          clientTimezone: "UTC",
          privacy: "ai_assisted",
          expansionDisabled: false
        }));
      '
  })"
  capture_response="$({
    e2e_encrypted_request_json POST /captures "$capture_body" "$capture_id"
  })"
  job_id="$({
    printf '%s' "$capture_response" | E2E_CAPTURE_ID="$capture_id" node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (value.capture?.id !== process.env.E2E_CAPTURE_ID || value.capture?.status !== "queued") {
          process.exit(1);
        }
        if (value.replayed !== false || typeof value.jobId !== "string") process.exit(1);
        process.stdout.write(value.jobId);
      });
    '
  })"

  fixture_input="$({
    E2E_OWNER_ID="$e2e_encrypted_owner_id" E2E_CAPTURE_ID="$capture_id" \
      E2E_JOB_ID="$job_id" E2E_SOURCE_TITLE="$source_title" \
      E2E_CAPTURE_TEXT="$capture_text" node -e '
        process.stdout.write(JSON.stringify({
          ownerId: process.env.E2E_OWNER_ID,
          captureId: process.env.E2E_CAPTURE_ID,
          jobId: process.env.E2E_JOB_ID,
          sourceTitle: process.env.E2E_SOURCE_TITLE,
          captureText: process.env.E2E_CAPTURE_TEXT
        }));
      '
  })"
  e2e_organizer_password="$({
    node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))'
  })"
  fixture_response="$({
    env -u VERCEL -u VERCEL_ENV -u VERCEL_PROJECT_ID \
      NODE_ENV="test" \
      UNFILED_KEY_CUSTODIAN="local" \
      UNFILED_LOCAL_KEY_RING_V1="$e2e_local_key_ring" \
      UNFILED_E1_LOCAL_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
      UNFILED_E1_ORGANIZER_PASSWORD="$e2e_organizer_password" \
      UNFILED_E1_HTTP_FIXTURE_JSON="$fixture_input" \
      pnpm --filter @unfiled/organizer exec tsx scripts/milestone-e1-http-fixture.ts
  })"
  read -r decision_id source_note_id source_mutation_id < <(
    printf '%s' "$fixture_response" | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (!/^dec_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.decisionId)) process.exit(1);
        if (!/^note_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.sourceNoteId)) process.exit(1);
        if (!/^mut_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.sourceMutationId)) process.exit(1);
        process.stdout.write(
          value.decisionId + " " + value.sourceNoteId + " " + value.sourceMutationId + "\n"
        );
      });
    '
  )

  e2e_encrypted_request_json GET "/notes/$source_note_id" | \
    E2E_EXPECTED_TITLE="$source_title" E2E_EXPECTED_BODY="$capture_text" node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (value.note?.currentRevision !== 1) process.exit(1);
        if (value.note?.title !== process.env.E2E_EXPECTED_TITLE) process.exit(1);
        if (value.note?.bodyMarkdown !== process.env.E2E_EXPECTED_BODY) process.exit(1);
      });
    '

  destination_response="$({
    e2e_encrypted_request_json POST /notes \
      "{\"idempotencyKey\":\"$destination_key\",\"title\":\"$destination_title\",\"type\":\"generic\",\"bodyMarkdown\":\"Fixture destination body\",\"privacy\":\"$destination_privacy\"}" \
      "$destination_key"
  })"
  destination_note_id="$({
    printf '%s' "$destination_response" | E2E_EXPECTED_TITLE="$destination_title" \
      E2E_EXPECTED_PRIVACY="$destination_privacy" node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (value.note?.currentRevision !== 1 || value.note?.title !== process.env.E2E_EXPECTED_TITLE) {
          process.exit(1);
        }
        if (value.note.privacy !== process.env.E2E_EXPECTED_PRIVACY) process.exit(1);
        process.stdout.write(value.note.id);
      });
    '
  })"

  printf '%s %s %s %s %s %s\n' \
    "$source_note_id" "$source_mutation_id" "$destination_note_id" \
    "$capture_id" "$job_id" "$decision_id"
}

correct_e1_fixture_decision() {
  local label="$1"
  local decision_id="$2"
  local source_note_id="$3"
  local destination_note_id="$4"
  local idempotency_key="milestone-e1-$label-correction-$e2e_run_id"
  local body
  local status
  body="{\"idempotencyKey\":\"$idempotency_key\",\"source\":{\"noteId\":\"$source_note_id\",\"expectedRevision\":1},\"destination\":{\"type\":\"existing_note\",\"noteId\":\"$destination_note_id\",\"expectedRevision\":1}}"
  status="$({
    curl --silent --show-error \
      --request POST \
      --header "authorization: Bearer $e2e_encrypted_access_token" \
      --header "content-type: application/json" \
      --header "idempotency-key: $idempotency_key" \
      --data "$body" \
      --dump-header "$e2e_tmp_dir/e1-$label-correction.headers" \
      --output "$e2e_tmp_dir/e1-$label-correction.json" \
      --write-out '%{http_code}' \
      "$e2e_app_url/api/v1/decisions/$decision_id/correct"
  })"
  if [[ "$status" != "200" ]]; then
    E2E_STATUS="$status" node -e '
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const rawCode = typeof value.code === "string" ? value.code : "";
      const code = /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode) ? rawCode : "unknown";
      process.stderr.write(`The E1 correction fixture returned HTTP ${process.env.E2E_STATUS} (${code}).\n`);
    ' "$e2e_tmp_dir/e1-$label-correction.json"
    psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
      --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
      --command "
        select jsonb_build_object(
          'claimCount', (select count(*) from public.encrypted_owner_interaction_claims
            where user_id = '$e2e_encrypted_owner_id'::uuid and idempotency_key = '$idempotency_key'),
          'completedCount', (select count(*) from public.encrypted_owner_interaction_claims
            where user_id = '$e2e_encrypted_owner_id'::uuid and idempotency_key = '$idempotency_key'
              and completed_at is not null),
          'selectedOutcome', (select selected_outcome from public.encrypted_owner_interaction_claims
            where user_id = '$e2e_encrypted_owner_id'::uuid and idempotency_key = '$idempotency_key'),
          'receiptRevision', (select receipt_revision from public.encrypted_owner_interaction_claims
            where user_id = '$e2e_encrypted_owner_id'::uuid and idempotency_key = '$idempotency_key'),
          'decisionRevision', (select decision_content_revision from public.encrypted_owner_interaction_claims
            where user_id = '$e2e_encrypted_owner_id'::uuid and idempotency_key = '$idempotency_key'),
          'memberShape', coalesce((select jsonb_agg(jsonb_build_object(
              'ordinal', ordinal,
              'role', role,
              'expectedRevision', expected_revision,
              'sourcePrivacy', source_privacy,
              'targetPrivacy', target_privacy
            ) order by ordinal)
            from public.encrypted_owner_interaction_members
            where user_id = '$e2e_encrypted_owner_id'::uuid and idempotency_key = '$idempotency_key'), '[]'::jsonb),
          'reservationRoles', coalesce((select jsonb_agg(branch::text || ':' || role order by branch, role)
            from public.encrypted_owner_interaction_reservations
            where user_id = '$e2e_encrypted_owner_id'::uuid and idempotency_key = '$idempotency_key'), '[]'::jsonb)
        );
      " >&2 || true
    return 1
  fi
  assert_private_response_headers "$e2e_tmp_dir/e1-$label-correction.headers"
  E2E_DECISION_ID="$decision_id" E2E_SOURCE_NOTE_ID="$source_note_id" \
    E2E_DESTINATION_NOTE_ID="$destination_note_id" node -e '
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (value.outcome !== "applied" || value.decisionId !== process.env.E2E_DECISION_ID) {
        process.exit(1);
      }
      if (value.source?.noteId !== process.env.E2E_SOURCE_NOTE_ID || value.source?.currentRevision !== 2) {
        process.exit(1);
      }
      if (value.destination?.noteId !== process.env.E2E_DESTINATION_NOTE_ID || value.destination?.currentRevision !== 2) {
        process.exit(1);
      }
      if (value.replayed !== false) process.exit(1);
      process.stdout.write(value.source.mutationId + " " + value.destination.mutationId + "\n");
    ' "$e2e_tmp_dir/e1-$label-correction.json"
}

assert_e1_post_only() {
  local label="$1"
  local path="$2"
  local status
  status="$({
    curl --silent --show-error \
      --request GET \
      --header "authorization: Bearer $e2e_encrypted_access_token" \
      --dump-header "$e2e_tmp_dir/e1-$label-method.headers" \
      --output "$e2e_tmp_dir/e1-$label-method.json" \
      --write-out '%{http_code}' \
      "$e2e_app_url/api/v1$path"
  })"
  [[ "$status" == "405" ]]
  assert_private_cache_headers "$e2e_tmp_dir/e1-$label-method.headers"
  node -e '
    const fs = require("node:fs");
    const headers = fs.readFileSync(process.argv[1], "utf8").replaceAll("\r", "");
    const body = fs.readFileSync(process.argv[2]);
    if (!/^allow:\s*POST\s*$/imu.test(headers)) process.exit(1);
    if (/^content-type:/imu.test(headers)) process.exit(1);
    if (body.length !== 0) process.exit(1);
  ' "$e2e_tmp_dir/e1-$label-method.headers" "$e2e_tmp_dir/e1-$label-method.json"
}

e2e_e1_create_key="milestone-e1-http-create-$e2e_run_id"
e2e_e1_create_status="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_create_key" \
    --data "{\"idempotencyKey\":\"$e2e_e1_create_key\",\"title\":\"Encrypted HTTP gate note\",\"type\":\"generic\",\"bodyMarkdown\":\"encrypted owner body\",\"privacy\":\"ai_assisted\"}" \
    --output "$e2e_tmp_dir/e1-create.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/notes"
})"
if [[ "$e2e_e1_create_status" != "201" ]]; then
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const rawCode = typeof value.code === "string" ? value.code : "";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode) ? rawCode : "unknown";
    process.stderr.write(`Encrypted note create failed (${code}).\n`);
  ' "$e2e_tmp_dir/e1-create.json"
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --command="select 'encrypted-create-safe-state claims=' || count(*) || ' completed=' || count(*) filter (where completed_at is not null) || ' reservations=' || (select count(*) from public.content_key_operation_reservations where user_id = '$e2e_encrypted_owner_id'::uuid) || ' notes=' || (select count(*) from public.notes where user_id = '$e2e_encrypted_owner_id'::uuid) from public.encrypted_note_write_claims where user_id = '$e2e_encrypted_owner_id'::uuid;" \
    >&2
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --command="select private.encrypted_note_claim_projection(claim) || jsonb_build_object('encryptedResponse', null, 'replayed', false) from public.encrypted_note_write_claims as claim where claim.user_id = '$e2e_encrypted_owner_id'::uuid;" \
    >&2
  exit 1
fi
e2e_e1_create="$(<"$e2e_tmp_dir/e1-create.json")"
e2e_e1_note_id="$({
  printf '%s' "$e2e_e1_create" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 1 || value.note?.title !== "Encrypted HTTP gate note") {
        process.exit(1);
      }
      if (value.undo?.eligible !== true || value.replayed !== false) process.exit(1);
      process.stdout.write(value.note.id);
    });
  '
})"

e2e_e1_update_key="milestone-e1-http-update-$e2e_run_id"
e2e_e1_update="$({
  e2e_encrypted_request_json PATCH "/notes/$e2e_e1_note_id" \
    "{\"expectedRevision\":1,\"idempotencyKey\":\"$e2e_e1_update_key\",\"title\":\"Encrypted HTTP gate note edited\"}" \
    "$e2e_e1_update_key"
})"
e2e_e1_update_mutation_id="$({
  printf '%s' "$e2e_e1_update" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || value.note?.title !== "Encrypted HTTP gate note edited") {
        process.exit(1);
      }
      process.stdout.write(value.mutationId);
    });
  '
})"

e2e_e1_undo_key="milestone-e1-http-batch-undo-$e2e_run_id"
e2e_e1_undo_body="{\"expectedRevision\":2,\"idempotencyKey\":\"$e2e_e1_undo_key\"}"
e2e_e1_undo_status="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_undo_key" \
    --data "$e2e_e1_undo_body" \
    --dump-header "$e2e_tmp_dir/e1-batch-undo.headers" \
    --output "$e2e_tmp_dir/e1-batch-undo.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_update_mutation_id/undo"
})"
if [[ "$e2e_e1_undo_status" != "200" ]]; then
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const rawCode = typeof value.code === "string" ? value.code : "";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode) ? rawCode : "unknown";
    process.stderr.write(`Encrypted batch Undo failed (${code}).\n`);
  ' "$e2e_tmp_dir/e1-batch-undo.json"
  exit 1
fi
e2e_e1_undo="$(<"$e2e_tmp_dir/e1-batch-undo.json")"
e2e_e1_undo_mutation_id="$({
  printf '%s' "$e2e_e1_undo" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.replayed !== false || value.members?.length !== 1) process.exit(1);
      if (value.members[0]?.note?.currentRevision !== 3) process.exit(1);
      if (value.members[0]?.note?.title !== "Encrypted HTTP gate note") process.exit(1);
      process.stdout.write(value.members[0].mutationId);
    });
  '
})"

e2e_e1_undo_replay="$({
  e2e_encrypted_request_json POST "/mutation-batches/$e2e_e1_update_mutation_id/undo" \
    "$e2e_e1_undo_body" "$e2e_e1_undo_key"
})"
printf '%s' "$e2e_e1_undo_replay" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.replayed !== true || value.members?.length !== 1) process.exit(1);
    if (value.members[0]?.note?.currentRevision !== 3) process.exit(1);
    if (value.members[0]?.note?.title !== "Encrypted HTTP gate note") process.exit(1);
  });
'

# A legacy single-note Undo must fail closed for any E1 batch member. Even a
# singleton batch stays on the server-derived batch path, so a future two-note
# member can never be independently split through the compatibility endpoint.
e2e_e1_legacy_guard_key="milestone-e1-http-legacy-batch-guard-$e2e_run_id"
e2e_e1_legacy_guard_status="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_legacy_guard_key" \
    --data "{\"expectedRevision\":3,\"idempotencyKey\":\"$e2e_e1_legacy_guard_key\"}" \
    --output "$e2e_tmp_dir/e1-legacy-batch-guard.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutations/$e2e_e1_undo_mutation_id/undo"
})"
[[ "$e2e_e1_legacy_guard_status" == "409" ]]
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "conflict_requires_review") process.exit(1);
' "$e2e_tmp_dir/e1-legacy-batch-guard.json"
e2e_encrypted_request_json GET "/notes/$e2e_e1_note_id" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.currentRevision !== 3 || value.note?.title !== "Encrypted HTTP gate note") {
      process.exit(1);
    }
  });
'

# A real organizer-created decision is corrected across two notes. Its
# capture-linked correction batch must Undo atomically and rewrite the same
# encrypted receipt without losing its public reason/action projection.
e2e_stage="e1-a-fixture"
e2e_e1_sensitive_title_a="E1 sensitive title $e2e_run_id"
e2e_e1_sensitive_body_a="E1 sensitive body $e2e_run_id"
e2e_e1_destination_title_a="E1 correction destination $e2e_run_id"
read -r e2e_e1_source_a e2e_e1_source_create_mutation_a \
  e2e_e1_destination_a e2e_e1_capture_a e2e_e1_job_a e2e_e1_decision_a < <(
  setup_e1_interaction_fixture \
    applied "$e2e_e1_sensitive_title_a" "$e2e_e1_sensitive_body_a" \
    "$e2e_e1_destination_title_a"
)
[[ "$e2e_e1_source_create_mutation_a" =~ ^mut_[0-9A-HJKMNP-TV-Z]{26}$ ]]
read -r e2e_e1_source_correction_mutation_a e2e_e1_destination_correction_mutation_a < <(
  correct_e1_fixture_decision \
    applied "$e2e_e1_decision_a" "$e2e_e1_source_a" "$e2e_e1_destination_a"
)

e2e_e1_correction_key_a="milestone-e1-applied-correction-$e2e_run_id"
e2e_stage="e1-a-replay"
e2e_e1_correction_body_a="{\"idempotencyKey\":\"$e2e_e1_correction_key_a\",\"source\":{\"noteId\":\"$e2e_e1_source_a\",\"expectedRevision\":1},\"destination\":{\"type\":\"existing_note\",\"noteId\":\"$e2e_e1_destination_a\",\"expectedRevision\":1}}"
e2e_e1_correction_replay_status_a="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_correction_key_a" \
    --data "$e2e_e1_correction_body_a" \
    --dump-header "$e2e_tmp_dir/e1-applied-correction-replay.headers" \
    --output "$e2e_tmp_dir/e1-applied-correction-replay.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/decisions/$e2e_e1_decision_a/correct"
})"
if [[ "$e2e_e1_correction_replay_status_a" != "200" ]]; then
  E2E_STATUS="$e2e_e1_correction_replay_status_a" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const rawCode = typeof value.code === "string" ? value.code : "";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode) ? rawCode : "unknown";
    process.stderr.write(`The E1 correction replay returned HTTP ${process.env.E2E_STATUS} (${code}).\n`);
  ' "$e2e_tmp_dir/e1-applied-correction-replay.json"
  exit 1
fi
assert_private_response_headers "$e2e_tmp_dir/e1-applied-correction-replay.headers"
E2E_SOURCE_MUTATION="$e2e_e1_source_correction_mutation_a" \
  E2E_DESTINATION_MUTATION="$e2e_e1_destination_correction_mutation_a" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const failures = [];
    if (value.outcome !== "applied") failures.push("outcome");
    if (value.replayed !== true) failures.push("replayed");
    if (value.source?.mutationId !== process.env.E2E_SOURCE_MUTATION) failures.push("source");
    if (value.destination?.mutationId !== process.env.E2E_DESTINATION_MUTATION) {
      failures.push("destination");
    }
    if (failures.length > 0) {
      process.stderr.write(`The E1 correction replay binding failed: ${failures.join(",")}.\n`);
      process.exit(1);
    }
  ' "$e2e_tmp_dir/e1-applied-correction-replay.json"

e2e_stage="e1-a-idempotency-mismatch"
e2e_e1_correction_mismatch_status_a="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_correction_key_a" \
    --data "{\"idempotencyKey\":\"$e2e_e1_correction_key_a\",\"source\":{\"noteId\":\"$e2e_e1_source_a\",\"expectedRevision\":1},\"destination\":{\"type\":\"existing_note\",\"noteId\":\"$e2e_e1_destination_a\",\"expectedRevision\":2}}" \
    --dump-header "$e2e_tmp_dir/e1-applied-correction-mismatch.headers" \
    --output "$e2e_tmp_dir/e1-applied-correction-mismatch.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/decisions/$e2e_e1_decision_a/correct"
})"
if [[ "$e2e_e1_correction_mismatch_status_a" != "409" ]]; then
  E2E_STATUS="$e2e_e1_correction_mismatch_status_a" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const rawCode = typeof value.code === "string" ? value.code : "";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode) ? rawCode : "unknown";
    process.stderr.write(`The E1 correction mismatch returned HTTP ${process.env.E2E_STATUS} (${code}).\n`);
  ' "$e2e_tmp_dir/e1-applied-correction-mismatch.json"
  exit 1
fi
assert_private_response_headers "$e2e_tmp_dir/e1-applied-correction-mismatch.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "invalid_idempotency_key") process.exit(1);
' "$e2e_tmp_dir/e1-applied-correction-mismatch.json"

e2e_stage="e1-a-receipt"
e2e_e1_receipt_status_a="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-applied-receipt.headers" \
    --output "$e2e_tmp_dir/e1-applied-receipt.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_e1_capture_a/receipt"
})"
if [[ "$e2e_e1_receipt_status_a" != "200" ]]; then
  E2E_STATUS="$e2e_e1_receipt_status_a" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const rawCode = typeof value.code === "string" ? value.code : "";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode) ? rawCode : "unknown";
    process.stderr.write(`The E1 corrected receipt returned HTTP ${process.env.E2E_STATUS} (${code}).\n`);
  ' "$e2e_tmp_dir/e1-applied-receipt.json"
  exit 1
fi
assert_private_response_headers "$e2e_tmp_dir/e1-applied-receipt.headers"
E2E_CAPTURE_ID="$e2e_e1_capture_a" E2E_JOB_ID="$e2e_e1_job_a" \
  E2E_DECISION_ID="$e2e_e1_decision_a" E2E_DESTINATION_ID="$e2e_e1_destination_a" \
  E2E_MUTATION_ID="$e2e_e1_destination_correction_mutation_a" \
  E2E_CAPTURE_TEXT="$e2e_e1_sensitive_body_a" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const receipt = value.receipt;
    const failures = [];
    if (receipt?.captureId !== process.env.E2E_CAPTURE_ID) failures.push("capture");
    if (receipt.jobId !== process.env.E2E_JOB_ID || receipt.decisionId !== process.env.E2E_DECISION_ID) {
      failures.push("lineage");
    }
    if (receipt.outcome !== "added_to_note" || receipt.reviewItemId !== null) failures.push("outcome");
    if (receipt.destination?.noteId !== process.env.E2E_DESTINATION_ID) failures.push("destination");
    if (receipt.mutationId !== process.env.E2E_MUTATION_ID) failures.push("mutation");
    if (JSON.stringify(receipt.reasonCodes) !== JSON.stringify(["user_correction"])) {
      failures.push("reasons");
    }
    if (receipt.insertedContent?.length !== 1) failures.push("inserted-count");
    if (receipt.insertedContent?.[0]?.type !== "captured") failures.push("inserted-type");
    if (receipt.insertedContent?.[0]?.content !== process.env.E2E_CAPTURE_TEXT) {
      failures.push("inserted-content");
    }
    const undo = receipt.actions?.find(({ type }) => type === "undo");
    if (undo?.mutationId !== process.env.E2E_MUTATION_ID || undo.expectedRevision !== 2) {
      failures.push("undo");
    }
    if (failures.length > 0) {
      process.stderr.write(`The E1 corrected receipt binding failed: ${failures.join(",")}.\n`);
      process.exit(1);
    }
  ' "$e2e_tmp_dir/e1-applied-receipt.json"

e2e_e1_non_anchor_undo_key_a="milestone-e1-non-anchor-batch-undo-$e2e_run_id"
e2e_e1_non_anchor_undo_status_a="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_non_anchor_undo_key_a" \
    --data "{\"expectedRevision\":2,\"idempotencyKey\":\"$e2e_e1_non_anchor_undo_key_a\"}" \
    --dump-header "$e2e_tmp_dir/e1-non-anchor-batch-undo.headers" \
    --output "$e2e_tmp_dir/e1-non-anchor-batch-undo.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_source_correction_mutation_a/undo"
})"
[[ "$e2e_e1_non_anchor_undo_status_a" == "409" ]]
assert_private_response_headers "$e2e_tmp_dir/e1-non-anchor-batch-undo.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "conflict_requires_review") process.exit(1);
' "$e2e_tmp_dir/e1-non-anchor-batch-undo.json"

e2e_e1_batch_undo_key_a="milestone-e1-applied-batch-undo-$e2e_run_id"
e2e_e1_batch_undo_body_a="{\"expectedRevision\":2,\"idempotencyKey\":\"$e2e_e1_batch_undo_key_a\"}"
e2e_e1_batch_undo_status_a="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_batch_undo_key_a" \
    --data "$e2e_e1_batch_undo_body_a" \
    --dump-header "$e2e_tmp_dir/e1-applied-batch-undo.headers" \
    --output "$e2e_tmp_dir/e1-applied-batch-undo.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_destination_correction_mutation_a/undo"
})"
[[ "$e2e_e1_batch_undo_status_a" == "200" ]]
assert_private_response_headers "$e2e_tmp_dir/e1-applied-batch-undo.headers"
e2e_e1_restored_source_mutation_a="$({
  E2E_SOURCE_ID="$e2e_e1_source_a" E2E_DESTINATION_ID="$e2e_e1_destination_a" \
    E2E_SOURCE_TITLE="$e2e_e1_sensitive_title_a" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (value.replayed !== false || value.members?.length !== 2) process.exit(1);
    const source = value.members.find((member) => member.note?.id === process.env.E2E_SOURCE_ID);
    const destination = value.members.find(
      (member) => member.note?.id === process.env.E2E_DESTINATION_ID
    );
    if (source?.note?.currentRevision !== 3 || source.note.deletedAt !== null) process.exit(1);
    if (source.note.title !== process.env.E2E_SOURCE_TITLE) process.exit(1);
    if (destination?.note?.currentRevision !== 3) process.exit(1);
    if (destination.note.bodyMarkdown !== "Fixture destination body") process.exit(1);
    if (!/^mut_[0-9A-HJKMNP-TV-Z]{26}$/u.test(source.mutationId)) process.exit(1);
    process.stdout.write(source.mutationId);
  ' "$e2e_tmp_dir/e1-applied-batch-undo.json"
})"
[[ "$e2e_e1_restored_source_mutation_a" =~ ^mut_[0-9A-HJKMNP-TV-Z]{26}$ ]]

e2e_e1_batch_undo_replay_status_a="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_batch_undo_key_a" \
    --data "$e2e_e1_batch_undo_body_a" \
    --dump-header "$e2e_tmp_dir/e1-applied-batch-undo-replay.headers" \
    --output "$e2e_tmp_dir/e1-applied-batch-undo-replay.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_destination_correction_mutation_a/undo"
})"
[[ "$e2e_e1_batch_undo_replay_status_a" == "200" ]]
assert_private_response_headers "$e2e_tmp_dir/e1-applied-batch-undo-replay.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.members?.length !== 2) process.exit(1);
' "$e2e_tmp_dir/e1-applied-batch-undo-replay.json"

e2e_e1_batch_undo_mismatch_status_a="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_batch_undo_key_a" \
    --data "{\"expectedRevision\":3,\"idempotencyKey\":\"$e2e_e1_batch_undo_key_a\"}" \
    --dump-header "$e2e_tmp_dir/e1-applied-batch-undo-mismatch.headers" \
    --output "$e2e_tmp_dir/e1-applied-batch-undo-mismatch.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_destination_correction_mutation_a/undo"
})"
[[ "$e2e_e1_batch_undo_mismatch_status_a" == "409" ]]
assert_private_response_headers "$e2e_tmp_dir/e1-applied-batch-undo-mismatch.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "invalid_idempotency_key") process.exit(1);
' "$e2e_tmp_dir/e1-applied-batch-undo-mismatch.json"

e2e_e1_receipt_after_undo_status_a="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-applied-receipt-after-undo.headers" \
    --output "$e2e_tmp_dir/e1-applied-receipt-after-undo.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_e1_capture_a/receipt"
})"
[[ "$e2e_e1_receipt_after_undo_status_a" == "200" ]]
assert_private_response_headers "$e2e_tmp_dir/e1-applied-receipt-after-undo.headers"
E2E_CAPTURE_ID="$e2e_e1_capture_a" E2E_JOB_ID="$e2e_e1_job_a" \
  E2E_DECISION_ID="$e2e_e1_decision_a" E2E_SOURCE_ID="$e2e_e1_source_a" \
  E2E_MUTATION_ID="$e2e_e1_restored_source_mutation_a" \
  E2E_CAPTURE_TEXT="$e2e_e1_sensitive_body_a" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const receipt = value.receipt;
    if (receipt?.captureId !== process.env.E2E_CAPTURE_ID) process.exit(1);
    if (receipt.jobId !== process.env.E2E_JOB_ID || receipt.decisionId !== process.env.E2E_DECISION_ID) {
      process.exit(1);
    }
    if (receipt.outcome !== "added_to_note" || receipt.reviewItemId !== null) process.exit(1);
    if (receipt.destination?.noteId !== process.env.E2E_SOURCE_ID) process.exit(1);
    if (receipt.mutationId !== process.env.E2E_MUTATION_ID) process.exit(1);
    if (receipt.insertedContent?.length !== 1) process.exit(1);
    if (receipt.insertedContent[0]?.type !== "captured") process.exit(1);
    if (receipt.insertedContent[0]?.content !== process.env.E2E_CAPTURE_TEXT) process.exit(1);
    if (receipt.actions?.length !== 2) process.exit(1);
    const open = receipt.actions.find(({ type }) => type === "open");
    const move = receipt.actions.find(({ type }) => type === "move");
    if (open?.noteId !== process.env.E2E_SOURCE_ID) process.exit(1);
    if (move?.noteId !== process.env.E2E_SOURCE_ID || move.decisionId !== process.env.E2E_DECISION_ID) {
      process.exit(1);
    }
    if (receipt.actions.some(({ type }) => type === "undo")) process.exit(1);
    if (JSON.stringify(receipt.reasonCodes) !== JSON.stringify(["user_undo"])) process.exit(1);
  ' "$e2e_tmp_dir/e1-applied-receipt-after-undo.json"

e2e_stage="e1-a-restored-route-attestation"
e2e_e1_restored_route_attestation_a="$({
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator='|' \
    --set=owner_id="$e2e_encrypted_owner_id" \
    --set=capture_id="$e2e_e1_capture_a" \
    --set=decision_id="$e2e_e1_decision_a" \
    --set=source_id="$e2e_e1_source_a" \
    --set=destination_id="$e2e_e1_destination_a" \
    --set=mutation_id="$e2e_e1_restored_source_mutation_a" <<'SQL'
      select
        coalesce((select destination_note_id = :'source_id'
          from public.organization_decisions
          where user_id = :'owner_id'::uuid and id = :'decision_id'), false),
        coalesce((select outcome = 'added_to_note'
            and destination_note_id = :'source_id'
            and mutation_id = :'mutation_id'
          from public.capture_receipts
          where user_id = :'owner_id'::uuid and capture_id = :'capture_id'), false),
        coalesce((select status = 'organized'
          from public.captures
          where user_id = :'owner_id'::uuid and id = :'capture_id'), false),
        coalesce((select relation = 'routed' and mutation_id = :'mutation_id'
          from public.capture_note_links
          where user_id = :'owner_id'::uuid and capture_id = :'capture_id'
            and note_id = :'source_id'), false),
        coalesce((select relation = 'source_removed'
          from public.capture_note_links
          where user_id = :'owner_id'::uuid and capture_id = :'capture_id'
            and note_id = :'destination_id'), false),
        coalesce((select decision_id = :'decision_id'
          from public.note_mutations
          where user_id = :'owner_id'::uuid and id = :'mutation_id'), false);
SQL
})"
[[ "$e2e_e1_restored_route_attestation_a" == "t|t|t|t|t|t" ]]

# The restored receipt still offers Move. Exercise it so the decision ID on
# the restored-source mutation and the original typed-plan seed are proved,
# rather than merely trusting the advertised action shape.
e2e_stage="e1-a-move-after-undo"
e2e_e1_move_after_undo_key_a="milestone-e1-move-after-undo-$e2e_run_id"
e2e_e1_move_after_undo_body_a="{\"idempotencyKey\":\"$e2e_e1_move_after_undo_key_a\",\"source\":{\"noteId\":\"$e2e_e1_source_a\",\"expectedRevision\":3},\"destination\":{\"type\":\"existing_note\",\"noteId\":\"$e2e_e1_destination_a\",\"expectedRevision\":3}}"
e2e_e1_move_after_undo_status_a="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_move_after_undo_key_a" \
    --data "$e2e_e1_move_after_undo_body_a" \
    --dump-header "$e2e_tmp_dir/e1-move-after-undo.headers" \
    --output "$e2e_tmp_dir/e1-move-after-undo.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/decisions/$e2e_e1_decision_a/correct"
})"
assert_e1_json_status \
  200 "$e2e_e1_move_after_undo_status_a" "$e2e_tmp_dir/e1-move-after-undo.json"
assert_private_response_headers "$e2e_tmp_dir/e1-move-after-undo.headers"
E2E_SOURCE_ID="$e2e_e1_source_a" E2E_DESTINATION_ID="$e2e_e1_destination_a" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.outcome !== "applied" || value.replayed !== false) process.exit(1);
  if (value.source?.noteId !== process.env.E2E_SOURCE_ID || value.source.currentRevision !== 4) {
    process.exit(1);
  }
  if (value.destination?.noteId !== process.env.E2E_DESTINATION_ID) process.exit(1);
  if (value.destination.currentRevision !== 4) process.exit(1);
' "$e2e_tmp_dir/e1-move-after-undo.json"

e2e_stage="e1-a-method-guards"
assert_e1_post_only \
  correction "/decisions/$e2e_e1_decision_a/correct"
assert_e1_post_only \
  batch-undo "/mutation-batches/$e2e_e1_destination_correction_mutation_a/undo"

# An edit after the correction invalidates one member's exact inverse. Batch
# Undo must make no partial writes, persist a revision-conflict Review, and let
# the owner resolve that Review while keeping the capture in the inbox.
e2e_stage="e1-b-fixture"
e2e_e1_sensitive_title_b="E1 conflict title $e2e_run_id"
e2e_e1_sensitive_body_b="E1 conflict body $e2e_run_id"
e2e_e1_destination_title_b="E1 conflict destination $e2e_run_id"
read -r e2e_e1_source_b e2e_e1_source_create_mutation_b \
  e2e_e1_destination_b e2e_e1_capture_b e2e_e1_job_b e2e_e1_decision_b < <(
  setup_e1_interaction_fixture \
    conflict "$e2e_e1_sensitive_title_b" "$e2e_e1_sensitive_body_b" \
    "$e2e_e1_destination_title_b"
)
[[ "$e2e_e1_source_create_mutation_b" =~ ^mut_[0-9A-HJKMNP-TV-Z]{26}$ ]]
read -r e2e_e1_source_correction_mutation_b e2e_e1_destination_correction_mutation_b < <(
  correct_e1_fixture_decision \
    conflict "$e2e_e1_decision_b" "$e2e_e1_source_b" "$e2e_e1_destination_b"
)
[[ "$e2e_e1_source_correction_mutation_b" =~ ^mut_[0-9A-HJKMNP-TV-Z]{26}$ ]]

e2e_stage="e1-b-later-edit"
e2e_e1_later_title_b="E1 conflict later edit $e2e_run_id"
e2e_e1_later_key_b="milestone-e1-conflict-later-edit-$e2e_run_id"
e2e_encrypted_request_json PATCH "/notes/$e2e_e1_destination_b" \
  "{\"expectedRevision\":2,\"idempotencyKey\":\"$e2e_e1_later_key_b\",\"title\":\"$e2e_e1_later_title_b\"}" \
  "$e2e_e1_later_key_b" | E2E_EXPECTED_TITLE="$e2e_e1_later_title_b" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 3 || value.note?.title !== process.env.E2E_EXPECTED_TITLE) {
        process.exit(1);
      }
    });
  '

e2e_stage="e1-b-conflict-undo"
e2e_e1_conflict_undo_key_b="milestone-e1-conflict-batch-undo-$e2e_run_id"
e2e_e1_conflict_undo_body_b="{\"expectedRevision\":3,\"idempotencyKey\":\"$e2e_e1_conflict_undo_key_b\"}"
e2e_e1_conflict_undo_status_b="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_conflict_undo_key_b" \
    --data "$e2e_e1_conflict_undo_body_b" \
    --dump-header "$e2e_tmp_dir/e1-conflict-batch-undo.headers" \
    --output "$e2e_tmp_dir/e1-conflict-batch-undo.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_destination_correction_mutation_b/undo"
})"
assert_e1_json_status \
  409 "$e2e_e1_conflict_undo_status_b" "$e2e_tmp_dir/e1-conflict-batch-undo.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-batch-undo.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "conflict_requires_review") process.exit(1);
' "$e2e_tmp_dir/e1-conflict-batch-undo.json"

e2e_e1_conflict_replay_status_b="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_conflict_undo_key_b" \
    --data "$e2e_e1_conflict_undo_body_b" \
    --dump-header "$e2e_tmp_dir/e1-conflict-batch-replay.headers" \
    --output "$e2e_tmp_dir/e1-conflict-batch-replay.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_destination_correction_mutation_b/undo"
})"
assert_e1_json_status \
  409 "$e2e_e1_conflict_replay_status_b" "$e2e_tmp_dir/e1-conflict-batch-replay.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-batch-replay.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "conflict_requires_review") process.exit(1);
' "$e2e_tmp_dir/e1-conflict-batch-replay.json"

e2e_e1_conflict_mismatch_status_b="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_conflict_undo_key_b" \
    --data "{\"expectedRevision\":4,\"idempotencyKey\":\"$e2e_e1_conflict_undo_key_b\"}" \
    --dump-header "$e2e_tmp_dir/e1-conflict-batch-mismatch.headers" \
    --output "$e2e_tmp_dir/e1-conflict-batch-mismatch.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/mutation-batches/$e2e_e1_destination_correction_mutation_b/undo"
})"
assert_e1_json_status \
  409 "$e2e_e1_conflict_mismatch_status_b" "$e2e_tmp_dir/e1-conflict-batch-mismatch.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-batch-mismatch.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "invalid_idempotency_key") process.exit(1);
' "$e2e_tmp_dir/e1-conflict-batch-mismatch.json"

e2e_stage="e1-b-receipt-list"
e2e_e1_conflict_receipt_status_b="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-conflict-receipt.headers" \
    --output "$e2e_tmp_dir/e1-conflict-receipt.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_e1_capture_b/receipt"
})"
assert_e1_json_status \
  200 "$e2e_e1_conflict_receipt_status_b" "$e2e_tmp_dir/e1-conflict-receipt.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-receipt.headers"
e2e_e1_review_b="$({
  E2E_CAPTURE_ID="$e2e_e1_capture_b" E2E_JOB_ID="$e2e_e1_job_b" node -e '
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const receipt = value.receipt;
      if (receipt?.captureId !== process.env.E2E_CAPTURE_ID) process.exit(1);
      if (receipt.jobId !== process.env.E2E_JOB_ID || receipt.decisionId !== null) {
        process.exit(1);
      }
      if (receipt.outcome !== "needs_review" || !/^rvw_[0-9A-HJKMNP-TV-Z]{26}$/u.test(receipt.reviewItemId)) {
        process.exit(1);
      }
      if (receipt.destination !== null || receipt.mutationId !== null) process.exit(1);
      if (receipt.insertedContent?.length !== 0 || receipt.actions?.length !== 0) process.exit(1);
      if (JSON.stringify(receipt.reasonCodes) !== JSON.stringify(["conflict_requires_review"])) {
        process.exit(1);
      }
      process.stdout.write(receipt.reviewItemId);
    ' "$e2e_tmp_dir/e1-conflict-receipt.json"
})"

e2e_e1_review_list_status_b="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-conflict-review-list.headers" \
    --output "$e2e_tmp_dir/e1-conflict-review-list.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items?state=open&limit=30"
})"
assert_e1_json_status \
  200 "$e2e_e1_review_list_status_b" "$e2e_tmp_dir/e1-conflict-review-list.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-review-list.headers"
E2E_REVIEW_ID="$e2e_e1_review_b" E2E_CAPTURE_ID="$e2e_e1_capture_b" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const item = value.items?.find(({ id }) => id === process.env.E2E_REVIEW_ID);
  if (item?.captureId !== process.env.E2E_CAPTURE_ID || item.state !== "open") process.exit(1);
  if (item.type !== "revision_conflict" || item.proposal?.type !== "conflict") process.exit(1);
  if (item.proposal.reason !== "revision" || item.resolution !== null) process.exit(1);
' "$e2e_tmp_dir/e1-conflict-review-list.json"

e2e_stage="e1-b-resolve"
e2e_e1_review_resolve_key_b="milestone-e1-conflict-review-resolve-$e2e_run_id"
e2e_e1_review_resolve_body_b="{\"idempotencyKey\":\"$e2e_e1_review_resolve_key_b\",\"resolution\":{\"type\":\"keep_inbox\"}}"
e2e_e1_review_resolve_status_b="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_review_resolve_key_b" \
    --data "$e2e_e1_review_resolve_body_b" \
    --dump-header "$e2e_tmp_dir/e1-conflict-review-resolve.headers" \
    --output "$e2e_tmp_dir/e1-conflict-review-resolve.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items/$e2e_e1_review_b/resolve"
})"
assert_e1_json_status \
  200 "$e2e_e1_review_resolve_status_b" "$e2e_tmp_dir/e1-conflict-review-resolve.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-review-resolve.headers"
E2E_REVIEW_ID="$e2e_e1_review_b" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== false || value.reviewItem?.id !== process.env.E2E_REVIEW_ID) process.exit(1);
  if (value.reviewItem.state !== "resolved" || value.reviewItem.resolution?.type !== "keep_inbox") {
    process.exit(1);
  }
  if (typeof value.reviewItem.resolvedAt !== "string") process.exit(1);
' "$e2e_tmp_dir/e1-conflict-review-resolve.json"

e2e_e1_review_replay_status_b="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_review_resolve_key_b" \
    --data "$e2e_e1_review_resolve_body_b" \
    --dump-header "$e2e_tmp_dir/e1-conflict-review-replay.headers" \
    --output "$e2e_tmp_dir/e1-conflict-review-replay.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items/$e2e_e1_review_b/resolve"
})"
assert_e1_json_status \
  200 "$e2e_e1_review_replay_status_b" "$e2e_tmp_dir/e1-conflict-review-replay.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-review-replay.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.reviewItem?.state !== "resolved") process.exit(1);
' "$e2e_tmp_dir/e1-conflict-review-replay.json"

e2e_e1_review_mismatch_status_b="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_review_resolve_key_b" \
    --data "{\"idempotencyKey\":\"$e2e_e1_review_resolve_key_b\",\"resolution\":{\"type\":\"dismiss\"}}" \
    --dump-header "$e2e_tmp_dir/e1-conflict-review-mismatch.headers" \
    --output "$e2e_tmp_dir/e1-conflict-review-mismatch.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items/$e2e_e1_review_b/resolve"
})"
assert_e1_json_status \
  409 "$e2e_e1_review_mismatch_status_b" "$e2e_tmp_dir/e1-conflict-review-mismatch.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-review-mismatch.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.code !== "invalid_idempotency_key") process.exit(1);
' "$e2e_tmp_dir/e1-conflict-review-mismatch.json"

e2e_e1_resolved_receipt_status_b="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-conflict-resolved-receipt.headers" \
    --output "$e2e_tmp_dir/e1-conflict-resolved-receipt.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_e1_capture_b/receipt"
})"
assert_e1_json_status \
  200 "$e2e_e1_resolved_receipt_status_b" "$e2e_tmp_dir/e1-conflict-resolved-receipt.json"
assert_private_response_headers "$e2e_tmp_dir/e1-conflict-resolved-receipt.headers"
E2E_REVIEW_ID="$e2e_e1_review_b" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const receipt = value.receipt;
  if (receipt?.outcome !== "kept_in_inbox" || receipt.reviewItemId !== process.env.E2E_REVIEW_ID) {
    process.exit(1);
  }
  if (receipt.destination !== null || receipt.mutationId !== null) process.exit(1);
  if (receipt.insertedContent?.length !== 0 || receipt.actions?.length !== 0) process.exit(1);
  if (JSON.stringify(receipt.reasonCodes) !== JSON.stringify(["review_resolved"])) process.exit(1);
' "$e2e_tmp_dir/e1-conflict-resolved-receipt.json"

e2e_encrypted_request_json GET "/notes/$e2e_e1_destination_b" | \
  E2E_EXPECTED_TITLE="$e2e_e1_later_title_b" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 3 || value.note?.title !== process.env.E2E_EXPECTED_TITLE) {
        process.exit(1);
      }
    });
  '
assert_e1_post_only review-resolve "/review-items/$e2e_e1_review_b/resolve"

# A source edit before correction makes the organizer mutation's inverse
# inexact. Correction must create Review instead of guessing, and dismissing
# that Review must be a real encrypted resolution rather than a UI-only state.
e2e_stage="e1-c-fixture-source-edit"
e2e_e1_sensitive_title_c="E1 correction review title $e2e_run_id"
e2e_e1_sensitive_body_c="E1 correction review body $e2e_run_id"
e2e_e1_destination_title_c="E1 correction review destination $e2e_run_id"
read -r e2e_e1_source_c e2e_e1_source_create_mutation_c \
  e2e_e1_destination_c e2e_e1_capture_c e2e_e1_job_c e2e_e1_decision_c < <(
  setup_e1_interaction_fixture \
    correction-review "$e2e_e1_sensitive_title_c" "$e2e_e1_sensitive_body_c" \
    "$e2e_e1_destination_title_c"
)
[[ "$e2e_e1_source_create_mutation_c" =~ ^mut_[0-9A-HJKMNP-TV-Z]{26}$ ]]

e2e_e1_source_later_title_c="E1 correction source later edit $e2e_run_id"
e2e_e1_source_later_key_c="milestone-e1-correction-source-edit-$e2e_run_id"
e2e_encrypted_request_json PATCH "/notes/$e2e_e1_source_c" \
  "{\"expectedRevision\":1,\"idempotencyKey\":\"$e2e_e1_source_later_key_c\",\"title\":\"$e2e_e1_source_later_title_c\"}" \
  "$e2e_e1_source_later_key_c" | E2E_EXPECTED_TITLE="$e2e_e1_source_later_title_c" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || value.note?.title !== process.env.E2E_EXPECTED_TITLE) {
        process.exit(1);
      }
    });
  '

e2e_stage="e1-c-correction-review"
e2e_e1_correction_review_key_c="milestone-e1-correction-needs-review-$e2e_run_id"
e2e_e1_correction_review_body_c="{\"idempotencyKey\":\"$e2e_e1_correction_review_key_c\",\"source\":{\"noteId\":\"$e2e_e1_source_c\",\"expectedRevision\":2},\"destination\":{\"type\":\"existing_note\",\"noteId\":\"$e2e_e1_destination_c\",\"expectedRevision\":1}}"
e2e_e1_correction_review_status_c="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_correction_review_key_c" \
    --data "$e2e_e1_correction_review_body_c" \
    --dump-header "$e2e_tmp_dir/e1-correction-needs-review.headers" \
    --output "$e2e_tmp_dir/e1-correction-needs-review.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/decisions/$e2e_e1_decision_c/correct"
})"
assert_e1_json_status \
  200 "$e2e_e1_correction_review_status_c" "$e2e_tmp_dir/e1-correction-needs-review.json"
assert_private_response_headers "$e2e_tmp_dir/e1-correction-needs-review.headers"
e2e_e1_review_c="$({
  E2E_DECISION_ID="$e2e_e1_decision_c" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (value.outcome !== "needs_review" || value.decisionId !== process.env.E2E_DECISION_ID) {
      process.exit(1);
    }
    if (value.reasonCode !== "exact_inverse_unavailable" || value.replayed !== false) process.exit(1);
    if (!/^rvw_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.reviewItemId)) process.exit(1);
    process.stdout.write(value.reviewItemId);
  ' "$e2e_tmp_dir/e1-correction-needs-review.json"
})"

e2e_e1_correction_review_replay_status_c="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_correction_review_key_c" \
    --data "$e2e_e1_correction_review_body_c" \
    --dump-header "$e2e_tmp_dir/e1-correction-needs-review-replay.headers" \
    --output "$e2e_tmp_dir/e1-correction-needs-review-replay.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/decisions/$e2e_e1_decision_c/correct"
})"
assert_e1_json_status \
  200 "$e2e_e1_correction_review_replay_status_c" \
  "$e2e_tmp_dir/e1-correction-needs-review-replay.json"
assert_private_response_headers "$e2e_tmp_dir/e1-correction-needs-review-replay.headers"
E2E_REVIEW_ID="$e2e_e1_review_c" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.outcome !== "needs_review" || value.reviewItemId !== process.env.E2E_REVIEW_ID) {
    process.exit(1);
  }
  if (value.replayed !== true) process.exit(1);
' "$e2e_tmp_dir/e1-correction-needs-review-replay.json"

e2e_e1_correction_receipt_status_c="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-correction-review-receipt.headers" \
    --output "$e2e_tmp_dir/e1-correction-review-receipt.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_e1_capture_c/receipt"
})"
assert_e1_json_status \
  200 "$e2e_e1_correction_receipt_status_c" "$e2e_tmp_dir/e1-correction-review-receipt.json"
assert_private_response_headers "$e2e_tmp_dir/e1-correction-review-receipt.headers"
E2E_CAPTURE_ID="$e2e_e1_capture_c" E2E_JOB_ID="$e2e_e1_job_c" \
  E2E_REVIEW_ID="$e2e_e1_review_c" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const receipt = value.receipt;
    if (receipt?.captureId !== process.env.E2E_CAPTURE_ID || receipt.jobId !== process.env.E2E_JOB_ID) {
      process.exit(1);
    }
    if (receipt.outcome !== "needs_review" || receipt.reviewItemId !== process.env.E2E_REVIEW_ID) {
      process.exit(1);
    }
    if (receipt.destination !== null || receipt.mutationId !== null) process.exit(1);
    if (receipt.insertedContent?.length !== 0 || receipt.actions?.length !== 0) process.exit(1);
    if (JSON.stringify(receipt.reasonCodes) !== JSON.stringify(["exact_inverse_unavailable"])) {
      process.exit(1);
    }
  ' "$e2e_tmp_dir/e1-correction-review-receipt.json"

e2e_stage="e1-c-dismiss-note-state"
e2e_e1_dismiss_key_c="milestone-e1-correction-review-dismiss-$e2e_run_id"
e2e_e1_dismiss_status_c="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_dismiss_key_c" \
    --data "{\"idempotencyKey\":\"$e2e_e1_dismiss_key_c\",\"resolution\":{\"type\":\"dismiss\"}}" \
    --dump-header "$e2e_tmp_dir/e1-correction-review-dismiss.headers" \
    --output "$e2e_tmp_dir/e1-correction-review-dismiss.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items/$e2e_e1_review_c/resolve"
})"
assert_e1_json_status \
  200 "$e2e_e1_dismiss_status_c" "$e2e_tmp_dir/e1-correction-review-dismiss.json"
assert_private_response_headers "$e2e_tmp_dir/e1-correction-review-dismiss.headers"
E2E_REVIEW_ID="$e2e_e1_review_c" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== false || value.reviewItem?.id !== process.env.E2E_REVIEW_ID) process.exit(1);
  if (value.reviewItem.state !== "dismissed" || value.reviewItem.resolution?.type !== "dismiss") {
    process.exit(1);
  }
  if (typeof value.reviewItem.resolvedAt !== "string") process.exit(1);
' "$e2e_tmp_dir/e1-correction-review-dismiss.json"

e2e_encrypted_request_json GET "/notes/$e2e_e1_source_c" | \
  E2E_EXPECTED_TITLE="$e2e_e1_source_later_title_c" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || value.note?.title !== process.env.E2E_EXPECTED_TITLE) {
        process.exit(1);
      }
    });
  '
e2e_encrypted_request_json GET "/notes/$e2e_e1_destination_c" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.currentRevision !== 1 || value.note?.bodyMarkdown !== "Fixture destination body") {
      process.exit(1);
    }
  });
'

# Editing the routed source before a mixed-class correction makes its original
# inverse inexact. The decision-bound correction Review must be private-sticky
# because its proposed destination is private. Resolving that Review into a
# fresh AI note must retain private request/Review/response history while the
# capture-local receipt and every destination note artifact stay on their own
# AI key class. This proves aggregate secrecy without routing a batch-Undo
# conflict Review, whose only valid resolutions are keep_inbox and dismiss.
e2e_stage="e1-d-fixture-source-edit"
e2e_e1_sensitive_title_d="E1 mixed source title $e2e_run_id"
e2e_e1_sensitive_body_d="E1 mixed source body $e2e_run_id"
e2e_e1_private_destination_title_d="E1 mixed private destination $e2e_run_id"
read -r e2e_e1_source_d e2e_e1_source_create_mutation_d \
  e2e_e1_private_destination_d e2e_e1_capture_d e2e_e1_job_d e2e_e1_decision_d < <(
  setup_e1_interaction_fixture \
    mixed-class "$e2e_e1_sensitive_title_d" "$e2e_e1_sensitive_body_d" \
    "$e2e_e1_private_destination_title_d" private_manual
)
[[ "$e2e_e1_source_create_mutation_d" =~ ^mut_[0-9A-HJKMNP-TV-Z]{26}$ ]]

e2e_e1_source_later_title_d="E1 mixed source later edit $e2e_run_id"
e2e_e1_source_later_key_d="milestone-e1-mixed-source-edit-$e2e_run_id"
e2e_encrypted_request_json PATCH "/notes/$e2e_e1_source_d" \
  "{\"expectedRevision\":1,\"idempotencyKey\":\"$e2e_e1_source_later_key_d\",\"title\":\"$e2e_e1_source_later_title_d\"}" \
  "$e2e_e1_source_later_key_d" | \
  E2E_EXPECTED_TITLE="$e2e_e1_source_later_title_d" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || value.note?.title !== process.env.E2E_EXPECTED_TITLE) {
        process.exit(1);
      }
      if (value.note.privacy !== "ai_assisted") process.exit(1);
    });
  '

e2e_stage="e1-d-correction-review"
e2e_e1_mixed_correction_key_d="milestone-e1-mixed-class-correction-$e2e_run_id"
e2e_e1_mixed_correction_body_d="{\"idempotencyKey\":\"$e2e_e1_mixed_correction_key_d\",\"source\":{\"noteId\":\"$e2e_e1_source_d\",\"expectedRevision\":2},\"destination\":{\"type\":\"existing_note\",\"noteId\":\"$e2e_e1_private_destination_d\",\"expectedRevision\":1}}"
e2e_e1_mixed_correction_status_d="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_mixed_correction_key_d" \
    --data "$e2e_e1_mixed_correction_body_d" \
    --dump-header "$e2e_tmp_dir/e1-mixed-correction-needs-review.headers" \
    --output "$e2e_tmp_dir/e1-mixed-correction-needs-review.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/decisions/$e2e_e1_decision_d/correct"
})"
assert_e1_json_status \
  200 "$e2e_e1_mixed_correction_status_d" "$e2e_tmp_dir/e1-mixed-correction-needs-review.json"
assert_private_response_headers "$e2e_tmp_dir/e1-mixed-correction-needs-review.headers"
e2e_e1_review_d="$({
  E2E_DECISION_ID="$e2e_e1_decision_d" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (value.outcome !== "needs_review" || value.decisionId !== process.env.E2E_DECISION_ID) {
      process.exit(1);
    }
    if (value.reasonCode !== "exact_inverse_unavailable" || value.replayed !== false) {
      process.exit(1);
    }
    if (!/^rvw_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.reviewItemId)) process.exit(1);
    process.stdout.write(value.reviewItemId);
  ' "$e2e_tmp_dir/e1-mixed-correction-needs-review.json"
})"

e2e_e1_mixed_receipt_status_d="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-mixed-review-receipt.headers" \
    --output "$e2e_tmp_dir/e1-mixed-review-receipt.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_e1_capture_d/receipt"
})"
assert_e1_json_status \
  200 "$e2e_e1_mixed_receipt_status_d" "$e2e_tmp_dir/e1-mixed-review-receipt.json"
assert_private_response_headers "$e2e_tmp_dir/e1-mixed-review-receipt.headers"
E2E_CAPTURE_ID="$e2e_e1_capture_d" E2E_JOB_ID="$e2e_e1_job_d" \
  E2E_DECISION_ID="$e2e_e1_decision_d" E2E_REVIEW_ID="$e2e_e1_review_d" node -e '
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const receipt = value.receipt;
      if (receipt?.captureId !== process.env.E2E_CAPTURE_ID) process.exit(1);
      if (receipt.jobId !== process.env.E2E_JOB_ID || receipt.decisionId !== process.env.E2E_DECISION_ID) {
        process.exit(1);
      }
      if (receipt.outcome !== "needs_review" || receipt.reviewItemId !== process.env.E2E_REVIEW_ID) {
        process.exit(1);
      }
      if (receipt.destination !== null || receipt.mutationId !== null) process.exit(1);
      if (receipt.insertedContent?.length !== 0 || receipt.actions?.length !== 0) process.exit(1);
      if (JSON.stringify(receipt.reasonCodes) !== JSON.stringify(["exact_inverse_unavailable"])) {
        process.exit(1);
      }
    ' "$e2e_tmp_dir/e1-mixed-review-receipt.json"

e2e_e1_mixed_review_list_status_d="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-mixed-review-list.headers" \
    --output "$e2e_tmp_dir/e1-mixed-review-list.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items?state=open&limit=30"
})"
assert_e1_json_status \
  200 "$e2e_e1_mixed_review_list_status_d" "$e2e_tmp_dir/e1-mixed-review-list.json"
assert_private_response_headers "$e2e_tmp_dir/e1-mixed-review-list.headers"
E2E_REVIEW_ID="$e2e_e1_review_d" E2E_CAPTURE_ID="$e2e_e1_capture_d" \
  E2E_SOURCE_ID="$e2e_e1_source_d" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const item = value.items?.find(({ id }) => id === process.env.E2E_REVIEW_ID);
  if (item?.captureId !== process.env.E2E_CAPTURE_ID || item.state !== "open") process.exit(1);
  if (item.noteId !== process.env.E2E_SOURCE_ID) process.exit(1);
  if (item.type !== "revision_conflict" || item.proposal?.type !== "conflict") process.exit(1);
  if (item.proposal.reason !== "revision" || item.resolution !== null) process.exit(1);
' "$e2e_tmp_dir/e1-mixed-review-list.json"

e2e_stage="e1-d-target-create"
e2e_e1_ai_target_title_d="E1 mixed AI route target $e2e_run_id"
e2e_e1_ai_target_body_d="E1 mixed AI target base $e2e_run_id"
e2e_e1_ai_target_key_d="milestone-e1-mixed-ai-target-$e2e_run_id"
e2e_e1_ai_target_response_d="$({
  e2e_encrypted_request_json POST /notes \
    "{\"idempotencyKey\":\"$e2e_e1_ai_target_key_d\",\"title\":\"$e2e_e1_ai_target_title_d\",\"type\":\"generic\",\"bodyMarkdown\":\"$e2e_e1_ai_target_body_d\",\"privacy\":\"ai_assisted\"}" \
    "$e2e_e1_ai_target_key_d"
})"
e2e_e1_ai_target_d="$({
  printf '%s' "$e2e_e1_ai_target_response_d" | \
    E2E_EXPECTED_TITLE="$e2e_e1_ai_target_title_d" node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (value.note?.currentRevision !== 1 || value.note?.title !== process.env.E2E_EXPECTED_TITLE) {
          process.exit(1);
        }
        if (value.note.privacy !== "ai_assisted") process.exit(1);
        process.stdout.write(value.note.id);
      });
    '
})"

e2e_stage="e1-d-route"
e2e_e1_mixed_route_key_d="milestone-e1-mixed-review-route-$e2e_run_id"
e2e_e1_mixed_route_body_d="{\"idempotencyKey\":\"$e2e_e1_mixed_route_key_d\",\"resolution\":{\"type\":\"route\",\"noteId\":\"$e2e_e1_ai_target_d\",\"expectedRevision\":1}}"
e2e_e1_mixed_route_status_d="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_mixed_route_key_d" \
    --data "$e2e_e1_mixed_route_body_d" \
    --dump-header "$e2e_tmp_dir/e1-mixed-review-route.headers" \
    --output "$e2e_tmp_dir/e1-mixed-review-route.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items/$e2e_e1_review_d/resolve"
})"
assert_e1_json_status \
  200 "$e2e_e1_mixed_route_status_d" "$e2e_tmp_dir/e1-mixed-review-route.json"
assert_private_response_headers "$e2e_tmp_dir/e1-mixed-review-route.headers"
E2E_REVIEW_ID="$e2e_e1_review_d" E2E_CAPTURE_ID="$e2e_e1_capture_d" \
  E2E_DESTINATION_ID="$e2e_e1_ai_target_d" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const item = value.reviewItem;
    if (value.replayed !== false || item?.id !== process.env.E2E_REVIEW_ID) process.exit(1);
    if (item.captureId !== process.env.E2E_CAPTURE_ID || item.noteId !== process.env.E2E_DESTINATION_ID) {
      process.exit(1);
    }
    if (item.type !== "revision_conflict" || item.proposal?.reason !== "revision") process.exit(1);
    if (item.state !== "resolved" || item.resolution?.type !== "route") process.exit(1);
    if (item.resolution.noteId !== process.env.E2E_DESTINATION_ID || item.resolution.expectedRevision !== 1) {
      process.exit(1);
    }
    if (typeof item.resolvedAt !== "string") process.exit(1);
  ' "$e2e_tmp_dir/e1-mixed-review-route.json"

e2e_e1_mixed_route_replay_status_d="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "idempotency-key: $e2e_e1_mixed_route_key_d" \
    --data "$e2e_e1_mixed_route_body_d" \
    --dump-header "$e2e_tmp_dir/e1-mixed-review-route-replay.headers" \
    --output "$e2e_tmp_dir/e1-mixed-review-route-replay.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items/$e2e_e1_review_d/resolve"
})"
assert_e1_json_status \
  200 "$e2e_e1_mixed_route_replay_status_d" "$e2e_tmp_dir/e1-mixed-review-route-replay.json"
assert_private_response_headers "$e2e_tmp_dir/e1-mixed-review-route-replay.headers"
E2E_REVIEW_ID="$e2e_e1_review_d" E2E_DESTINATION_ID="$e2e_e1_ai_target_d" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.reviewItem?.id !== process.env.E2E_REVIEW_ID) process.exit(1);
  if (value.reviewItem.noteId !== process.env.E2E_DESTINATION_ID) process.exit(1);
  if (value.reviewItem.resolution?.type !== "route") process.exit(1);
' "$e2e_tmp_dir/e1-mixed-review-route-replay.json"

e2e_e1_mixed_routed_receipt_status_d="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/e1-mixed-routed-receipt.headers" \
    --output "$e2e_tmp_dir/e1-mixed-routed-receipt.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/captures/$e2e_e1_capture_d/receipt"
})"
assert_e1_json_status \
  200 "$e2e_e1_mixed_routed_receipt_status_d" "$e2e_tmp_dir/e1-mixed-routed-receipt.json"
assert_private_response_headers "$e2e_tmp_dir/e1-mixed-routed-receipt.headers"
E2E_CAPTURE_ID="$e2e_e1_capture_d" E2E_DECISION_ID="$e2e_e1_decision_d" \
  E2E_DESTINATION_ID="$e2e_e1_ai_target_d" E2E_CAPTURE_TEXT="$e2e_e1_sensitive_body_d" \
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const receipt = value.receipt;
    if (receipt?.captureId !== process.env.E2E_CAPTURE_ID) process.exit(1);
    if (receipt.decisionId !== process.env.E2E_DECISION_ID || receipt.reviewItemId !== null) {
      process.exit(1);
    }
    if (receipt.outcome !== "added_to_note" || receipt.destination?.noteId !== process.env.E2E_DESTINATION_ID) {
      process.exit(1);
    }
    if (!/^mut_[0-9A-HJKMNP-TV-Z]{26}$/u.test(receipt.mutationId)) process.exit(1);
    if (JSON.stringify(receipt.reasonCodes) !== JSON.stringify(["review_resolved"])) process.exit(1);
    if (receipt.insertedContent?.length !== 1 || receipt.insertedContent[0]?.type !== "captured") {
      process.exit(1);
    }
    if (receipt.insertedContent[0].content !== process.env.E2E_CAPTURE_TEXT) process.exit(1);
    const undo = receipt.actions?.find(({ type }) => type === "undo");
    if (undo?.mutationId !== receipt.mutationId || undo.expectedRevision !== 2) process.exit(1);
  ' "$e2e_tmp_dir/e1-mixed-routed-receipt.json"

e2e_stage="e1-d-note-state"
e2e_encrypted_request_json GET "/notes/$e2e_e1_ai_target_d" | \
  E2E_EXPECTED_TITLE="$e2e_e1_ai_target_title_d" \
  E2E_BASE_BODY="$e2e_e1_ai_target_body_d" \
  E2E_CAPTURE_TEXT="$e2e_e1_sensitive_body_d" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || value.note?.privacy !== "ai_assisted") process.exit(1);
      if (value.note.title !== process.env.E2E_EXPECTED_TITLE) process.exit(1);
      if (!value.note.bodyMarkdown.includes(process.env.E2E_BASE_BODY)) process.exit(1);
      if (!value.note.bodyMarkdown.includes(process.env.E2E_CAPTURE_TEXT)) process.exit(1);
    });
  '

e2e_encrypted_request_json GET "/notes/$e2e_e1_source_d" | \
  E2E_EXPECTED_TITLE="$e2e_e1_source_later_title_d" \
  E2E_EXPECTED_BODY="$e2e_e1_sensitive_body_d" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.note?.currentRevision !== 2 || value.note?.privacy !== "ai_assisted") process.exit(1);
      if (value.note.title !== process.env.E2E_EXPECTED_TITLE) process.exit(1);
      if (value.note.bodyMarkdown !== process.env.E2E_EXPECTED_BODY) process.exit(1);
    });
  '
e2e_encrypted_request_json GET "/notes/$e2e_e1_private_destination_d" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.currentRevision !== 1 || value.note?.privacy !== "private_manual") process.exit(1);
    if (value.note.bodyMarkdown !== "Fixture destination body") process.exit(1);
  });
'

# Read-only local attestation checks both halves of the mixed-class contract.
# Correction and resolution request/Review/response history must be private,
# while the AI capture receipt and routed note artifacts remain AI-class. The
# needs-review correction plan must persist no speculative note writes.
e2e_stage="e1-d-db-attestation"
e2e_e1_mixed_class_attestation_d="$({
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator='|' \
    --set=owner_id="$e2e_encrypted_owner_id" \
    --set=review_id="$e2e_e1_review_d" \
    --set=capture_id="$e2e_e1_capture_d" \
    --set=correction_key="$e2e_e1_mixed_correction_key_d" \
    --set=route_key="$e2e_e1_mixed_route_key_d" \
    --set=source_id="$e2e_e1_source_d" \
    --set=private_destination_id="$e2e_e1_private_destination_d" \
    --set=destination_id="$e2e_e1_ai_target_d" <<'SQL'
      select
        coalesce((select
          claim.history_key_class = 'private_manual'
          and claim.request_mac_key_class = 'private_manual'
          and claim.request_mac_key_id = 'milestone-e1.private.mac.v1'
          and claim.action::text = 'route'
          and claim.destination_note_id = :'destination_id'
          and claim.completed_at is not null
          and exists (
            select 1
            from public.encrypted_owner_interaction_members as member
            where member.user_id = claim.user_id
              and member.idempotency_key = claim.idempotency_key
              and member.role = 'destination_write'
              and member.note_id = claim.destination_note_id
          )
        from public.encrypted_owner_interaction_claims as claim
        where claim.user_id = :'owner_id'::uuid
          and claim.idempotency_key = :'route_key'), false),
        coalesce((select
          scope = 'encrypted_review_resolution'
          and request_mac_key_class = 'private_manual'
          and request_mac_key_id = 'milestone-e1.private.mac.v1'
          and response_key_class = 'private_manual'
          and response_key_id = 'milestone-e1.private.object.v1'
          and response_envelope is not null
          and completed_at is not null
        from public.api_idempotency_records
        where user_id = :'owner_id'::uuid
          and idempotency_key = :'route_key'), false),
        coalesce((select
          review_key_class = 'private_manual'
          and review_key_id = 'milestone-e1.private.object.v1'
          and state::text = 'resolved'
          and note_id = :'destination_id'
          and review_content_revision = 2
        from public.review_items
        where user_id = :'owner_id'::uuid and id = :'review_id'), false),
        coalesce((select
          receipt.receipt_key_class = 'ai_assisted'
          and receipt.receipt_key_id = 'milestone-e1.ai.object.v1'
          and receipt.outcome::text = 'added_to_note'
          and receipt.destination_note_id = :'destination_id'
          and receipt.review_item_id is null
          and receipt.mutation_id = member.mutation_id
        from public.capture_receipts as receipt
        join public.encrypted_owner_interaction_claims as claim
          on claim.user_id = receipt.user_id
          and claim.idempotency_key = :'route_key'
        join public.encrypted_owner_interaction_members as member
          on member.user_id = claim.user_id
          and member.idempotency_key = claim.idempotency_key
          and member.role = 'destination_write'
        where receipt.user_id = :'owner_id'::uuid
          and receipt.capture_id = :'capture_id'
          and receipt.mutation_id = member.mutation_id), false),
        coalesce((select
          note.privacy = 'ai_assisted'
          and note.content_key_class = 'ai_assisted'
          and note.content_key_id = 'milestone-e1.ai.object.v1'
          and note.current_revision = 2
          and revision.note_id = note.id
          and revision.revision = 2
          and revision.snapshot_key_class = 'ai_assisted'
          and revision.snapshot_key_id = 'milestone-e1.ai.object.v1'
          and revision.snapshot_mac_key_class = 'ai_assisted'
          and revision.snapshot_mac_key_id = 'milestone-e1.ai.mac.v1'
          and mutation.note_id = note.id
          and mutation.before_revision = 1
          and mutation.after_revision = 2
          and mutation.mutation_key_class = 'ai_assisted'
          and mutation.mutation_key_id = 'milestone-e1.ai.object.v1'
        from public.encrypted_owner_interaction_claims as claim
        join public.encrypted_owner_interaction_members as member
          on member.user_id = claim.user_id
          and member.idempotency_key = claim.idempotency_key
          and member.role = 'destination_write'
        join public.notes as note on note.user_id = claim.user_id
          and note.id = claim.destination_note_id
        join public.note_revisions as revision on revision.user_id = claim.user_id
          and revision.id = member.revision_id
        join public.note_mutations as mutation on mutation.user_id = claim.user_id
          and mutation.id = member.mutation_id
        where claim.user_id = :'owner_id'::uuid
          and claim.idempotency_key = :'route_key'), false),
        coalesce((select
          exists (select 1 from public.content_encryption_verifications
            where user_id = claim.user_id and surface = 'review_item'
              and resource_id = :'review_id'
              and record_version = 2
              and verification_mac_key_class = 'private_manual'
              and verification_mac_key_id = 'milestone-e1.private.mac.v1')
          and exists (select 1 from public.content_encryption_verifications
            where user_id = claim.user_id and surface = 'capture_receipt'
              and resource_id = :'capture_id'
              and record_version = 3
              and verification_mac_key_class = 'ai_assisted'
              and verification_mac_key_id = 'milestone-e1.ai.mac.v1')
          and exists (select 1 from public.content_encryption_verifications
            where user_id = claim.user_id and surface = 'idempotency_response'
              and resource_id = 'idempotency:' || :'route_key'
              and record_version = 1
              and verification_mac_key_class = 'private_manual'
              and verification_mac_key_id = 'milestone-e1.private.mac.v1')
          and exists (select 1 from public.content_encryption_verifications
            where user_id = claim.user_id and surface = 'note_content'
              and resource_id = :'destination_id' and record_version = 2
              and verification_mac_key_class = 'ai_assisted'
              and verification_mac_key_id = 'milestone-e1.ai.mac.v1')
          and exists (select 1 from public.content_encryption_verifications
            where user_id = claim.user_id and surface = 'note_revision'
              and resource_id = member.revision_id and record_version = 2
              and verification_mac_key_class = 'ai_assisted'
              and verification_mac_key_id = 'milestone-e1.ai.mac.v1')
          and exists (select 1 from public.content_encryption_verifications
            where user_id = claim.user_id and surface = 'note_mutation'
              and resource_id = member.mutation_id and record_version = 2
              and verification_mac_key_class = 'ai_assisted'
              and verification_mac_key_id = 'milestone-e1.ai.mac.v1')
        from public.encrypted_owner_interaction_claims as claim
        join public.encrypted_owner_interaction_members as member
          on member.user_id = claim.user_id
          and member.idempotency_key = claim.idempotency_key
          and member.role = 'destination_write'
        where claim.user_id = :'owner_id'::uuid
          and claim.idempotency_key = :'route_key'), false),
        coalesce((select
          claim.history_key_class = 'private_manual'
          and claim.request_mac_key_class = 'private_manual'
          and claim.request_mac_key_id = 'milestone-e1.private.mac.v1'
          and claim.selected_outcome = 'needs_review'
          and claim.completed_at is not null
          and exists (
            select 1 from public.api_idempotency_records as record
            where record.user_id = claim.user_id
              and record.idempotency_key = claim.idempotency_key
              and record.scope = 'encrypted_decision_correction'
              and record.request_mac_key_class = 'private_manual'
              and record.response_key_class = 'private_manual'
              and record.response_key_id = 'milestone-e1.private.object.v1'
              and record.completed_at is not null
          )
          and exists (
            select 1
            from public.encrypted_owner_interaction_members as member
            where member.user_id = claim.user_id
              and member.idempotency_key = claim.idempotency_key
              and member.role = 'source_removal'
              and member.note_id = :'source_id'
              and member.expected_revision = 2
              and member.source_privacy = 'ai_assisted'
              and member.target_privacy = 'ai_assisted'
              and member.history_key_class = 'ai_assisted'
              and exists (
                select 1 from public.note_mutations as target
                where target.user_id = member.user_id
                  and target.id = member.target_mutation_id
                  and target.undone_at is null
              )
              and not exists (
                select 1 from public.note_revisions as revision
                where revision.user_id = member.user_id
                  and revision.id = member.revision_id
              )
              and not exists (
                select 1 from public.note_mutations as mutation
                where mutation.user_id = member.user_id
                  and mutation.id = member.mutation_id
              )
          )
          and exists (
            select 1
            from public.encrypted_owner_interaction_members as member
            where member.user_id = claim.user_id
              and member.idempotency_key = claim.idempotency_key
              and member.role = 'destination_write'
              and member.note_id = :'private_destination_id'
              and member.expected_revision = 1
              and member.source_privacy = 'private_manual'
              and member.target_privacy = 'private_manual'
              and member.history_key_class = 'private_manual'
              and not exists (
                select 1 from public.note_revisions as revision
                where revision.user_id = member.user_id
                  and revision.id = member.revision_id
              )
              and not exists (
                select 1 from public.note_mutations as mutation
                where mutation.user_id = member.user_id
                  and mutation.id = member.mutation_id
              )
          )
        from public.encrypted_owner_interaction_claims as claim
        where claim.user_id = :'owner_id'::uuid
          and claim.idempotency_key = :'correction_key'), false),
        coalesce((select encrypted_object_count = verified_object_count
          from public.content_encryption_rollouts
          where user_id = :'owner_id'::uuid), false);
SQL
})"
[[ "$e2e_e1_mixed_class_attestation_d" == "t|t|t|t|t|t|t|t" ]]
assert_e1_post_only mixed-review-route \
  "/review-items/$e2e_e1_review_d/resolve"

# Contracted rows may contain ciphertext and bounded operational metadata, but
# never either E1 plaintext canary. Query as the local database administrator
# because the service role intentionally has no relation-level content access.
e2e_stage="e1-plaintext-db-canary"
e2e_e1_plaintext_db_hits="$({
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --set=owner_id="$e2e_encrypted_owner_id" \
    --set=canary_title="$e2e_e1_sensitive_title_a" \
    --set=canary_body="$e2e_e1_sensitive_body_a" \
    --set=destination_a="$e2e_e1_destination_title_a" \
    --set=canary_title_b="$e2e_e1_sensitive_title_b" \
    --set=canary_body_b="$e2e_e1_sensitive_body_b" \
    --set=destination_b="$e2e_e1_destination_title_b" \
    --set=later_title_b="$e2e_e1_later_title_b" \
    --set=canary_title_c="$e2e_e1_sensitive_title_c" \
    --set=canary_body_c="$e2e_e1_sensitive_body_c" \
    --set=destination_c="$e2e_e1_destination_title_c" \
    --set=later_title_c="$e2e_e1_source_later_title_c" \
    --set=mixed_canary_title="$e2e_e1_sensitive_title_d" \
    --set=mixed_later_title="$e2e_e1_source_later_title_d" \
    --set=mixed_canary_body="$e2e_e1_sensitive_body_d" \
    --set=mixed_private_destination="$e2e_e1_private_destination_title_d" \
    --set=mixed_ai_target_title="$e2e_e1_ai_target_title_d" \
    --set=mixed_ai_target_body="$e2e_e1_ai_target_body_d" <<'SQL'
      with serialized(payload) as (
        select to_jsonb(row_value)::text from public.notes as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text from public.note_revisions as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text from public.note_mutations as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text from public.captures as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text from public.organization_decisions as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text from public.capture_receipts as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text from public.review_items as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text from public.api_idempotency_records as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text
          from public.encrypted_owner_interaction_claims as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text
          from public.encrypted_owner_interaction_members as row_value
          where row_value.user_id = :'owner_id'::uuid
        union all select to_jsonb(row_value)::text
          from public.encrypted_mutation_batches as row_value
          where row_value.user_id = :'owner_id'::uuid
      )
      select count(*) from serialized
      where position(:'canary_title' in payload) > 0
         or position(:'canary_body' in payload) > 0
         or position(:'destination_a' in payload) > 0
         or position(:'canary_title_b' in payload) > 0
         or position(:'canary_body_b' in payload) > 0
         or position(:'destination_b' in payload) > 0
         or position(:'later_title_b' in payload) > 0
         or position(:'canary_title_c' in payload) > 0
         or position(:'canary_body_c' in payload) > 0
         or position(:'destination_c' in payload) > 0
         or position(:'later_title_c' in payload) > 0
         or position(:'mixed_canary_title' in payload) > 0
         or position(:'mixed_later_title' in payload) > 0
         or position(:'mixed_canary_body' in payload) > 0
         or position(:'mixed_private_destination' in payload) > 0
         or position(:'mixed_ai_target_title' in payload) > 0
         or position(:'mixed_ai_target_body' in payload) > 0;
SQL
})"
[[ "$e2e_e1_plaintext_db_hits" == "0" ]]
e2e_stage="e1-plaintext-log-canary"
if grep --fixed-strings --quiet "$e2e_e1_sensitive_title_a" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_sensitive_body_a" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_destination_title_a" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_sensitive_title_b" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_sensitive_body_b" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_destination_title_b" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_later_title_b" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_sensitive_title_c" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_sensitive_body_c" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_destination_title_c" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_source_later_title_c" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_sensitive_title_d" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_source_later_title_d" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_sensitive_body_d" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_private_destination_title_d" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_ai_target_title_d" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet "$e2e_e1_ai_target_body_d" "$e2e_tmp_dir/web.log"; then
  echo "E1 note plaintext appeared in the web server log." >&2
  exit 1
fi

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

# The development seed intentionally contains a V1 low-confidence Review row
# whose exact route proposal cannot be reconstructed safely. The API must
# reject that row instead of inventing proposal semantics.
e2e_review_status="$(
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_access_token" \
    --dump-header "$e2e_tmp_dir/review-list.headers" \
    --output "$e2e_tmp_dir/review-list.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/review-items?state=open&limit=30"
)"
[[ "$e2e_review_status" == "503" ]]
node -e '
  const fs = require("node:fs");
  const headers = fs.readFileSync(process.argv[1], "utf8").replaceAll("\r", "");
  const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (!/^cache-control:\s*private, no-store\s*$/imu.test(headers)) process.exit(1);
  if (!/^pragma:\s*no-cache\s*$/imu.test(headers)) process.exit(1);
  if (value.code !== "provider_unavailable") process.exit(1);
' "$e2e_tmp_dir/review-list.headers" "$e2e_tmp_dir/review-list.json"

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

# Delete the synthetic encrypted owner through the Auth admin boundary, then
# prove every public owner-bound row cascaded and the immutable storage
# contract returns to its exact pre-fixture readiness projection. The EXIT
# trap retains this deletion as a fallback for any earlier assertion failure.
e2e_stage="e1-cleanup"
curl --fail --silent --show-error --output /dev/null \
  --request DELETE \
  --header "apikey: $SERVICE_ROLE_KEY" \
  --header "authorization: Bearer $SERVICE_ROLE_KEY" \
  "$e2e_supabase_url/auth/v1/admin/users/$e2e_encrypted_owner_id"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --set=owner_id="$e2e_encrypted_owner_id" <<'SQL' >/dev/null
    select pg_catalog.set_config('unfiled.e1_cleanup_owner', :'owner_id', false);
    do $e1_cleanup$
    declare
      owner_value uuid := pg_catalog.current_setting('unfiled.e1_cleanup_owner')::uuid;
      row_value record;
      remaining_count bigint;
    begin
      select count(*) into remaining_count from auth.users where id = owner_value;
      if remaining_count <> 0 then
        raise exception using message = 'fixture_cleanup_failed';
      end if;
      for row_value in
        select columns.table_name
        from information_schema.columns as columns
        join information_schema.tables as tables
          on tables.table_schema = columns.table_schema
          and tables.table_name = columns.table_name
        where columns.table_schema = 'public'
          and columns.column_name = 'user_id'
          and tables.table_type = 'BASE TABLE'
        order by columns.table_name
      loop
        execute format(
          'select count(*) from public.%I where user_id = $1',
          row_value.table_name
        ) into remaining_count using owner_value;
        if remaining_count <> 0 then
          raise exception using message = 'fixture_cleanup_failed';
        end if;
      end loop;
    end
    $e1_cleanup$;
SQL
e2e_contract_readiness_after="$(service_rpc_json get_encrypted_storage_contract_readiness '{}')"
E2E_READINESS_BEFORE="$e2e_contract_readiness_before" \
  E2E_READINESS_AFTER="$e2e_contract_readiness_after" node -e '
    const { isDeepStrictEqual } = require("node:util");
    const before = JSON.parse(process.env.E2E_READINESS_BEFORE);
    const after = JSON.parse(process.env.E2E_READINESS_AFTER);
    if (!isDeepStrictEqual(after, before)) {
      process.stderr.write("The E1 fixture changed global storage-contract readiness.\n");
      process.exit(1);
    }
'
e2e_encrypted_owner_id=""

request_json POST /auth/sign-out | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (JSON.parse(input).signedOut !== true) process.exit(1);
  });
'

echo "Milestones B–E1 local HTTP E2E passed."
