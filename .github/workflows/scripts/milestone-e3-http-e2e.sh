# shellcheck shell=bash
# This file is sourced by milestone-b-http-e2e.sh after its E2 assertions. It
# intentionally reuses that gate's built server, encrypted owner, local key
# ring, request helpers, private-cache assertions, and cleanup boundary.

e2e_stage="e3-fixture-base"
e2e_e3_destination_body="Fixture destination body"
e2e_e3_accept_title="E3 accept source $e2e_run_id"
e2e_e3_accept_body="E3 accept source body $e2e_run_id"
e2e_e3_accept_destination_title="E3 accept comparison $e2e_run_id"
read -r e2e_e3_accept_note e2e_e3_accept_mutation e2e_e3_accept_destination \
  e2e_e3_accept_capture e2e_e3_accept_job e2e_e3_accept_decision < <(
  setup_e1_interaction_fixture e3-accept \
    "$e2e_e3_accept_title" "$e2e_e3_accept_body" "$e2e_e3_accept_destination_title"
)

e2e_e3_reject_title="E3 reject source $e2e_run_id"
e2e_e3_reject_body="E3 reject source body $e2e_run_id"
e2e_e3_reject_destination_title="E3 reject comparison $e2e_run_id"
read -r e2e_e3_reject_note e2e_e3_reject_mutation e2e_e3_reject_destination \
  e2e_e3_reject_capture e2e_e3_reject_job e2e_e3_reject_decision < <(
  setup_e1_interaction_fixture e3-reject \
    "$e2e_e3_reject_title" "$e2e_e3_reject_body" "$e2e_e3_reject_destination_title"
)

e2e_e3_keep_title="E3 duplicate keep source $e2e_run_id"
e2e_e3_keep_body="E3 duplicate keep source body $e2e_run_id"
e2e_e3_keep_destination_title="E3 duplicate keep comparison $e2e_run_id"
read -r e2e_e3_keep_note e2e_e3_keep_mutation e2e_e3_keep_destination \
  e2e_e3_keep_capture e2e_e3_keep_job e2e_e3_keep_decision < <(
  setup_e1_interaction_fixture e3-duplicate-keep \
    "$e2e_e3_keep_title" "$e2e_e3_keep_body" "$e2e_e3_keep_destination_title"
)

e2e_e3_dismiss_title="E3 duplicate dismiss source $e2e_run_id"
e2e_e3_dismiss_body="E3 duplicate dismiss source body $e2e_run_id"
e2e_e3_dismiss_destination_title="E3 duplicate dismiss comparison $e2e_run_id"
read -r e2e_e3_dismiss_note e2e_e3_dismiss_mutation e2e_e3_dismiss_destination \
  e2e_e3_dismiss_capture e2e_e3_dismiss_job e2e_e3_dismiss_decision < <(
  setup_e1_interaction_fixture e3-duplicate-dismiss \
    "$e2e_e3_dismiss_title" "$e2e_e3_dismiss_body" "$e2e_e3_dismiss_destination_title"
)

e2e_e3_accept_block="$(e2e_new_entity_id blk)"
e2e_e3_reject_block="$(e2e_new_entity_id blk)"
e2e_e3_accept_review="$(e2e_new_entity_id rvw)"
e2e_e3_reject_review="$(e2e_new_entity_id rvw)"
e2e_e3_keep_review="$(e2e_new_entity_id rvw)"
e2e_e3_dismiss_review="$(e2e_new_entity_id rvw)"
e2e_e3_accept_generated="E3 encrypted accepted suggestion $e2e_run_id"
e2e_e3_reject_generated="E3 encrypted rejected suggestion $e2e_run_id"
e2e_e3_keep_explanation="These two encrypted notes may overlap; keep both changes neither note $e2e_run_id."
e2e_e3_dismiss_explanation="These two encrypted notes may overlap; dismiss changes neither note $e2e_run_id."

