-- Milestone B manual-note transactional foundation.

alter table public.spaces
  add column current_revision integer not null default 1
  check (current_revision >= 1);

alter table public.tags
  add column current_revision integer not null default 1
  check (current_revision >= 1),
  add column updated_at timestamptz not null default now();

-- A create receipt truthfully spans the absence of a note (revision 0) to its
-- first immutable snapshot (revision 1). Later mutations remain N -> N + 1.
alter table public.note_mutations
  drop constraint note_mutations_before_revision_check,
  add constraint note_mutations_before_revision_check
    check (before_revision >= 0);

create trigger tags_set_updated_at
before update on public.tags
for each row execute function public.set_updated_at();

create table public.api_idempotency_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 80),
  scope text not null check (char_length(scope) between 1 and 100),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response_json jsonb check (
    response_json is null or jsonb_typeof(response_json) = 'object'
  ),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, idempotency_key)
);
create index api_idempotency_records_created
  on public.api_idempotency_records (created_at);

alter table public.api_idempotency_records enable row level security;
revoke all privileges on public.api_idempotency_records from anon, authenticated;
grant all privileges on public.api_idempotency_records to service_role;

create or replace function private.request_hash(payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(payload::text, 'sha256'), 'hex');
$$;

create or replace function private.claim_idempotency(
  owner_id uuid,
  key_value text,
  scope_value text,
  request_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_hash text;
  existing_record public.api_idempotency_records%rowtype;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;

  if key_value is null
    or char_length(key_value) not between 1 and 80
    or btrim(key_value) = ''
  then
    raise exception using errcode = '22023', message = 'invalid_idempotency_key';
  end if;

  expected_hash := private.request_hash(request_payload);

  insert into public.api_idempotency_records (
    user_id,
    idempotency_key,
    scope,
    request_hash
  )
  values (owner_id, key_value, scope_value, expected_hash)
  on conflict (user_id, idempotency_key) do nothing;

  if found then
    return jsonb_build_object('replayed', false);
  end if;

  select *
  into existing_record
  from public.api_idempotency_records
  where user_id = owner_id and idempotency_key = key_value
  for update;

  if existing_record.scope <> scope_value
    or existing_record.request_hash <> expected_hash
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  if existing_record.response_json is null then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  return jsonb_build_object(
    'replayed', true,
    'response', existing_record.response_json
  );
end;
$$;

create or replace function private.finish_idempotency(
  owner_id uuid,
  key_value text,
  response_value jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.api_idempotency_records
  set response_json = response_value, completed_at = now()
  where user_id = owner_id
    and idempotency_key = key_value
    and response_json is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
end;
$$;

create or replace function private.note_content_hash(
  title_value text,
  body_value text,
  structured_value jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'title', title_value,
        'bodyMarkdown', body_value,
        'structuredData', structured_value
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function private.note_json(note_value public.notes)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', note_value.id,
    'spaceId', note_value.space_id,
    'type', note_value.type,
    'title', note_value.title,
    'bodyMarkdown', note_value.body_markdown,
    'structuredData', note_value.structured_data,
    'currentRevision', note_value.current_revision,
    'dailyDate', note_value.daily_date,
    'isOpen', note_value.is_open,
    'pinnedAt', note_value.pinned_at,
    'privacy', note_value.privacy,
    'archivedAt', note_value.archived_at,
    'deletedAt', note_value.deleted_at,
    'createdAt', note_value.created_at,
    'updatedAt', note_value.updated_at
  );
$$;

create or replace function private.note_snapshot(note_value public.notes)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'spaceId', note_value.space_id,
    'type', note_value.type,
    'title', note_value.title,
    'bodyMarkdown', note_value.body_markdown,
    'structuredData', note_value.structured_data,
    'dailyDate', note_value.daily_date,
    'isOpen', note_value.is_open,
    'pinnedAt', note_value.pinned_at,
    'privacy', note_value.privacy,
    'archivedAt', note_value.archived_at,
    'deletedAt', note_value.deleted_at
  );
$$;

create or replace function private.space_json(space_value public.spaces)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', space_value.id,
    'parentId', space_value.parent_id,
    'name', space_value.name,
    'slug', space_value.slug,
    'sortKey', space_value.sort_key,
    'currentRevision', space_value.current_revision,
    'archivedAt', space_value.archived_at,
    'createdAt', space_value.created_at,
    'updatedAt', space_value.updated_at
  );
$$;

create or replace function private.tag_json(tag_value public.tags)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', tag_value.id,
    'name', tag_value.name,
    'currentRevision', tag_value.current_revision,
    'createdAt', tag_value.created_at,
    'updatedAt', tag_value.updated_at
  );
