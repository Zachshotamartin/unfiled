#!/usr/bin/env bash

# This file is sourced by milestone-b-http-e2e.sh after the E4 fixture. It
# intentionally reuses that script's built server, encrypted owner, and local
# custody setup so F is exercised through the same public HTTP boundary.

e2e_stage="f-note-context-link"
e2e_f_link_key="milestone-f-http-link-$e2e_run_id"
e2e_f_link_response="$({
  e2e_encrypted_request_json POST "/notes/$e2e_e1_note_id/links" \
    "{\"expectedRevision\":3,\"idempotencyKey\":\"$e2e_f_link_key\",\"toNoteId\":\"$e2e_e1_destination_a\",\"linkType\":\"related\"}" \
    "$e2e_f_link_key"
})"
printf '%s' "$e2e_f_link_response" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.currentRevision !== 4 || value.replayed !== false) process.exit(1);
  });
'
e2e_encrypted_request_json GET "/notes/$e2e_e1_note_id" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (value.note?.currentRevision !== 4 || value.note?.title !== "Encrypted HTTP gate note") {
      process.stderr.write("F link mutation did not leave a readable revision-four source note.\n");
      process.exit(1);
    }
  });
'

e2e_stage="f-note-context-backlinks"
e2e_f_backlinks_status="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/f-backlinks.headers" \
    --output "$e2e_tmp_dir/f-backlinks.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/notes/$e2e_e1_destination_a/backlinks?limit=100"
})"
assert_e1_json_status 200 "$e2e_f_backlinks_status" "$e2e_tmp_dir/f-backlinks.json"
assert_private_response_headers "$e2e_tmp_dir/f-backlinks.headers"
E2E_SOURCE_NOTE_ID="$e2e_e1_note_id" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const backlink = Array.isArray(value.items)
    ? value.items.find((item) => item.fromNoteId === process.env.E2E_SOURCE_NOTE_ID)
    : undefined;
  const checks = {
    hasItems: Array.isArray(value.items),
    exhausted: value.pageInfo?.hasMore === false && value.pageInfo?.nextCursor === null,
    foundOwnerLink: backlink !== undefined,
    openedCurrentTitle: backlink?.fromTitle === "Encrypted HTTP gate note",
    related: backlink?.linkType === "related",
    linkIdShape: /^lnk_[0-9A-HJKMNP-TV-Z]{26}$/u.test(backlink?.linkId ?? "")
  };
  if (Object.values(checks).some((passed) => !passed)) {
    process.stderr.write(`F backlink assertions failed: ${JSON.stringify({
      checks,
      topLevelType: Array.isArray(value) ? "array" : typeof value,
      topLevelKeys: value && typeof value === "object" ? Object.keys(value).sort() : [],
      pageInfoKeys: value?.pageInfo && typeof value.pageInfo === "object"
        ? Object.keys(value.pageInfo).sort()
        : [],
      itemCount: Array.isArray(value?.items) ? value.items.length : null,
      errorCode: typeof value?.code === "string" ? value.code : null
    })}\n`);
    process.exit(1);
  }
' "$e2e_tmp_dir/f-backlinks.json"

e2e_stage="f-note-context-sources"
e2e_f_sources_status="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/f-sources.headers" \
    --output "$e2e_tmp_dir/f-sources.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/notes/$e2e_e1_destination_a/sources?limit=100"
})"
assert_e1_json_status 200 "$e2e_f_sources_status" "$e2e_tmp_dir/f-sources.json"
assert_private_response_headers "$e2e_tmp_dir/f-sources.headers"
E2E_CAPTURE_ID="$e2e_e1_capture_a" E2E_CAPTURE_CONTENT="$e2e_e1_sensitive_body_a" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(value.items) || value.pageInfo?.hasMore !== false) process.exit(1);
  if (value.pageInfo.nextCursor !== null) process.exit(1);
  const source = value.items.find((item) => item.captureId === process.env.E2E_CAPTURE_ID);
  if (!source || source.rawContent !== process.env.E2E_CAPTURE_CONTENT) process.exit(1);
  if (source.relation !== "routed" || source.source !== "web") process.exit(1);
  if (!Array.isArray(source.insertedItemIds)) process.exit(1);