e2e_e3_fixture_input="$({
  E2E_OWNER_ID="$e2e_encrypted_owner_id" \
  E2E_ACCEPT_BLOCK="$e2e_e3_accept_block" \
  E2E_ACCEPT_CAPTURE="$e2e_e3_accept_capture" \
  E2E_ACCEPT_CONTENT="$e2e_e3_accept_generated" \
  E2E_ACCEPT_DECISION="$e2e_e3_accept_decision" \
  E2E_ACCEPT_NOTE="$e2e_e3_accept_note" \
  E2E_ACCEPT_REVIEW="$e2e_e3_accept_review" \
  E2E_REJECT_BLOCK="$e2e_e3_reject_block" \
  E2E_REJECT_CAPTURE="$e2e_e3_reject_capture" \
  E2E_REJECT_CONTENT="$e2e_e3_reject_generated" \
  E2E_REJECT_DECISION="$e2e_e3_reject_decision" \
  E2E_REJECT_NOTE="$e2e_e3_reject_note" \
  E2E_REJECT_REVIEW="$e2e_e3_reject_review" \
  E2E_KEEP_CAPTURE="$e2e_e3_keep_capture" \
  E2E_KEEP_DECISION="$e2e_e3_keep_decision" \
  E2E_KEEP_EXPLANATION="$e2e_e3_keep_explanation" \
  E2E_KEEP_NOTE_A="$e2e_e3_keep_note" \
  E2E_KEEP_NOTE_B="$e2e_e3_keep_destination" \
  E2E_KEEP_REVIEW="$e2e_e3_keep_review" \
  E2E_DISMISS_CAPTURE="$e2e_e3_dismiss_capture" \
  E2E_DISMISS_DECISION="$e2e_e3_dismiss_decision" \
  E2E_DISMISS_EXPLANATION="$e2e_e3_dismiss_explanation" \
  E2E_DISMISS_NOTE_A="$e2e_e3_dismiss_note" \
  E2E_DISMISS_NOTE_B="$e2e_e3_dismiss_destination" \
  E2E_DISMISS_REVIEW="$e2e_e3_dismiss_review" node -e '
    const env = process.env;
    const generated = (prefix) => ({
      blockId: env[`E2E_${prefix}_BLOCK`],
      captureId: env[`E2E_${prefix}_CAPTURE`],
      content: env[`E2E_${prefix}_CONTENT`],
      decisionId: env[`E2E_${prefix}_DECISION`],
      noteId: env[`E2E_${prefix}_NOTE`],
      reviewId: env[`E2E_${prefix}_REVIEW`]
    });
    const duplicate = (prefix) => ({
      captureId: env[`E2E_${prefix}_CAPTURE`],
      decisionId: env[`E2E_${prefix}_DECISION`],
      explanation: env[`E2E_${prefix}_EXPLANATION`],
      noteIds: [env[`E2E_${prefix}_NOTE_A`], env[`E2E_${prefix}_NOTE_B`]],
      reviewId: env[`E2E_${prefix}_REVIEW`]
    });
    process.stdout.write(JSON.stringify({
      ownerId: env.E2E_OWNER_ID,
      generatedAccept: generated("ACCEPT"),
      generatedReject: generated("REJECT"),
      duplicateKeep: duplicate("KEEP"),
      duplicateDismiss: duplicate("DISMISS")
    }));
  '
})"

e2e_stage="e3-encrypted-fixture"
e2e_e3_fixture_result="$({
  env -u VERCEL -u VERCEL_ENV -u VERCEL_PROJECT_ID \
    NODE_ENV="test" \
    UNFILED_KEY_CUSTODIAN="local" \
    UNFILED_LOCAL_KEY_RING_V1="$e2e_local_key_ring" \
    UNFILED_E3_LOCAL_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    UNFILED_E3_HTTP_FIXTURE_JSON="$e2e_e3_fixture_input" \
    pnpm --filter @unfiled/organizer exec tsx scripts/milestone-e3-http-fixture.ts
})"
E2E_RESULT="$e2e_e3_fixture_result" node -e '
  const value = JSON.parse(process.env.E2E_RESULT);
  if (value.generated !== 2 || value.duplicateReviews !== 2) process.exit(1);
  if (
    typeof value.generatedRejectProvenance?.modelId !== "string" ||
    value.generatedRejectProvenance.modelId.length < 1 ||
    value.generatedRejectProvenance.modelId.length > 120 ||
    typeof value.generatedRejectProvenance?.promptVersion !== "string" ||
    value.generatedRejectProvenance.promptVersion.length < 1 ||
    value.generatedRejectProvenance.promptVersion.length > 120
  ) process.exit(1);
'

e2e_e3_status() {
  local label="$1"
  local method="$2"
  local token="$3"
  local path="$4"
  local body="${5:-}"
  local idempotency_key="${6:-}"
  local arguments=(
    --silent --show-error --request "$method"
    --header "authorization: Bearer $token"
    --dump-header "$e2e_tmp_dir/e3-$label.headers"
    --output "$e2e_tmp_dir/e3-$label.json"
    --write-out '%{http_code}'
  )
  if [[ -n "$body" ]]; then
    arguments+=(--header "content-type: application/json" --data "$body")
  fi
  if [[ -n "$idempotency_key" ]]; then
    arguments+=(--header "idempotency-key: $idempotency_key")
  fi
  curl "${arguments[@]}" "$e2e_app_url/api/v1$path"
}