$$;

create or replace function private.list_from_markdown(body_value text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  source_line text;
  item_text text;
  item_checked boolean;
  item_index integer := 0;
  items jsonb := '[]'::jsonb;
  current_section text;
  normalized_text text;
  seen_texts text[] := array[]::text[];
begin
  if btrim(coalesce(body_value, '')) = '' then
    return jsonb_build_object('schemaVersion', 1, 'items', items);
  end if;

  foreach source_line in array string_to_array(body_value, E'\n') loop
    if btrim(source_line) = '' then
      continue;
    end if;
    if source_line ~ '^\s*#{2,6}\s+\S' then
      current_section := btrim(regexp_replace(source_line, '^\s*#{2,6}\s+', ''));
      if lower(current_section) = 'completed' then current_section := null; end if;
      continue;
    end if;
    if source_line !~ '^\s*[-*+]\s+(\[[ xX]\]\s+)?\S' then
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end if;

    item_checked := source_line ~ '^\s*[-*+]\s+\[[xX]\]';
    item_text := btrim(regexp_replace(source_line, '^\s*[-*+]\s+(\[[ xX]\]\s+)?', ''));
    normalized_text := lower(regexp_replace(item_text, '\s+', ' ', 'g'));
    if normalized_text = any(seen_texts) then
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end if;
    seen_texts := array_append(seen_texts, normalized_text);
    item_index := item_index + 1;
    items := items || jsonb_build_array(
      jsonb_build_object(
        'id', public.new_entity_id('itm'),
        'text', item_text,
        'checked', item_checked,
        'ordinal', item_index - 1,
        'section', current_section
      )
    );
  end loop;

  if item_index = 0 then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;

  return jsonb_build_object('schemaVersion', 1, 'items', items);
end;
$$;

create or replace function private.render_list_note(structured_value jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  item jsonb;
  active_lines text[] := array[]::text[];
  completed_lines text[] := array[]::text[];
  active_section text;
  completed_section text;
  output text := '';
begin
  if jsonb_typeof(structured_value -> 'items') <> 'array' then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;

  for item in
    select value
    from jsonb_array_elements(structured_value -> 'items')
    order by (value ->> 'ordinal')::integer, value ->> 'id'
  loop
    if coalesce((item ->> 'checked')::boolean, false) then
      if (item ->> 'section') is distinct from completed_section then
        if cardinality(completed_lines) > 0 then
          completed_lines := array_append(completed_lines, '');
        end if;
        if item ->> 'section' is not null then
          completed_lines := array_cat(
            completed_lines,
            array['## ' || (item ->> 'section'), '']
          );
        end if;
        completed_section := item ->> 'section';
      end if;
      completed_lines := array_append(
        completed_lines,
        '- [x] ' || replace(item ->> 'text', E'\n', ' ')
      );
    else
      if (item ->> 'section') is distinct from active_section then
        if cardinality(active_lines) > 0 then
          active_lines := array_append(active_lines, '');
        end if;
        if item ->> 'section' is not null then
          active_lines := array_cat(active_lines, array['## ' || (item ->> 'section'), '']);
        end if;
        active_section := item ->> 'section';
      end if;
      active_lines := array_append(
        active_lines,
        '- [ ] ' || replace(item ->> 'text', E'\n', ' ')
      );
    end if;
  end loop;

  output := array_to_string(active_lines, E'\n');
  if cardinality(completed_lines) > 0 then
    output := output
      || case when output = '' then '' else E'\n\n' end
      || '## Completed'
      || E'\n\n'
      || array_to_string(completed_lines, E'\n');
  end if;

  return output;
end;
$$;

create or replace function private.render_log_note(structured_value jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  entry jsonb;
  field_record record;
  field_lines text[];
  sections text[] := array[]::text[];
begin
  if jsonb_typeof(structured_value -> 'entries') <> 'array' then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;

  for entry in
    select value
    from jsonb_array_elements(structured_value -> 'entries')
    order by value ->> 'occurredAt', value ->> 'id'
  loop
    if jsonb_typeof(entry -> 'fields') <> 'object'
      or nullif(entry ->> 'occurredAt', '') is null
    then
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end if;
    field_lines := array[]::text[];
    for field_record in
      select key, value
      from jsonb_each(entry -> 'fields')
      order by key
    loop
      field_lines := array_append(
        field_lines,
        '- ' || field_record.key || ': '
          || case
            when field_record.value = 'null'::jsonb then 'null'
            when jsonb_typeof(field_record.value) = 'string' and (
              field_record.value #>> '{}' = 'null'
              or field_record.value #>> '{}' ~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$'
              or field_record.value #>> '{}' ~ '^"'
              or field_record.value #>> '{}' <> btrim(field_record.value #>> '{}')
              or field_record.value #>> '{}' ~ E'[\r\n]'
            ) then field_record.value::text
            when jsonb_typeof(field_record.value) = 'string'
              then field_record.value #>> '{}'
            when jsonb_typeof(field_record.value) = 'number'
              then ((field_record.value #>> '{}')::numeric)::text
            else field_record.value::text
          end
      );
    end loop;
    sections := array_append(
      sections,
      '## ' || (entry ->> 'occurredAt')
        || E'\n\n' || array_to_string(field_lines, E'\n')
    );
  end loop;

  return array_to_string(sections, E'\n\n');
end;
$$;

create or replace function private.reject_revision_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'immutable_revision';
end;
$$;

create or replace function private.note_relations_json(note_value public.notes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tagIds', coalesce(
      (
        select jsonb_agg(note_tag.tag_id order by note_tag.tag_id)
        from public.note_tags as note_tag
        where note_tag.note_id = note_value.id
          and note_tag.user_id = note_value.user_id
      ),
      '[]'::jsonb
    ),
    'links', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'toNoteId', note_link.to_note_id,
            'linkType', note_link.link_type
          )
          order by note_link.to_note_id, note_link.link_type
        )
        from public.note_links as note_link
        where note_link.from_note_id = note_value.id
          and note_link.user_id = note_value.user_id
      ),
      '[]'::jsonb
    )
  );
