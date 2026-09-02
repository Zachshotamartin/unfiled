# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154
# This file is sourced by milestone-b-http-e2e.sh after E3. It reuses that
# gate's built standalone server, synthetic encrypted owner, local Supabase,
# private-cache assertions, and cleanup boundary.

e2e_e4_status() {
  local label="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  local idempotency_key="${5:-}"
  local arguments=(
    --silent --show-error --request "$method"
    --header "authorization: Bearer $e2e_encrypted_access_token"
    --dump-header "$e2e_tmp_dir/e4-$label.headers"
    --output "$e2e_tmp_dir/e4-$label.json"
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

e2e_e4_assert_response() {
  local label="$1"
  local expected_status="$2"
  local actual_status="$3"
  local expected_code="${4:-}"
  if [[ "$actual_status" != "$expected_status" ]]; then
    printf 'E4 %s expected HTTP %s but received %s.\n' \
      "$label" "$expected_status" "$actual_status" >&2
    # Error envelopes carry only a code, a safe message, and a request ID.
    head -c 400 "$e2e_tmp_dir/e4-$label.json" >&2 2>/dev/null || true
    printf '\n' >&2
    return 1
  fi
  if ! assert_private_response_headers "$e2e_tmp_dir/e4-$label.headers"; then
    printf 'E4 %s did not return the required private no-store JSON headers.\n' \
      "$label" >&2
    return 1
  fi
  if [[ -n "$expected_code" ]]; then
    E2E_EXPECTED_CODE="$expected_code" node -e '
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (value.code !== process.env.E2E_EXPECTED_CODE) {
        process.stderr.write("E4 error-code contract mismatch.\n");
        process.exit(1);
      }
    ' "$e2e_tmp_dir/e4-$label.json"
  fi
}

e2e_e4_worker_query() {
  local statement="$1"
  PGPASSWORD="$e2e_e4_worker_password" psql \
    --host=127.0.0.1 --port=54322 --username=unfiled_organizer_worker \
    --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 \
    --tuples-only --no-align --command="$statement"
}

e2e_stage="e4-settings-get"
e2e_e4_status_code="$(e2e_e4_status settings-get GET /me/settings)"
e2e_e4_assert_response settings-get 200 "$e2e_e4_status_code"
e2e_e4_initial_settings_revision="$({
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const fail = () => {
      process.stderr.write("E4 initial settings contract mismatch.\n");
      process.exit(1);
    };
    const settings = value.settings;
    if (!Number.isInteger(settings?.settingsRevision) || settings.settingsRevision < 1) {
      fail();
    }
    if (
      settings.providerMode !== "app_default" ||
      settings.byokProvider !== null ||
      settings.modelSelection !== "auto" ||
      settings.byokFallbackToApp !== false
    ) fail();
    process.stdout.write(String(settings.settingsRevision));
  ' "$e2e_tmp_dir/e4-settings-get.json"
})"