' "$e2e_tmp_dir/f-sources.json"

# Semantic search is opt-in at the request boundary. This public-web lane leaves
# the isolated search-service origin and identity unconfigured, so an explicit
# AI-assisted query must fail soft to a fresh encrypted lexical scan without
# exposing the query in the URL, cursor, response metadata, or server log. The
# separate test:search-trust-domain gate proves the successful isolated path.
e2e_stage="f-hybrid-search-fallback"
e2e_f_search_canary="encrypted owner body"
e2e_f_search_status="$({
  curl --silent --show-error \
    --request POST \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --header "content-type: application/json" \
    --header "cache-control: no-store" \
    --data "{\"query\":\"$e2e_f_search_canary\",\"archive\":\"exclude\",\"privacy\":\"ai_assisted\",\"limit\":10}" \
    --dump-header "$e2e_tmp_dir/f-search.headers" \
    --output "$e2e_tmp_dir/f-search.json" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/search"
})"
assert_e1_json_status 200 "$e2e_f_search_status" "$e2e_tmp_dir/f-search.json"
assert_private_response_headers "$e2e_tmp_dir/f-search.headers"
E2E_NOTE_ID="$e2e_e1_note_id" E2E_QUERY="$e2e_f_search_canary" node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(value.items) || !value.items.some((item) => item.noteId === process.env.E2E_NOTE_ID)) {
    process.exit(1);
  }
  if (JSON.stringify(value.pageInfo).includes(process.env.E2E_QUERY)) process.exit(1);
' "$e2e_tmp_dir/f-search.json"
if grep --fixed-strings --quiet -- "$e2e_f_search_canary" "$e2e_tmp_dir/web.log"; then
  echo "F hybrid-search plaintext appeared in the web server log." >&2
  exit 1
fi

e2e_stage="f-account-export"
e2e_f_export_status="$({
  curl --silent --show-error \
    --request GET \
    --header "authorization: Bearer $e2e_encrypted_access_token" \
    --dump-header "$e2e_tmp_dir/f-export.headers" \
    --output "$e2e_tmp_dir/f-export.tar.gz" \
    --write-out '%{http_code}' \
    "$e2e_app_url/api/v1/me/export"
})"
assert_e1_json_status 200 "$e2e_f_export_status" "$e2e_tmp_dir/f-export.tar.gz"
assert_private_cache_headers "$e2e_tmp_dir/f-export.headers"
node -e '
  const headers = require("node:fs").readFileSync(process.argv[1], "utf8").replaceAll("\r", "");
  if (!/^content-type:\s*application\/gzip\s*$/imu.test(headers)) process.exit(1);
  if (!/^content-disposition:\s*attachment; filename="unfiled-export-\d{4}-\d{2}-\d{2}\.tar\.gz"\s*$/imu.test(headers)) {
    process.exit(1);
  }
  if (!/^x-content-type-options:\s*nosniff\s*$/imu.test(headers)) process.exit(1);
' "$e2e_tmp_dir/f-export.headers"
mkdir "$e2e_tmp_dir/f-export"
tar -tzf "$e2e_tmp_dir/f-export.tar.gz" >"$e2e_tmp_dir/f-export-files.txt"
node -e '
  const paths = require("node:fs").readFileSync(process.argv[1], "utf8").split(/\r?\n/u).filter(Boolean);
  if (paths.length < 2 || !paths.includes("manifest.json")) process.exit(1);
  if (paths.some((path) => path.startsWith("/") || path.split("/").includes(".."))) process.exit(1);
  if (!paths.some((path) => path.endsWith(".md"))) process.exit(1);