$$;

create or replace function private.revision_json(
  revision_value public.note_revisions
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', revision_value.id,
    'noteId', revision_value.note_id,
    'revision', revision_value.revision,
    'source', revision_value.source,
    'spaceId', revision_value.space_id,
    'type', revision_value.type,
    'title', revision_value.title,
    'bodyMarkdown', revision_value.body_markdown,
    'structuredData', revision_value.structured_data,
    'isOpen', revision_value.is_open,
    'pinnedAt', revision_value.pinned_at,
    'privacy', revision_value.privacy,
    'archivedAt', revision_value.archived_at,
    'deletedAt', revision_value.deleted_at,
    'tagIds', revision_value.tag_ids,
    'links', revision_value.links,
    'contentHash', revision_value.content_hash,
    'actor', revision_value.actor,
    'createdAt', revision_value.created_at
  );
$$;

create or replace function private.note_contract_json(note_value public.notes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (private.note_json(note_value) - 'dailyDate')
    || private.note_relations_json(note_value);
$$;

create or replace function private.note_snapshot_with_relations(note_value public.notes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.note_snapshot(note_value)
    || private.note_relations_json(note_value);
$$;

-- Archive/delete HTTP commands generate a fresh timestamp on retries. Hash their
-- non-null timestamp as a semantic marker so the original idempotent result wins.
create or replace function private.note_operations_idempotency_payload(
  operations_value jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(operations_value) <> 'array' then operations_value
    else (
      select coalesce(
        jsonb_agg(
          case
            when operation ->> 'type' = 'set_archived'
              and jsonb_typeof(operation -> 'archivedAt') = 'string'
              then jsonb_set(operation, '{archivedAt}', '"non_null"'::jsonb)
            when operation ->> 'type' = 'set_deleted'
              and jsonb_typeof(operation -> 'deletedAt') = 'string'
              then jsonb_set(operation, '{deletedAt}', '"non_null"'::jsonb)
            else operation
          end
          order by ordinal
        ),
        '[]'::jsonb
      )
      from jsonb_array_elements(operations_value) with ordinality
        as item(operation, ordinal)
    )
  end;
$$;

create or replace function private.insert_note_revision(
  note_value public.notes,
  source_value public.revision_source,
  actor_value text,
  mutation_value text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  revision_id text := public.new_entity_id('rev');
  relations_value jsonb := private.note_relations_json(note_value);
begin
  insert into public.note_revisions (
    id, note_id, user_id, revision, source, space_id, type, title,
    body_markdown, structured_data, is_open, pinned_at, privacy, archived_at,
    deleted_at, tag_ids, links, content_hash, actor, mutation_id
  ) values (
    revision_id, note_value.id, note_value.user_id, note_value.current_revision,
    source_value, note_value.space_id, note_value.type, note_value.title,
    note_value.body_markdown, note_value.structured_data, note_value.is_open,
    note_value.pinned_at, note_value.privacy, note_value.archived_at,
    note_value.deleted_at, relations_value -> 'tagIds', relations_value -> 'links',
    encode(
      extensions.digest(
        ((private.note_snapshot(note_value) - 'dailyDate') || relations_value)::text,
        'sha256'
      ),
      'hex'
    ),
    actor_value,
    mutation_value
  );
  return revision_id;
end;
$$;

create or replace function private.project_checklist_from_markdown(body_value text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  source_line text;
  line_index integer := -1;
  item_index integer := 0;
  checklist_items jsonb := '[]'::jsonb;
  item_text text;
  normalized_text text;
  seen_texts text[] := array[]::text[];
begin
  foreach source_line in array string_to_array(coalesce(body_value, ''), E'\n') loop
    line_index := line_index + 1;
    if source_line !~ '^\s*[-*+]\s+\[[ xX]\]\s+\S' then
      continue;
    end if;
    item_text := btrim(regexp_replace(source_line, '^\s*[-*+]\s+\[[ xX]\]\s+', ''));
    normalized_text := lower(regexp_replace(item_text, '\s+', ' ', 'g'));
    if normalized_text = any(seen_texts) then
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end if;
    seen_texts := array_append(seen_texts, normalized_text);
    item_index := item_index + 1;
    checklist_items := checklist_items || jsonb_build_array(
      jsonb_build_object(
        'id', public.new_entity_id('itm'),
        'text', item_text,
        'checked', source_line ~ '^\s*[-*+]\s+\[[xX]\]',
        'lineIndex', line_index,
        'ordinal', item_index - 1
      )
    );
  end loop;
  return jsonb_build_object('schemaVersion', 1, 'checklistItems', checklist_items);
end;
$$;

create or replace function private.reconcile_parsed_items(
  previous_value jsonb,
  parsed_value jsonb,
  item_key text,
  position_key text
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  item jsonb;
  matched jsonb;
  reconciled jsonb := '[]'::jsonb;
  used_ids text[] := array[]::text[];
  identity_value text;
begin
  if jsonb_typeof(previous_value -> item_key) <> 'array' then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(previous_value -> item_key) as prior
    group by lower(regexp_replace(btrim(prior ->> 'text'), '\s+', ' ', 'g'))
    having count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;
  for item in select value from jsonb_array_elements(parsed_value -> item_key) loop
    matched := null;
    identity_value := lower(regexp_replace(btrim(item ->> 'text'), '\s+', ' ', 'g'));
    select prior into matched
    from jsonb_array_elements(previous_value -> item_key) as prior
    where lower(regexp_replace(btrim(prior ->> 'text'), '\s+', ' ', 'g')) = identity_value
      and not ((prior ->> 'id') = any(used_ids))
    limit 1;
    if matched is null then
      select prior into matched
      from jsonb_array_elements(previous_value -> item_key) as prior
      where prior ->> position_key = item ->> position_key
        and not ((prior ->> 'id') = any(used_ids))
      limit 1;
    end if;
    if matched is not null then
      item := jsonb_set(item, '{id}', to_jsonb(matched ->> 'id'));
    end if;
    used_ids := array_append(used_ids, item ->> 'id');
    reconciled := reconciled || jsonb_build_array(item);
  end loop;
  return jsonb_set(parsed_value, array[item_key], reconciled);
end;
$$;

create or replace function private.restore_note_relations(
  owner_id uuid,
  note_id_value text,
  snapshot_value jsonb,
  mutation_id_value text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tag_id_value text;
  relation jsonb;
begin
  delete from public.note_tags
  where note_id = note_id_value and user_id = owner_id;
  for tag_id_value in select jsonb_array_elements_text(snapshot_value -> 'tagIds') loop
    if exists (select 1 from public.tags where id = tag_id_value and user_id = owner_id) then
      insert into public.note_tags (note_id, tag_id, user_id, source, mutation_id)
      values (note_id_value, tag_id_value, owner_id, 'manual', mutation_id_value);
    end if;
  end loop;

  delete from public.note_links
  where from_note_id = note_id_value and user_id = owner_id;
  for relation in select value from jsonb_array_elements(snapshot_value -> 'links') loop
    if exists (
      select 1 from public.notes
      where id = relation ->> 'toNoteId'
        and user_id = owner_id
        and deleted_at is null
    ) then
      insert into public.note_links (
        user_id, from_note_id, to_note_id, link_type, source, mutation_id
      ) values (
        owner_id,
        note_id_value,
        relation ->> 'toNoteId',
        (relation ->> 'linkType')::public.link_type,
        'manual',
        mutation_id_value
      );
    end if;
  end loop;
end;
$$;

create or replace function private.jsonb_has_exact_keys(
  value jsonb,
  required_keys text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'object'
    and value ?& required_keys
    and value - required_keys = '{}'::jsonb;
$$;

create trigger note_revisions_immutable_update
before update on public.note_revisions
for each row execute function private.reject_revision_update();

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