e2e_stage="e4-settings-cas"
e2e_e4_settings_key="e4-settings-$e2e_run_id"
e2e_e4_settings_body="$({
  E2E_REVISION="$e2e_e4_initial_settings_revision" \
    E2E_KEY="$e2e_e4_settings_key" node -e '
      process.stdout.write(JSON.stringify({
        expectedSettingsRevision: Number(process.env.E2E_REVISION),
        idempotencyKey: process.env.E2E_KEY,
        providerMode: "byok",
        byokProvider: "openai",
        byokFallbackToApp: false,
        routingEffort: "thorough",
        expansionStyle: "detailed"
      }));
    '
})"
e2e_e4_status_code="$(
  e2e_e4_status settings-patch PATCH /me/settings \
    "$e2e_e4_settings_body" "$e2e_e4_settings_key"
)"
e2e_e4_assert_response settings-patch 200 "$e2e_e4_status_code"
e2e_e4_snapshot_settings_revision="$({
  E2E_EXPECTED_REVISION="$((e2e_e4_initial_settings_revision + 1))" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const fail = () => {
      process.stderr.write("E4 settings CAS contract mismatch.\n");
      process.exit(1);
    };
    const settings = value.settings;
    if (
      value.replayed !== false ||
      settings?.settingsRevision !== Number(process.env.E2E_EXPECTED_REVISION) ||
      settings.providerMode !== "byok" ||
      settings.byokProvider !== "openai" ||
      settings.modelSelection !== "auto" ||
      settings.byokFallbackToApp !== false ||
      settings.routingEffort !== "thorough" ||
      settings.expansionStyle !== "detailed"
    ) fail();
    process.stdout.write(String(settings.settingsRevision));
  ' "$e2e_tmp_dir/e4-settings-patch.json"
})"
e2e_e4_status_code="$(
  e2e_e4_status settings-replay PATCH /me/settings \
    "$e2e_e4_settings_body" "$e2e_e4_settings_key"
)"
e2e_e4_assert_response settings-replay 200 "$e2e_e4_status_code"
E2E_EXPECTED_REVISION="$e2e_e4_snapshot_settings_revision" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.settings?.settingsRevision !== Number(process.env.E2E_EXPECTED_REVISION)) {
    process.stderr.write("E4 settings replay contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-settings-replay.json"

e2e_e4_stale_key="e4-settings-stale-$e2e_run_id"
e2e_e4_stale_body="$({
  E2E_REVISION="$e2e_e4_initial_settings_revision" E2E_KEY="$e2e_e4_stale_key" node -e '
    process.stdout.write(JSON.stringify({
      expectedSettingsRevision: Number(process.env.E2E_REVISION),
      idempotencyKey: process.env.E2E_KEY,
      routingEffort: "standard"
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status settings-stale PATCH /me/settings \
    "$e2e_e4_stale_body" "$e2e_e4_stale_key"
)"
e2e_e4_assert_response settings-stale 409 "$e2e_e4_status_code" stale_revision

e2e_stage="e4-provider-put"
e2e_e4_status_code="$(e2e_e4_status provider-empty GET "/me/provider-key?provider=openai")"
e2e_e4_assert_response provider-empty 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.providerKey !== null) {
    process.stderr.write("E4 empty provider-key status contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-empty.json"

e2e_e4_put_key="e4-provider-put-$e2e_run_id"
e2e_e4_put_body="$({
  E2E_KEY="$e2e_e4_put_key" E2E_SECRET="$e2e_e4_provider_key_canary" node -e '
    process.stdout.write(JSON.stringify({
      idempotencyKey: process.env.E2E_KEY,
      provider: "openai",
      expectedCredentialRevision: null,
      apiKey: process.env.E2E_SECRET
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status provider-put PUT /me/provider-key \
    "$e2e_e4_put_body" "$e2e_e4_put_key"
)"
e2e_e4_assert_response provider-put 200 "$e2e_e4_status_code"
E2E_SECRET="$e2e_e4_provider_key_canary" node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const value = JSON.parse(raw);
  if (
    raw.includes(process.env.E2E_SECRET) ||
    value.replayed !== false ||
    value.providerKey?.provider !== "openai" ||
    value.providerKey?.status !== "active" ||
    value.providerKey?.credentialRevision !== 1 ||
    value.providerKey?.lastFour !== "7Qz9"
  ) {
    process.stderr.write("E4 provider-key PUT contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-put.json"

e2e_e4_status_code="$(
  e2e_e4_status provider-put-replay PUT /me/provider-key \
    "$e2e_e4_put_body" "$e2e_e4_put_key"
)"
e2e_e4_assert_response provider-put-replay 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.replayed !== true || value.providerKey?.credentialRevision !== 1) {
    process.stderr.write("E4 provider-key PUT replay contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-put-replay.json"

e2e_e4_status_code="$(e2e_e4_status provider-status GET "/me/provider-key?provider=openai")"
e2e_e4_assert_response provider-status 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (
    value.providerKey?.provider !== "openai" ||
    value.providerKey?.status !== "active" ||
    value.providerKey?.credentialRevision !== 1 ||
    value.providerKey?.lastFour !== "7Qz9"
  ) {
    process.stderr.write("E4 provider-key status contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-status.json"

curl --fail --silent --show-error "http://127.0.0.1:3101/metrics" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (JSON.parse(input).validations !== 1) {
      process.stderr.write("E4 provider validator call-count mismatch.\n");
      process.exit(1);
    }
  });
'

e2e_stage="g-dual-provider-keys"
e2e_e4_status_code="$(e2e_e4_status provider-anthropic-empty GET "/me/provider-key?provider=anthropic")"
e2e_e4_assert_response provider-anthropic-empty 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.providerKey !== null) {
    process.stderr.write("G empty Anthropic provider-key status contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-anthropic-empty.json"
e2e_e4_status_code="$(e2e_e4_status provider-unaddressed GET /me/provider-key)"
e2e_e4_assert_response provider-unaddressed 400 "$e2e_e4_status_code" validation_failed
e2e_e4_status_code="$(e2e_e4_status provider-unknown GET "/me/provider-key?provider=gemini")"
e2e_e4_assert_response provider-unknown 400 "$e2e_e4_status_code" validation_failed

e2e_g_anthropic_put_key="g-anthropic-put-$e2e_run_id"
e2e_g_anthropic_put_body="$({
  E2E_KEY="$e2e_g_anthropic_put_key" E2E_SECRET="$e2e_g_anthropic_key_canary" node -e '
    process.stdout.write(JSON.stringify({
      idempotencyKey: process.env.E2E_KEY,
      provider: "anthropic",
      expectedCredentialRevision: null,
      apiKey: process.env.E2E_SECRET
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status provider-anthropic-put PUT /me/provider-key \
    "$e2e_g_anthropic_put_body" "$e2e_g_anthropic_put_key"
)"
e2e_e4_assert_response provider-anthropic-put 200 "$e2e_e4_status_code"
E2E_SECRET="$e2e_g_anthropic_key_canary" node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const value = JSON.parse(raw);
  if (
    raw.includes(process.env.E2E_SECRET) ||
    value.replayed !== false ||
    value.providerKey?.provider !== "anthropic" ||
    value.providerKey?.status !== "active" ||
    value.providerKey?.credentialRevision !== 1 ||
    value.providerKey?.lastFour !== "5Kp2"
  ) {
    process.stderr.write("G Anthropic provider-key PUT contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-anthropic-put.json"
for e2e_g_provider in openai anthropic; do
  e2e_e4_status_code="$(e2e_e4_status "provider-both-$e2e_g_provider" GET "/me/provider-key?provider=$e2e_g_provider")"
  e2e_e4_assert_response "provider-both-$e2e_g_provider" 200 "$e2e_e4_status_code"
  E2E_PROVIDER="$e2e_g_provider" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (
      value.providerKey?.provider !== process.env.E2E_PROVIDER ||
      value.providerKey?.status !== "active" ||
      value.providerKey?.credentialRevision !== 1
    ) {
      process.stderr.write("G coexisting provider-key status mismatch for " + process.env.E2E_PROVIDER + ".\n");
      process.exit(1);
    }
  ' "$e2e_tmp_dir/e4-provider-both-$e2e_g_provider.json"
done
curl --fail --silent --show-error "http://127.0.0.1:3101/metrics" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const metrics = JSON.parse(input);
    if (metrics.validations !== 1 || metrics.anthropicValidations !== 1 || metrics.crossProviderLeaks !== 0) {
      process.stderr.write("G provider validator routing mismatch: " + JSON.stringify(metrics) + "\n");
      process.exit(1);
    }
  });
'
e2e_g_anthropic_delete_key="g-anthropic-delete-$e2e_run_id"
e2e_g_anthropic_delete_body="$({
  E2E_KEY="$e2e_g_anthropic_delete_key" node -e '
    process.stdout.write(JSON.stringify({
      idempotencyKey: process.env.E2E_KEY,
      provider: "anthropic",
      expectedCredentialRevision: 1
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status provider-anthropic-delete DELETE /me/provider-key \
    "$e2e_g_anthropic_delete_body" "$e2e_g_anthropic_delete_key"
)"
e2e_e4_assert_response provider-anthropic-delete 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (
    value.provider !== "anthropic" || value.deleted !== true ||
    value.deletedCredentialRevision !== 1 || value.replayed !== false
  ) {
    process.stderr.write("G Anthropic provider-key delete contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-anthropic-delete.json"
e2e_e4_status_code="$(e2e_e4_status provider-openai-intact GET "/me/provider-key?provider=openai")"
e2e_e4_assert_response provider-openai-intact 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.providerKey?.provider !== "openai" || value.providerKey?.credentialRevision !== 1) {
    process.stderr.write("G deleting the Claude key disturbed the OpenAI key.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-openai-intact.json"

e2e_stage="e4-platform-vault-denial"
e2e_e4_vault_accept_status="$({
  curl --silent --show-error \
    --request GET \
    --header "apikey: $SERVICE_ROLE_KEY" \
    --header "authorization: Bearer $SERVICE_ROLE_KEY" \
    --header "accept-profile: vault" \
    --dump-header "$e2e_tmp_dir/e4-vault-accept.headers" \
    --output "$e2e_tmp_dir/e4-vault-accept.json" \
    --write-out '%{http_code}' \
    "$e2e_supabase_url/rest/v1/secrets?select=id%2Csecret"
})"
if [[ "$e2e_e4_vault_accept_status" =~ ^2 ]]; then
  echo "The service role reached Vault through an exposed Accept-Profile." >&2
  exit 1
fi
e2e_e4_vault_content_status="$({
  curl --silent --show-error \
    --request POST \
    --header "apikey: $SERVICE_ROLE_KEY" \
    --header "authorization: Bearer $SERVICE_ROLE_KEY" \
    --header "content-profile: vault" \
    --header "content-type: application/json" \
    --data '{}' \
    --dump-header "$e2e_tmp_dir/e4-vault-content.headers" \
    --output "$e2e_tmp_dir/e4-vault-content.json" \
    --write-out '%{http_code}' \
    "$e2e_supabase_url/rest/v1/secrets"
})"
if [[ "$e2e_e4_vault_content_status" =~ ^2 ]]; then
  echo "The service role reached Vault through an exposed Content-Profile." >&2
  exit 1
fi

e2e_stage="e4-job-snapshot"
e2e_e4_capture_id="$(e2e_new_entity_id cap)"
e2e_e4_capture_created_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
e2e_e4_capture_text="E4 lease-bound snapshot fixture $e2e_run_id"
e2e_e4_capture_body="$({
  E2E_CAPTURE_ID="$e2e_e4_capture_id" E2E_TEXT="$e2e_e4_capture_text" \
    E2E_CREATED_AT="$e2e_e4_capture_created_at" node -e '
      process.stdout.write(JSON.stringify({
        clientCaptureId: process.env.E2E_CAPTURE_ID,
        rawContent: process.env.E2E_TEXT,
        source: "web",
        clientCreatedAt: process.env.E2E_CREATED_AT,
        clientTimezone: "UTC",
        privacy: "ai_assisted",
        expansionDisabled: false
      }));
    '
})"
e2e_e4_status_code="$(
  e2e_e4_status capture-create POST /captures \
    "$e2e_e4_capture_body" "$e2e_e4_capture_id"
)"
e2e_e4_assert_response capture-create 202 "$e2e_e4_status_code"
e2e_stage="e4-capture-contract"
e2e_e4_job_id="$({
  E2E_CAPTURE_ID="$e2e_e4_capture_id" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (
      value.capture?.id !== process.env.E2E_CAPTURE_ID ||
      value.capture?.status !== "queued" ||
      value.replayed !== false ||
      !/^job_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.jobId)
    ) {
      process.stderr.write("E4 capture enqueue contract mismatch.\n");
      process.exit(1);
    }
    process.stdout.write(value.jobId);
  ' "$e2e_tmp_dir/e4-capture-create.json"
})"

# Change the live profile after enqueue; the job must retain its original
# thorough/detailed BYOK snapshot.
e2e_stage="e4-settings-after-enqueue"
e2e_e4_later_settings_key="e4-settings-later-$e2e_run_id"
e2e_e4_later_settings_body="$({
  E2E_REVISION="$e2e_e4_snapshot_settings_revision" \
    E2E_KEY="$e2e_e4_later_settings_key" node -e '
      process.stdout.write(JSON.stringify({
        expectedSettingsRevision: Number(process.env.E2E_REVISION),
        idempotencyKey: process.env.E2E_KEY,
        routingEffort: "economical",
        expansionStyle: "off"
      }));
    '
})"
e2e_e4_status_code="$(
  e2e_e4_status settings-later PATCH /me/settings \
    "$e2e_e4_later_settings_body" "$e2e_e4_later_settings_key"
)"
e2e_e4_assert_response settings-later 200 "$e2e_e4_status_code"

e2e_stage="e4-storage-canary"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --set=owner_id="$e2e_encrypted_owner_id" \
  --set=job_id="$e2e_e4_job_id" \
  --set=snapshot_revision="$e2e_e4_snapshot_settings_revision" \
  --set=provider_key="$e2e_e4_provider_key_canary" <<'SQL' >/dev/null
select pg_catalog.set_config('unfiled.e4_http_owner', :'owner_id', false);
select pg_catalog.set_config('unfiled.e4_http_job', :'job_id', false);
select pg_catalog.set_config('unfiled.e4_http_snapshot_revision', :'snapshot_revision', false);
select pg_catalog.set_config('unfiled.e4_http_provider_key', :'provider_key', false);
do $e4_http_storage$
declare
  owner_value uuid := pg_catalog.current_setting('unfiled.e4_http_owner')::uuid;
  job_value text := pg_catalog.current_setting('unfiled.e4_http_job');
  snapshot_revision_value integer :=
    pg_catalog.current_setting('unfiled.e4_http_snapshot_revision')::integer;
  canary_value text := pg_catalog.current_setting('unfiled.e4_http_provider_key');
  table_value record;
  hit_count bigint;
begin
  if not exists (
    select 1 from public.organization_job_ai_settings
    where job_id = job_value and user_id = owner_value
      and settings_revision = snapshot_revision_value
      and provider_mode = 'byok' and selected_provider = 'openai'
      and not byok_fallback_to_app
      and routing_effort = 'thorough' and expansion_style = 'detailed'
      and model_selection = 'auto' and model_id = 'gpt-5.6-sol'
      and adapter_registry_version = 'organization-model-registry-v2'
  ) or exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_job_ai_settings'
      and column_name ~ '(credential|secret|vault|cipher|api_key|key_id)'
  ) or exists (
    select 1 from public.organization_job_ai_settings
    where job_id = job_value
      and pg_catalog.strpos(to_jsonb(organization_job_ai_settings)::text, canary_value) > 0
  ) then
    raise exception using message = 'e4_http_job_snapshot_failed';
  end if;

  if not exists (
    select 1 from public.user_provider_keys as provider_key
    join vault.decrypted_secrets as secret
      on secret.id = provider_key.vault_secret_id
    where provider_key.user_id = owner_value
      and provider_key.provider = 'openai'
      and provider_key.status = 'active'
      and provider_key.credential_revision = 1
      and provider_key.key_ciphertext is null
      and secret.decrypted_secret = canary_value
  ) or exists (
    select 1 from vault.secrets where secret = canary_value
  ) then
    raise exception using message = 'e4_http_vault_storage_failed';
  end if;

  for table_value in
    select columns.table_schema, columns.table_name
    from information_schema.columns as columns
    join information_schema.tables as tables
      on tables.table_schema = columns.table_schema
      and tables.table_name = columns.table_name
    where columns.table_schema in ('public', 'private')
      and columns.column_name = 'user_id'
      and tables.table_type = 'BASE TABLE'
    order by columns.table_schema, columns.table_name
  loop
    execute pg_catalog.format(
      'select count(*) from %I.%I as row_value where row_value.user_id = $1 and pg_catalog.strpos(to_jsonb(row_value)::text, $2) > 0',
      table_value.table_schema, table_value.table_name
    ) into hit_count using owner_value, canary_value;
    if hit_count <> 0 then
      raise exception using message = 'e4_http_plaintext_canary_found';
    end if;
  end loop;

  update public.organization_jobs
  set available_at = case when id = job_value
    then clock_timestamp() else clock_timestamp() + interval '1 hour' end
  where user_id = owner_value and state in ('created', 'awaiting_retry');
end
$e4_http_storage$;
SQL

e2e_stage="e4-live-lease"
e2e_e4_worker_password="$({
  node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))'
})"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --set=worker_password="$e2e_e4_worker_password" <<'SQL' >/dev/null
select pg_catalog.format(
  'alter role unfiled_organizer_worker login password %L', :'worker_password'
) as command
\gexec
SQL
e2e_e4_worker_login_active="1"