' "$e2e_tmp_dir/f-export-files.txt"
tar -xzf "$e2e_tmp_dir/f-export.tar.gz" -C "$e2e_tmp_dir/f-export"
E2E_EXPORT_DIR="$e2e_tmp_dir/f-export" E2E_NOTE_ID="$e2e_e1_note_id" \
  E2E_DESTINATION_ID="$e2e_e1_destination_a" E2E_CAPTURE_ID="$e2e_e1_capture_a" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const manifest = JSON.parse(fs.readFileSync(path.join(process.env.E2E_EXPORT_DIR, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.notes)) process.exit(1);
  const source = manifest.notes.find((note) => note.id === process.env.E2E_NOTE_ID);
  const destination = manifest.notes.find((note) => note.id === process.env.E2E_DESTINATION_ID);
  if (!source || !destination) process.exit(1);
  if (!source.links.some((link) => link.toNoteId === process.env.E2E_DESTINATION_ID && link.linkType === "related")) {
    process.exit(1);
  }
  if (!destination.sourceCaptureIds.includes(process.env.E2E_CAPTURE_ID)) process.exit(1);
  const markdown = fs.readFileSync(path.join(process.env.E2E_EXPORT_DIR, source.markdownPath), "utf8");
  if (!markdown.startsWith("# Encrypted HTTP gate note\n\n") || !markdown.includes("encrypted owner body")) {
    process.exit(1);
  }
  const serialized = JSON.stringify(manifest);
  if (/wrappedDataKey|ciphertext|contentEnvelope|provider[_-]?key|vault_secret|keyId/iu.test(serialized)) {
    process.exit(1);
  }
'

e2e_f_delete_encrypted_owner() {
  local deletion_token
  local deletion_status
  local replay_status
  deletion_token="delete_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

  deletion_status="$({
    curl --silent --show-error \
      --request DELETE \
      --header "authorization: Bearer $e2e_encrypted_access_token" \
      --header "content-type: application/json" \
      --data "{\"confirmation\":\"DELETE\",\"idempotencyKey\":\"$deletion_token\"}" \
      --dump-header "$e2e_tmp_dir/f-delete.headers" \
      --output "$e2e_tmp_dir/f-delete.json" \
      --write-out '%{http_code}' \
      "$e2e_app_url/api/v1/me"
  })"
  assert_e1_json_status 200 "$deletion_status" "$e2e_tmp_dir/f-delete.json"
  assert_private_response_headers "$e2e_tmp_dir/f-delete.headers"
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (value.schemaVersion !== 1 || value.replayed !== false) process.exit(1);
    if (value.liveDataDeleted !== true || value.sessionsRevoked !== true || value.reRegistrationStartsFresh !== true) {
      process.exit(1);
    }
    if (value.backupRetentionDays !== 30 || value.deletedRecordCounts?.["auth.users"] !== 1) process.exit(1);
    const deletedAt = Date.parse(value.deletedAt);
    const backupExpiresAt = Date.parse(value.backupExpiresAt);
    const receiptExpiresAt = Date.parse(value.receiptExpiresAt);
    if (![deletedAt, backupExpiresAt, receiptExpiresAt].every(Number.isFinite)) process.exit(1);
    if (!(deletedAt < backupExpiresAt && backupExpiresAt < receiptExpiresAt)) process.exit(1);
  ' "$e2e_tmp_dir/f-delete.json"

  replay_status="$({
    curl --silent --show-error \
      --request POST \
      --header "content-type: application/json" \
      --data "{\"idempotencyKey\":\"$deletion_token\"}" \
      --dump-header "$e2e_tmp_dir/f-delete-replay.headers" \
      --output "$e2e_tmp_dir/f-delete-replay.json" \
      --write-out '%{http_code}' \
      "$e2e_app_url/api/v1/me/deletion-receipt"
  })"
  assert_e1_json_status 200 "$replay_status" "$e2e_tmp_dir/f-delete-replay.json"
  assert_private_response_headers "$e2e_tmp_dir/f-delete-replay.headers"
  node -e '
    const fs = require("node:fs");
    const initial = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const replay = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (replay.replayed !== true || initial.replayed !== false) process.exit(1);
    for (const key of ["schemaVersion", "deletedAt", "backupExpiresAt", "receiptExpiresAt", "backupRetentionDays", "liveDataDeleted", "sessionsRevoked", "reRegistrationStartsFresh"]) {
      if (replay[key] !== initial[key]) process.exit(1);
    }
    if (JSON.stringify(replay.deletedRecordCounts) !== JSON.stringify(initial.deletedRecordCounts)) process.exit(1);
  ' "$e2e_tmp_dir/f-delete.json" "$e2e_tmp_dir/f-delete-replay.json"
}