e2e_e3_assert_success_status() {
  local label="$1"
  local actual_status="$2"
  if [[ "$actual_status" == "200" ]]; then
    return 0
  fi
  local actual_code
  actual_code="$(node -e '
    try {
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(
        typeof value.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value.code)
          ? value.code
          : "invalid_response"
      );
    } catch {
      process.stdout.write("invalid_response");
    }
  ' "$e2e_tmp_dir/e3-$label.json")"
  printf 'E3 %s expected HTTP 200 but received %s/%s.\n' \
    "$label" "$actual_status" "$actual_code" >&2
  return 1
}

e2e_e3_assert_error() {
  local label="$1"
  local expected_status="$2"
  local expected_code="$3"
  local actual_status="$4"
  local actual_code
  actual_code="$(node -e '
    try {
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(
        typeof value.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value.code)
          ? value.code
          : "invalid_response"
      );
    } catch {
      process.stdout.write("invalid_response");
    }
  ' "$e2e_tmp_dir/e3-$label.json")"
  if [[ "$actual_status" != "$expected_status" || "$actual_code" != "$expected_code" ]]; then
    printf 'E3 %s expected HTTP %s/%s but received %s/%s.\n' \
      "$label" "$expected_status" "$expected_code" "$actual_status" "$actual_code" >&2
    return 1
  fi
  assert_private_response_headers "$e2e_tmp_dir/e3-$label.headers"
}

e2e_e3_resolution_state_diagnostic() {
  local idempotency_key="$1"
  local block_id="$2"
  local review_id="$3"
  local capture_id="$4"
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --set=e3_owner="$e2e_encrypted_owner_id" \
    --set=e3_key="$idempotency_key" \
    --set=e3_block="$block_id" \
    --set=e3_review="$review_id" \
    --set=e3_capture="$capture_id" <<'SQL'
select jsonb_build_object(
  'claimCount',(
    select count(*) from public.encrypted_owner_interaction_claims
    where user_id=:'e3_owner'::uuid and idempotency_key=:'e3_key'
  ),
  'completedClaimCount',(
    select count(*) from public.encrypted_owner_interaction_claims
    where user_id=:'e3_owner'::uuid and idempotency_key=:'e3_key' and completed_at is not null
  ),
  'generatedClaimCount',(
    select count(*) from public.encrypted_generated_block_resolution_claims
    where user_id=:'e3_owner'::uuid and idempotency_key=:'e3_key'
  ),
  'blockState',(
    select state::text from public.generated_blocks
    where user_id=:'e3_owner'::uuid and id=:'e3_block'
  ),
  'blockRevision',(
    select state_revision from public.generated_blocks
    where user_id=:'e3_owner'::uuid and id=:'e3_block'
  ),
  'reviewState',(
    select state::text from public.review_items
    where user_id=:'e3_owner'::uuid and id=:'e3_review'
  ),
  'reviewRevision',(
    select review_content_revision from public.review_items
    where user_id=:'e3_owner'::uuid and id=:'e3_review'
  ),
  'receiptRevision',(
    select receipt_revision from public.capture_receipts
    where user_id=:'e3_owner'::uuid and capture_id=:'e3_capture'
  )
);
SQL
}

e2e_stage="e3-generated-list"
e2e_e3_accept_list_status="$(
  e2e_e3_status accept-list GET "$e2e_encrypted_access_token" \
    "/notes/$e2e_e3_accept_note/generated-blocks"
)"
e2e_e3_assert_success_status accept-list "$e2e_e3_accept_list_status"
assert_private_response_headers "$e2e_tmp_dir/e3-accept-list.headers"
E2E_BLOCK_ID="$e2e_e3_accept_block" E2E_NOTE_ID="$e2e_e3_accept_note" \
  E2E_CONTENT="$e2e_e3_accept_generated" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (value.items?.length !== 1) process.exit(1);
    if (value.pageInfo?.hasMore !== false || value.pageInfo.nextCursor !== null) process.exit(1);
    const block = value.items[0];
    if (block.id !== process.env.E2E_BLOCK_ID || block.noteId !== process.env.E2E_NOTE_ID) {
      process.exit(1);
    }
    if (block.content !== process.env.E2E_CONTENT || block.kind !== "suggestion") process.exit(1);
    if (block.state !== "proposed" || block.stateRevision !== 1 || block.resolvedAt !== null) {
      process.exit(1);
    }
  ' "$e2e_tmp_dir/e3-accept-list.json"