e2e_e4_claim="$({
  e2e_e4_worker_query \
    "select public.claim_encrypted_organizer_jobs('e4-http-worker',1,900);"
})"
e2e_e4_lease_token="$({
  E2E_CLAIM="$e2e_e4_claim" E2E_JOB_ID="$e2e_e4_job_id" node -e '
    const value = JSON.parse(process.env.E2E_CLAIM);
    const job = value.jobs?.[0];
    if (
      value.jobs?.length !== 1 ||
      job?.jobId !== process.env.E2E_JOB_ID ||
      job.routingEffort !== "thorough" ||
      job.expansionStyle !== "detailed" ||
      job.selectedProvider !== "openai" ||
      job.modelSelection !== "auto" ||
      job.modelId !== "gpt-5.6-sol" ||
      job.adapterRegistryVersion !== "organization-model-registry-v2" ||
      !Number.isInteger(job.settingsRevision) || job.settingsRevision < 1 ||
      job.controls?.expansionDisabled !== false ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(job.leaseToken)
    ) {
      process.stderr.write("E4 immutable lease claim contract mismatch.\n");
      process.exit(1);
    }
    process.stdout.write(job.leaseToken);
  '
})"
e2e_e4_route="$({
  e2e_e4_worker_query \
    "select public.get_lease_bound_organizer_provider_credential('$e2e_e4_job_id','$e2e_e4_lease_token');"
})"
E2E_ROUTE="$e2e_e4_route" E2E_SECRET="$e2e_e4_provider_key_canary" node -e '
  const value = JSON.parse(process.env.E2E_ROUTE);
  if (
    value.provider !== "openai" || value.source !== "byok" ||
    value.credential !== process.env.E2E_SECRET || value.credentialRevision !== 1 ||
    value.routingEffort !== "thorough" || value.expansionStyle !== "detailed" ||
    value.modelSelection !== "auto" || value.modelId !== "gpt-5.6-sol" ||
    value.adapterRegistryVersion !== "organization-model-registry-v2" ||
    !Number.isInteger(value.settingsRevision) || value.settingsRevision < 1 ||
    Object.keys(value).length !== 10
  ) {
    process.stderr.write("E4 live Vault route contract mismatch.\n");
    process.exit(1);
  }