e2e_e3_reject_list_status="$(
  e2e_e3_status reject-list GET "$e2e_encrypted_access_token" \
    "/notes/$e2e_e3_reject_note/generated-blocks"
)"
e2e_e3_assert_success_status reject-list "$e2e_e3_reject_list_status"
assert_private_response_headers "$e2e_tmp_dir/e3-reject-list.headers"
E2E_BLOCK_ID="$e2e_e3_reject_block" E2E_CONTENT="$e2e_e3_reject_generated" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.items?.length !== 1 || value.items[0]?.id !== process.env.E2E_BLOCK_ID) process.exit(1);
  if (value.pageInfo?.hasMore !== false || value.pageInfo.nextCursor !== null) process.exit(1);
  if (value.items[0].content !== process.env.E2E_CONTENT || value.items[0].state !== "proposed") {
    process.exit(1);
  }
' "$e2e_tmp_dir/e3-reject-list.json"

e2e_stage="e3-generated-exact"
e2e_e3_reject_exact_status="$(
  e2e_e3_status reject-exact GET "$e2e_encrypted_access_token" \
    "/generated-blocks/$e2e_e3_reject_block"
)"
e2e_e3_assert_success_status reject-exact "$e2e_e3_reject_exact_status"
assert_private_response_headers "$e2e_tmp_dir/e3-reject-exact.headers"
E2E_BLOCK_ID="$e2e_e3_reject_block" \
  E2E_NOTE_ID="$e2e_e3_reject_note" \
  E2E_DECISION_ID="$e2e_e3_reject_decision" \
  E2E_CONTENT="$e2e_e3_reject_generated" \
  E2E_FIXTURE_RESULT="$e2e_e3_fixture_result" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const provenance = JSON.parse(process.env.E2E_FIXTURE_RESULT).generatedRejectProvenance;
    const block = value.block;
    if (
      block?.id !== process.env.E2E_BLOCK_ID ||
      block.noteId !== process.env.E2E_NOTE_ID ||
      block.decisionId !== process.env.E2E_DECISION_ID ||
      block.kind !== "suggestion" ||
      block.content !== process.env.E2E_CONTENT ||
      block.state !== "proposed" ||
      block.stateRevision !== 1 ||
      block.modelId !== provenance.modelId ||
      block.promptVersion !== provenance.promptVersion ||
      typeof block.createdAt !== "string" ||
      block.resolvedAt !== null
    ) process.exit(1);
  ' "$e2e_tmp_dir/e3-reject-exact.json"

# The proposal is a separate aggregate: it is visible from the E3 list but is
# absent from both persisted note content and the note revision counter.
e2e_encrypted_request_json GET "/notes/$e2e_e3_accept_note" | \
  E2E_TITLE="$e2e_e3_accept_title" E2E_BODY="$e2e_e3_accept_body" \
  E2E_GENERATED="$e2e_e3_accept_generated" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const note = JSON.parse(input).note;
      if (note.title !== process.env.E2E_TITLE || note.bodyMarkdown !== process.env.E2E_BODY) {
        process.exit(1);
      }
      if (note.currentRevision !== 1 || input.includes(process.env.E2E_GENERATED)) process.exit(1);
    });
  '

e2e_stage="e3-generated-bypass-denial"
e2e_e3_generic_key="milestone-e3-generic-bypass-$e2e_run_id"
e2e_e3_generic_status="$(
  e2e_e3_status generic-bypass POST "$e2e_encrypted_access_token" \
    "/review-items/$e2e_e3_accept_review/resolve" \
    "{\"idempotencyKey\":\"$e2e_e3_generic_key\",\"resolution\":{\"type\":\"accept_expansion\"}}" \
    "$e2e_e3_generic_key"
)"
e2e_e3_assert_error generic-bypass 400 validation_failed "$e2e_e3_generic_status"

e2e_stage="e3-generated-wrong-owner"
e2e_e3_wrong_owner_status="$(
  e2e_e3_status wrong-owner POST "$e2e_access_token" \
    "/generated-blocks/$e2e_e3_accept_block/resolve" \
    '{"expectedStateRevision":1,"idempotencyKey":"milestone-e3-wrong-owner","resolution":"accept"}' \
    milestone-e3-wrong-owner
)"
# Exact owner-scoped lookup hides the foreign block's existence. The later
# revision-1 accept also proves the foreign request performed no action.
e2e_e3_assert_error wrong-owner 404 not_found "$e2e_e3_wrong_owner_status"

e2e_stage="e3-generated-accept"
e2e_e3_accept_key="milestone-e3-generated-accept-$e2e_run_id"
e2e_e3_accept_body_json="{\"expectedStateRevision\":1,\"idempotencyKey\":\"$e2e_e3_accept_key\",\"resolution\":\"accept\"}"
e2e_e3_accept_status="$(
  e2e_e3_status accept POST "$e2e_encrypted_access_token" \
    "/generated-blocks/$e2e_e3_accept_block/resolve" \
    "$e2e_e3_accept_body_json" "$e2e_e3_accept_key"
)"
if node -e '
  try {
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.exit(typeof value.code === "string" ? 0 : 1);
  } catch {
    process.exit(1);
  }
' "$e2e_tmp_dir/e3-accept.json"; then
  e2e_e3_resolution_state_diagnostic \
    "$e2e_e3_accept_key" "$e2e_e3_accept_block" \
    "$e2e_e3_accept_review" "$e2e_e3_accept_capture" >&2
fi
e2e_e3_assert_success_status accept "$e2e_e3_accept_status"
assert_private_response_headers "$e2e_tmp_dir/e3-accept.headers"
E2E_BLOCK_ID="$e2e_e3_accept_block" E2E_CONTENT="$e2e_e3_accept_generated" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const valid = value.replayed === false && value.block?.id === process.env.E2E_BLOCK_ID &&
    value.block.content === process.env.E2E_CONTENT && value.block.state === "accepted" &&
    value.block.stateRevision === 2 && typeof value.block.resolvedAt === "string";
  if (!valid) {
    const state = typeof value.block?.state === "string" && /^[a-z_]{1,32}$/u.test(value.block.state)
      ? value.block.state
      : "invalid";
    process.stderr.write(JSON.stringify({
      keys: Object.keys(value).sort().filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)),
      valueTypes: Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) ? key : "invalid",
        entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry
      ])),
      errorCode: typeof value.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value.code)
        ? value.code
        : null,
      replayed: value.replayed,
      idMatches: value.block?.id === process.env.E2E_BLOCK_ID,
      contentMatches: value.block?.content === process.env.E2E_CONTENT,
      state,
      stateRevision: Number.isInteger(value.block?.stateRevision) ? value.block.stateRevision : null,
      resolvedAtType: value.block?.resolvedAt === null ? "null" : typeof value.block?.resolvedAt
    }) + "\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e3-accept.json"

e2e_e3_accept_replay_status="$(
  e2e_e3_status accept-replay POST "$e2e_encrypted_access_token" \
    "/generated-blocks/$e2e_e3_accept_block/resolve" \
    "$e2e_e3_accept_body_json" "$e2e_e3_accept_key"
)"
e2e_e3_assert_success_status accept-replay "$e2e_e3_accept_replay_status"
assert_private_response_headers "$e2e_tmp_dir/e3-accept-replay.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.block?.state !== "accepted" || value.block.stateRevision !== 2) {
    process.exit(1);
  }
' "$e2e_tmp_dir/e3-accept-replay.json"

e2e_e3_stale_key="milestone-e3-generated-stale-$e2e_run_id"
e2e_e3_stale_status="$(
  e2e_e3_status stale POST "$e2e_encrypted_access_token" \
    "/generated-blocks/$e2e_e3_accept_block/resolve" \
    "{\"expectedStateRevision\":1,\"idempotencyKey\":\"$e2e_e3_stale_key\",\"resolution\":\"reject\"}" \
    "$e2e_e3_stale_key"
)"
e2e_e3_assert_error stale 409 stale_revision "$e2e_e3_stale_status"

e2e_stage="e3-generated-reject"
e2e_e3_reject_key="milestone-e3-generated-reject-$e2e_run_id"
e2e_e3_reject_body_json="{\"expectedStateRevision\":1,\"idempotencyKey\":\"$e2e_e3_reject_key\",\"resolution\":\"reject\"}"
e2e_e3_reject_status="$(
  e2e_e3_status reject POST "$e2e_encrypted_access_token" \
    "/generated-blocks/$e2e_e3_reject_block/resolve" \
    "$e2e_e3_reject_body_json" "$e2e_e3_reject_key"
)"
e2e_e3_assert_success_status reject "$e2e_e3_reject_status"
assert_private_response_headers "$e2e_tmp_dir/e3-reject.headers"
E2E_BLOCK_ID="$e2e_e3_reject_block" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== false || value.block?.id !== process.env.E2E_BLOCK_ID) process.exit(1);
  if (value.block.state !== "rejected" || value.block.stateRevision !== 2) process.exit(1);
' "$e2e_tmp_dir/e3-reject.json"

e2e_e3_reject_replay_status="$(
  e2e_e3_status reject-replay POST "$e2e_encrypted_access_token" \
    "/generated-blocks/$e2e_e3_reject_block/resolve" \
    "$e2e_e3_reject_body_json" "$e2e_e3_reject_key"
)"
e2e_e3_assert_success_status reject-replay "$e2e_e3_reject_replay_status"
assert_private_response_headers "$e2e_tmp_dir/e3-reject-replay.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.block?.state !== "rejected") process.exit(1);
' "$e2e_tmp_dir/e3-reject-replay.json"