'
e2e_e4_route=""

e2e_stage="e4-provider-delete"
e2e_e4_delete_key="e4-provider-delete-$e2e_run_id"
e2e_e4_delete_body="$({
  E2E_KEY="$e2e_e4_delete_key" node -e '
    process.stdout.write(JSON.stringify({
      idempotencyKey: process.env.E2E_KEY,
      provider: "openai",
      expectedCredentialRevision: 1
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status provider-delete DELETE /me/provider-key \
    "$e2e_e4_delete_body" "$e2e_e4_delete_key"
)"
e2e_e4_assert_response provider-delete 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (
    value.provider !== "openai" || value.deleted !== true ||
    value.deletedCredentialRevision !== 1 || value.replayed !== false
  ) {
    process.stderr.write("E4 provider-key delete contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-delete.json"
e2e_e4_status_code="$(
  e2e_e4_status provider-delete-replay DELETE /me/provider-key \
    "$e2e_e4_delete_body" "$e2e_e4_delete_key"
)"
e2e_e4_assert_response provider-delete-replay 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.deleted !== true || value.deletedCredentialRevision !== 1 || value.replayed !== true) {
    process.stderr.write("E4 provider-key delete replay contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-delete-replay.json"
e2e_e4_status_code="$(e2e_e4_status provider-after-delete GET "/me/provider-key?provider=openai")"
e2e_e4_assert_response provider-after-delete 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.providerKey !== null) {
    process.stderr.write("E4 provider-key post-delete status mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-after-delete.json"

if e2e_e4_worker_query \
  "select public.get_lease_bound_organizer_provider_credential('$e2e_e4_job_id','$e2e_e4_lease_token');" \
  >"$e2e_tmp_dir/e4-deleted-lease.out" 2>"$e2e_tmp_dir/e4-deleted-lease.err"; then
  echo "A live lease resolved a deleted provider credential." >&2
  exit 1
fi
grep --fixed-strings --quiet "provider_unavailable" "$e2e_tmp_dir/e4-deleted-lease.err"

psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --set=owner_id="$e2e_encrypted_owner_id" \
  --set=provider_key="$e2e_e4_provider_key_canary" <<'SQL' >/dev/null
select pg_catalog.set_config('unfiled.e4_http_owner', :'owner_id', false);
select pg_catalog.set_config('unfiled.e4_http_provider_key', :'provider_key', false);
do $e4_http_deleted$
declare
  owner_value uuid := pg_catalog.current_setting('unfiled.e4_http_owner')::uuid;
  canary_value text := pg_catalog.current_setting('unfiled.e4_http_provider_key');
begin
  if exists (
    select 1 from public.user_provider_keys where user_id = owner_value
  ) or exists (
    select 1 from vault.decrypted_secrets where decrypted_secret = canary_value
  ) then
    raise exception using message = 'e4_http_provider_delete_failed';
  end if;
end
$e4_http_deleted$;
SQL

e2e_stage="e4-provider-recreate"
e2e_e4_recreate_key="e4-provider-recreate-$e2e_run_id"
e2e_e4_recreate_body="$({
  E2E_KEY="$e2e_e4_recreate_key" \
    E2E_SECRET="$e2e_e4_provider_recreate_canary" node -e '
      process.stdout.write(JSON.stringify({
        idempotencyKey: process.env.E2E_KEY,
        provider: "openai",
        expectedCredentialRevision: null,
        apiKey: process.env.E2E_SECRET
      }));
    '
})"
e2e_e4_status_code="$(
  e2e_e4_status provider-recreate PUT /me/provider-key \
    "$e2e_e4_recreate_body" "$e2e_e4_recreate_key"
)"
e2e_e4_assert_response provider-recreate 200 "$e2e_e4_status_code"
E2E_SECRET="$e2e_e4_provider_recreate_canary" node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const value = JSON.parse(raw);
  if (
    raw.includes(process.env.E2E_SECRET) ||
    value.replayed !== false ||
    value.providerKey?.provider !== "openai" ||
    value.providerKey?.status !== "active" ||
    value.providerKey?.credentialRevision !== 2 ||
    value.providerKey?.lastFour !== "3Lm8"
  ) {
    process.stderr.write("E4 delete-recreate revision contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-recreate.json"

curl --fail --silent --show-error "http://127.0.0.1:3101/metrics" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (JSON.parse(input).validations !== 2) {
      process.stderr.write("E4 recreated-key validator call-count mismatch.\n");
      process.exit(1);
    }
  });
'

if e2e_e4_worker_query \
  "select public.get_lease_bound_organizer_provider_credential('$e2e_e4_job_id','$e2e_e4_lease_token');" \
  >"$e2e_tmp_dir/e4-recreated-old-lease.out" \
  2>"$e2e_tmp_dir/e4-recreated-old-lease.err"; then
  echo "An old lease resolved a recreated provider credential." >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "provider_unavailable" "$e2e_tmp_dir/e4-recreated-old-lease.err"

psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --set=owner_id="$e2e_encrypted_owner_id" \
  --set=deleted_key="$e2e_e4_provider_key_canary" \
  --set=recreated_key="$e2e_e4_provider_recreate_canary" <<'SQL' >/dev/null
select pg_catalog.set_config('unfiled.e4_http_owner', :'owner_id', false);
select pg_catalog.set_config('unfiled.e4_http_deleted_key', :'deleted_key', false);
select pg_catalog.set_config('unfiled.e4_http_recreated_key', :'recreated_key', false);
do $e4_http_recreated$
declare
  owner_value uuid := pg_catalog.current_setting('unfiled.e4_http_owner')::uuid;
  deleted_value text := pg_catalog.current_setting('unfiled.e4_http_deleted_key');
  recreated_value text := pg_catalog.current_setting('unfiled.e4_http_recreated_key');
  table_value record;
  hit_count bigint;
begin
  if not exists (
    select 1 from public.user_provider_keys as provider_key
    join vault.decrypted_secrets as secret
      on secret.id = provider_key.vault_secret_id
    where provider_key.user_id = owner_value
      and provider_key.provider = 'openai'
      and provider_key.status = 'active'
      and provider_key.credential_revision = 2
      and provider_key.key_last4 = '3Lm8'
      and provider_key.key_ciphertext is null
      and secret.decrypted_secret = recreated_value
  ) or exists (
    select 1 from vault.decrypted_secrets
    where decrypted_secret = deleted_value
  ) or exists (
    select 1 from vault.secrets
    where secret in (deleted_value, recreated_value)
  ) then
    raise exception using message = 'e4_http_provider_recreate_failed';
  end if;

  for table_value in
    select columns.table_schema, columns.table_name
    from information_schema.columns as columns
    join information_schema.tables as tables
      on tables.table_schema = columns.table_schema
      and tables.table_name = columns.table_name
    where columns.table_schema in ('public', 'private')
      and columns.column_name = 'user_id'
      and tables.table_type = 'BASE TABLE'
    order by columns.table_schema, columns.table_name
  loop
    execute pg_catalog.format(
      'select count(*) from %I.%I as row_value where row_value.user_id = $1 and (pg_catalog.strpos(to_jsonb(row_value)::text, $2) > 0 or pg_catalog.strpos(to_jsonb(row_value)::text, $3) > 0)',
      table_value.table_schema, table_value.table_name
    ) into hit_count using owner_value, deleted_value, recreated_value;
    if hit_count <> 0 then
      raise exception using message = 'e4_http_recreate_plaintext_canary_found';
    end if;
  end loop;
end
$e4_http_recreated$;
SQL

e2e_e4_recreate_delete_key="e4-provider-recreate-delete-$e2e_run_id"
e2e_e4_recreate_delete_body="$({
  E2E_KEY="$e2e_e4_recreate_delete_key" node -e '
    process.stdout.write(JSON.stringify({
      idempotencyKey: process.env.E2E_KEY,
      provider: "openai",
      expectedCredentialRevision: 2
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status provider-recreate-delete DELETE /me/provider-key \
    "$e2e_e4_recreate_delete_body" "$e2e_e4_recreate_delete_key"
)"
e2e_e4_assert_response provider-recreate-delete 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (
    value.provider !== "openai" || value.deleted !== true ||
    value.deletedCredentialRevision !== 2 || value.replayed !== false
  ) {
    process.stderr.write("E4 recreated-key final delete contract mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-recreate-delete.json"

e2e_e4_status_code="$(e2e_e4_status provider-final-empty GET "/me/provider-key?provider=openai")"
e2e_e4_assert_response provider-final-empty 200 "$e2e_e4_status_code"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.providerKey !== null) {
    process.stderr.write("E4 final provider-key status mismatch.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-provider-final-empty.json"

psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --set=owner_id="$e2e_encrypted_owner_id" \
  --set=deleted_key="$e2e_e4_provider_key_canary" \
  --set=recreated_key="$e2e_e4_provider_recreate_canary" <<'SQL' >/dev/null
select pg_catalog.set_config('unfiled.e4_http_owner', :'owner_id', false);
select pg_catalog.set_config('unfiled.e4_http_deleted_key', :'deleted_key', false);
select pg_catalog.set_config('unfiled.e4_http_recreated_key', :'recreated_key', false);
do $e4_http_final_empty$
declare
  owner_value uuid := pg_catalog.current_setting('unfiled.e4_http_owner')::uuid;
  deleted_value text := pg_catalog.current_setting('unfiled.e4_http_deleted_key');
  recreated_value text := pg_catalog.current_setting('unfiled.e4_http_recreated_key');
begin
  if exists (
    select 1 from public.user_provider_keys where user_id = owner_value
  ) or exists (
    select 1 from vault.decrypted_secrets
    where decrypted_secret in (deleted_value, recreated_value)
  ) then
    raise exception using message = 'e4_http_final_provider_cleanup_failed';
  end if;
end
$e4_http_final_empty$;
SQL

psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
  --command='alter role unfiled_organizer_worker nologin password null' \
  >/dev/null
e2e_e4_worker_login_active="0"
e2e_e4_worker_password=""

e2e_stage="g-provider-model-selection"
e2e_e4_status_code="$(e2e_e4_status settings-current GET /me/settings)"
e2e_e4_assert_response settings-current 200 "$e2e_e4_status_code"
e2e_g_settings_revision="$({
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(value.settings.settingsRevision));
  ' "$e2e_tmp_dir/e4-settings-current.json"
})"
e2e_g_switch_key="g-settings-anthropic-$e2e_run_id"
e2e_g_switch_body="$({
  E2E_REVISION="$e2e_g_settings_revision" E2E_KEY="$e2e_g_switch_key" node -e '
    process.stdout.write(JSON.stringify({
      expectedSettingsRevision: Number(process.env.E2E_REVISION),
      idempotencyKey: process.env.E2E_KEY,
      byokProvider: "anthropic",
      modelSelection: "claude-opus-5",
      routingEffort: "standard"
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status settings-anthropic PATCH /me/settings \
    "$e2e_g_switch_body" "$e2e_g_switch_key"
)"
e2e_e4_assert_response settings-anthropic 200 "$e2e_e4_status_code"
e2e_g_settings_revision="$({
  E2E_EXPECTED_REVISION="$((e2e_g_settings_revision + 1))" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const settings = value.settings;
    if (
      value.replayed !== false ||
      settings?.settingsRevision !== Number(process.env.E2E_EXPECTED_REVISION) ||
      settings.providerMode !== "byok" ||
      settings.byokProvider !== "anthropic" ||
      settings.modelSelection !== "claude-opus-5" ||
      settings.routingEffort !== "standard"
    ) {
      process.stderr.write("G Anthropic provider/model settings contract mismatch.\n");
      process.exit(1);
    }
    process.stdout.write(String(settings.settingsRevision));
  ' "$e2e_tmp_dir/e4-settings-anthropic.json"
})"
e2e_g_cross_key="g-settings-cross-$e2e_run_id"
e2e_g_cross_body="$({
  E2E_REVISION="$e2e_g_settings_revision" E2E_KEY="$e2e_g_cross_key" node -e '
    process.stdout.write(JSON.stringify({
      expectedSettingsRevision: Number(process.env.E2E_REVISION),
      idempotencyKey: process.env.E2E_KEY,
      modelSelection: "gpt-5.6-luna"
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status settings-cross PATCH /me/settings \
    "$e2e_g_cross_body" "$e2e_g_cross_key"
)"
e2e_e4_assert_response settings-cross 400 "$e2e_e4_status_code" validation_failed
e2e_g_back_key="g-settings-openai-$e2e_run_id"
e2e_g_back_body="$({
  E2E_REVISION="$e2e_g_settings_revision" E2E_KEY="$e2e_g_back_key" node -e '
    process.stdout.write(JSON.stringify({
      expectedSettingsRevision: Number(process.env.E2E_REVISION),
      idempotencyKey: process.env.E2E_KEY,
      byokProvider: "openai"
    }));
  '
})"
e2e_e4_status_code="$(
  e2e_e4_status settings-openai PATCH /me/settings \
    "$e2e_g_back_body" "$e2e_g_back_key"
)"
e2e_e4_assert_response settings-openai 200 "$e2e_e4_status_code"
E2E_EXPECTED_REVISION="$((e2e_g_settings_revision + 1))" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const settings = value.settings;
  if (
    settings?.settingsRevision !== Number(process.env.E2E_EXPECTED_REVISION) ||
    settings.byokProvider !== "openai" ||
    settings.modelSelection !== "auto"
  ) {
    process.stderr.write("G provider switch did not reset the incompatible model to Automatic.\n");
    process.exit(1);
  }
' "$e2e_tmp_dir/e4-settings-openai.json"

e2e_stage="e4-plaintext-canary"
if grep --recursive --fixed-strings --quiet -- \
  "$e2e_e4_provider_key_canary" "$e2e_tmp_dir"; then
  echo "The E4 provider-key plaintext escaped into a response or test log." >&2
  exit 1
fi
if grep --recursive --fixed-strings --quiet -- \
  "$e2e_e4_provider_recreate_canary" "$e2e_tmp_dir"; then
  echo "The E4 recreated-key plaintext escaped into a response or test log." >&2
  exit 1
fi
if grep --recursive --fixed-strings --quiet -- \
  "$e2e_g_anthropic_key_canary" "$e2e_tmp_dir"; then
  echo "The G Claude-key plaintext escaped into a response or test log." >&2
  exit 1
fi
if grep --fixed-strings --quiet -- \
  "$e2e_e4_provider_key_canary" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet -- \
    "$e2e_e4_provider_key_canary" "$e2e_tmp_dir/provider-mock.log" || \
  grep --fixed-strings --quiet -- \
    "$e2e_e4_provider_recreate_canary" "$e2e_tmp_dir/web.log" || \
  grep --fixed-strings --quiet -- \
    "$e2e_e4_provider_recreate_canary" "$e2e_tmp_dir/provider-mock.log"; then
  echo "The E4 provider-key plaintext appeared in a server log." >&2
  exit 1
fi

unset -f e2e_e4_status e2e_e4_assert_response e2e_e4_worker_query