e2e_stage="e3-generated-reject-exact-hidden"
e2e_e3_reject_exact_hidden_status="$(
  e2e_e3_status reject-exact-hidden GET "$e2e_encrypted_access_token" \
    "/generated-blocks/$e2e_e3_reject_block"
)"
e2e_e3_assert_error reject-exact-hidden 404 not_found "$e2e_e3_reject_exact_hidden_status"
if grep --fixed-strings --quiet -- \
  "$e2e_e3_reject_generated" "$e2e_tmp_dir/e3-reject-exact-hidden.json"; then
  echo "Rejected generated plaintext appeared in the exact-read error response." >&2
  exit 1
fi

e2e_stage="e3-generated-reject-hidden"
e2e_e3_reject_hidden_status="$(
  e2e_e3_status reject-hidden GET "$e2e_encrypted_access_token" \
    "/notes/$e2e_e3_reject_note/generated-blocks"
)"
e2e_e3_assert_success_status reject-hidden "$e2e_e3_reject_hidden_status"
assert_private_response_headers "$e2e_tmp_dir/e3-reject-hidden.headers"
E2E_REJECTED_CONTENT="$e2e_e3_reject_generated" node -e '
  const raw = require("node:fs").readFileSync(process.argv[1], "utf8");
  const value = JSON.parse(raw);
  if (!Array.isArray(value.items) || value.items.length !== 0) process.exit(1);
  if (value.pageInfo?.hasMore !== false || value.pageInfo.nextCursor !== null) process.exit(1);
  if (raw.includes(process.env.E2E_REJECTED_CONTENT)) process.exit(1);
' "$e2e_tmp_dir/e3-reject-hidden.json"

e2e_stage="e3-duplicate-list"
e2e_e3_review_list_status="$(
  e2e_e3_status review-list GET "$e2e_encrypted_access_token" "/review-items?state=open&limit=30"
)"
e2e_e3_assert_success_status review-list "$e2e_e3_review_list_status"
assert_private_response_headers "$e2e_tmp_dir/e3-review-list.headers"
E2E_KEEP_ID="$e2e_e3_keep_review" E2E_DISMISS_ID="$e2e_e3_dismiss_review" \
  E2E_KEEP_A="$e2e_e3_keep_note" E2E_KEEP_B="$e2e_e3_keep_destination" \
  E2E_DISMISS_A="$e2e_e3_dismiss_note" E2E_DISMISS_B="$e2e_e3_dismiss_destination" \
  E2E_KEEP_EXPLANATION="$e2e_e3_keep_explanation" \
  E2E_DISMISS_EXPLANATION="$e2e_e3_dismiss_explanation" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const inspect = (id, expectedNotes, explanation) => {
      const item = value.items?.find((candidate) => candidate.id === id);
      if (item?.type !== "duplicate_suggestion" || item.state !== "open") process.exit(1);
      if (item.proposal?.type !== "duplicate_notes" || item.proposal.explanation !== explanation) {
        process.exit(1);
      }
      if (JSON.stringify(item.proposal.notes.map((note) => note.noteId)) !== JSON.stringify(expectedNotes)) {
        process.exit(1);
      }
      if (item.proposal.notes.some((note) => note.revision !== 1)) process.exit(1);
    };
    inspect(process.env.E2E_KEEP_ID, [process.env.E2E_KEEP_A, process.env.E2E_KEEP_B], process.env.E2E_KEEP_EXPLANATION);
    inspect(process.env.E2E_DISMISS_ID, [process.env.E2E_DISMISS_A, process.env.E2E_DISMISS_B], process.env.E2E_DISMISS_EXPLANATION);
  ' "$e2e_tmp_dir/e3-review-list.json"

e2e_stage="e3-duplicate-resolve"
e2e_e3_keep_key="milestone-e3-duplicate-keep-$e2e_run_id"
e2e_e3_keep_body_json="{\"idempotencyKey\":\"$e2e_e3_keep_key\",\"resolution\":{\"type\":\"keep_both\"}}"
e2e_e3_keep_status="$(
  e2e_e3_status duplicate-keep POST "$e2e_encrypted_access_token" \
    "/review-items/$e2e_e3_keep_review/resolve" "$e2e_e3_keep_body_json" "$e2e_e3_keep_key"
)"
e2e_e3_assert_success_status duplicate-keep "$e2e_e3_keep_status"
assert_private_response_headers "$e2e_tmp_dir/e3-duplicate-keep.headers"
E2E_REVIEW_ID="$e2e_e3_keep_review" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== false || value.reviewItem?.id !== process.env.E2E_REVIEW_ID) process.exit(1);
  if (value.reviewItem.state !== "resolved" || value.reviewItem.resolution?.type !== "keep_both") {
    process.exit(1);
  }
' "$e2e_tmp_dir/e3-duplicate-keep.json"

e2e_e3_keep_replay_status="$(
  e2e_e3_status duplicate-keep-replay POST "$e2e_encrypted_access_token" \
    "/review-items/$e2e_e3_keep_review/resolve" "$e2e_e3_keep_body_json" "$e2e_e3_keep_key"
)"
e2e_e3_assert_success_status duplicate-keep-replay "$e2e_e3_keep_replay_status"
assert_private_response_headers "$e2e_tmp_dir/e3-duplicate-keep-replay.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.reviewItem?.resolution?.type !== "keep_both") process.exit(1);
' "$e2e_tmp_dir/e3-duplicate-keep-replay.json"

e2e_e3_dismiss_key="milestone-e3-duplicate-dismiss-$e2e_run_id"
e2e_e3_dismiss_body_json="{\"idempotencyKey\":\"$e2e_e3_dismiss_key\",\"resolution\":{\"type\":\"dismiss\"}}"
e2e_e3_dismiss_status="$(
  e2e_e3_status duplicate-dismiss POST "$e2e_encrypted_access_token" \
    "/review-items/$e2e_e3_dismiss_review/resolve" \
    "$e2e_e3_dismiss_body_json" "$e2e_e3_dismiss_key"
)"
e2e_e3_assert_success_status duplicate-dismiss "$e2e_e3_dismiss_status"
assert_private_response_headers "$e2e_tmp_dir/e3-duplicate-dismiss.headers"
E2E_REVIEW_ID="$e2e_e3_dismiss_review" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== false || value.reviewItem?.id !== process.env.E2E_REVIEW_ID) process.exit(1);
  if (value.reviewItem.state !== "dismissed" || value.reviewItem.resolution?.type !== "dismiss") {
    process.exit(1);
  }
' "$e2e_tmp_dir/e3-duplicate-dismiss.json"

e2e_e3_dismiss_replay_status="$(
  e2e_e3_status duplicate-dismiss-replay POST "$e2e_encrypted_access_token" \
    "/review-items/$e2e_e3_dismiss_review/resolve" \
    "$e2e_e3_dismiss_body_json" "$e2e_e3_dismiss_key"
)"
e2e_e3_assert_success_status duplicate-dismiss-replay "$e2e_e3_dismiss_replay_status"
assert_private_response_headers "$e2e_tmp_dir/e3-duplicate-dismiss-replay.headers"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.reviewItem?.resolution?.type !== "dismiss") process.exit(1);
' "$e2e_tmp_dir/e3-duplicate-dismiss-replay.json"

# All four candidate notes remain byte-for-byte and revision-for-revision
# unchanged across duplicate decisions; the generated decisions likewise do
# not rewrite their target notes.
e2e_stage="e3-non-destructive-proof"
e2e_e3_note_expectations=(
  "$e2e_e3_accept_note|$e2e_e3_accept_title|$e2e_e3_accept_body"
  "$e2e_e3_reject_note|$e2e_e3_reject_title|$e2e_e3_reject_body"
  "$e2e_e3_keep_note|$e2e_e3_keep_title|$e2e_e3_keep_body"
  "$e2e_e3_keep_destination|$e2e_e3_keep_destination_title|$e2e_e3_destination_body"
  "$e2e_e3_dismiss_note|$e2e_e3_dismiss_title|$e2e_e3_dismiss_body"
  "$e2e_e3_dismiss_destination|$e2e_e3_dismiss_destination_title|$e2e_e3_destination_body"
)
for e2e_e3_expectation in "${e2e_e3_note_expectations[@]}"; do
  IFS='|' read -r e2e_e3_note_id e2e_e3_title e2e_e3_body <<<"$e2e_e3_expectation"
  e2e_encrypted_request_json GET "/notes/$e2e_e3_note_id" | \
    E2E_NOTE_ID="$e2e_e3_note_id" E2E_TITLE="$e2e_e3_title" E2E_BODY="$e2e_e3_body" node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const note = JSON.parse(input).note;
        if (note.id !== process.env.E2E_NOTE_ID || note.currentRevision !== 1) process.exit(1);
        if (note.title !== process.env.E2E_TITLE || note.bodyMarkdown !== process.env.E2E_BODY) {
          process.exit(1);
        }
      });
    '
done

psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --set=owner_id="$e2e_encrypted_owner_id" \
  --set=accept_block="$e2e_e3_accept_block" \
  --set=reject_block="$e2e_e3_reject_block" \
  --set=accept_review="$e2e_e3_accept_review" \
  --set=reject_review="$e2e_e3_reject_review" \
  --set=keep_review="$e2e_e3_keep_review" \
  --set=dismiss_review="$e2e_e3_dismiss_review" \
  --set=accept_note="$e2e_e3_accept_note" \
  --set=reject_note="$e2e_e3_reject_note" \
  --set=keep_note="$e2e_e3_keep_note" \
  --set=keep_destination="$e2e_e3_keep_destination" \
  --set=dismiss_note="$e2e_e3_dismiss_note" \
  --set=dismiss_destination="$e2e_e3_dismiss_destination" <<'SQL' >/dev/null
    select pg_catalog.set_config('unfiled.e3_owner', :'owner_id', false);
    select pg_catalog.set_config('unfiled.e3_accept_block', :'accept_block', false);
    select pg_catalog.set_config('unfiled.e3_reject_block', :'reject_block', false);
    select pg_catalog.set_config('unfiled.e3_accept_review', :'accept_review', false);
    select pg_catalog.set_config('unfiled.e3_reject_review', :'reject_review', false);
    select pg_catalog.set_config('unfiled.e3_keep_review', :'keep_review', false);
    select pg_catalog.set_config('unfiled.e3_dismiss_review', :'dismiss_review', false);
    select pg_catalog.set_config('unfiled.e3_accept_note', :'accept_note', false);
    select pg_catalog.set_config('unfiled.e3_reject_note', :'reject_note', false);
    select pg_catalog.set_config('unfiled.e3_keep_note', :'keep_note', false);
    select pg_catalog.set_config('unfiled.e3_keep_destination', :'keep_destination', false);
    select pg_catalog.set_config('unfiled.e3_dismiss_note', :'dismiss_note', false);
    select pg_catalog.set_config('unfiled.e3_dismiss_destination', :'dismiss_destination', false);
    do $e3_http_state$
    declare
      owner_value uuid := pg_catalog.current_setting('unfiled.e3_owner')::uuid;
    begin
      if (select count(*) from public.generated_blocks
          where user_id = owner_value
            and ((id = pg_catalog.current_setting('unfiled.e3_accept_block')
                and state = 'accepted' and state_revision = 2)
              or (id = pg_catalog.current_setting('unfiled.e3_reject_block')
                and state = 'rejected' and state_revision = 2))) <> 2 then
        raise exception using message = 'e3_http_state_failed';
      end if;
      if (select count(*) from public.review_items
          where user_id = owner_value and review_content_revision = 2
            and ((id in (pg_catalog.current_setting('unfiled.e3_accept_review'),
                         pg_catalog.current_setting('unfiled.e3_reject_review'))
                  and state = 'resolved')
              or (id = pg_catalog.current_setting('unfiled.e3_keep_review')
                  and state = 'resolved')
              or (id = pg_catalog.current_setting('unfiled.e3_dismiss_review')
                  and state = 'dismissed'))) <> 4 then
        raise exception using message = 'e3_http_state_failed';
      end if;
      if (select count(*) from public.notes
          where user_id = owner_value and current_revision = 1
            and id in (pg_catalog.current_setting('unfiled.e3_accept_note'),
              pg_catalog.current_setting('unfiled.e3_reject_note'),
              pg_catalog.current_setting('unfiled.e3_keep_note'),
              pg_catalog.current_setting('unfiled.e3_keep_destination'),
              pg_catalog.current_setting('unfiled.e3_dismiss_note'),
              pg_catalog.current_setting('unfiled.e3_dismiss_destination'))) <> 6 then
        raise exception using message = 'e3_http_state_failed';
      end if;
      if not exists (select 1 from public.content_encryption_rollouts
          where user_id = owner_value
            and encrypted_object_count = verified_object_count) then
        raise exception using message = 'e3_http_state_failed';
      end if;
    end
    $e3_http_state$;
SQL

e2e_stage="e3-plaintext-log-canary"
e2e_e3_log_canaries=(
  "$e2e_e3_accept_title"
  "$e2e_e3_accept_body"
  "$e2e_e3_accept_destination_title"
  "$e2e_e3_reject_title"
  "$e2e_e3_reject_body"
  "$e2e_e3_reject_destination_title"
  "$e2e_e3_keep_title"
  "$e2e_e3_keep_body"
  "$e2e_e3_keep_destination_title"
  "$e2e_e3_dismiss_title"
  "$e2e_e3_dismiss_body"
  "$e2e_e3_dismiss_destination_title"
  "$e2e_e3_destination_body"
  "$e2e_e3_accept_generated"
  "$e2e_e3_reject_generated"
  "$e2e_e3_keep_explanation"
  "$e2e_e3_dismiss_explanation"
)
for e2e_e3_canary in "${e2e_e3_log_canaries[@]}"; do
  if grep --fixed-strings --quiet -- "$e2e_e3_canary" "$e2e_tmp_dir/web.log"; then
    echo "E3 generated or duplicate plaintext appeared in the web server log." >&2
    exit 1
  fi
done

unset -f e2e_e3_status e2e_e3_assert_error
