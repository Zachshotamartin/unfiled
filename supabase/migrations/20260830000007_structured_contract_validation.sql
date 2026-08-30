-- Enforce the frozen NoteStructuredData discriminated union at storage boundaries.

create or replace function private.valid_iso_offset_datetime(value text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if value is null or value !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
    return false;
  end if;
  perform value::timestamptz;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function private.valid_contract_number(value jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
set extra_float_digits = 3
as $$
declare parsed_value double precision;
begin
  if jsonb_typeof(value) <> 'number' then return false; end if;
  parsed_value := (value #>> '{}')::double precision;
  return to_jsonb(parsed_value) = value;
exception when others then
  return false;
end;
$$;

create or replace function private.valid_typed_id_array(value jsonb, prefix_value text, maximum_items integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'array'
    and jsonb_array_length(value) <= maximum_items
    and not exists (
      select 1 from jsonb_array_elements(value) as item
      where jsonb_typeof(item) <> 'string'
        or item #>> '{}' !~ ('^' || prefix_value || '_[0-9A-HJKMNP-TV-Z]{26}$')
    );
$$;

create or replace function private.valid_note_link_values(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'array'
    and jsonb_array_length(value) <= 100
    and not exists (
      select 1 from jsonb_array_elements(value) as link
      where jsonb_typeof(link) <> 'object'
        or not private.jsonb_has_exact_keys(link, array['toNoteId', 'linkType'])
        or jsonb_typeof(link -> 'toNoteId') <> 'string'
        or link ->> 'toNoteId' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
        or jsonb_typeof(link -> 'linkType') <> 'string'
        or link ->> 'linkType' not in ('reference', 'related')
    );
$$;

create or replace function private.note_structure_matches_body(
  note_kind public.note_type,
  structured_value jsonb,
  body_value text
)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
begin
  if note_kind = 'list' then
    return body_value = private.render_list_note(structured_value);
  elsif note_kind = 'log' then
    return body_value = private.render_log_note(structured_value);
  elsif note_kind = 'project' then
    return structured_value = private.reconcile_parsed_items(
      structured_value,
      private.project_checklist_from_markdown(body_value),
      'checklistItems',
      'lineIndex'
    );
  end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function private.valid_user_operation_shape(operation jsonb)
returns boolean
language plpgsql
volatile
set search_path = ''
set extra_float_digits = 3
as $$
declare
  operation_type text;
  item jsonb;
  note_kind public.note_type;
begin
  if jsonb_typeof(operation) <> 'object' then return false; end if;
  operation_type := operation ->> 'type';
  if operation_type = 'set_title' then
    return private.jsonb_has_exact_keys(operation, array['type', 'title'])
      and jsonb_typeof(operation -> 'title') = 'string'
      and char_length(btrim(operation ->> 'title')) between 1 and 200;
  elsif operation_type = 'replace_body_markdown' then
    return private.jsonb_has_exact_keys(operation, array['type', 'bodyMarkdown'])
      and jsonb_typeof(operation -> 'bodyMarkdown') = 'string'
      and char_length(operation ->> 'bodyMarkdown') <= 200000;
  elsif operation_type = 'set_privacy' then
    return private.jsonb_has_exact_keys(operation, array['type', 'privacy'])
      and jsonb_typeof(operation -> 'privacy') = 'string'
      and operation ->> 'privacy' in ('ai_assisted', 'private_manual');
  elsif operation_type = 'move_to_space' then
    return private.jsonb_has_exact_keys(operation, array['type', 'spaceId'])
      and jsonb_typeof(operation -> 'spaceId') in ('string', 'null')
      and (jsonb_typeof(operation -> 'spaceId') = 'null'
        or operation ->> 'spaceId' ~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$');
  elsif operation_type in ('set_archived', 'set_deleted') then
    return private.jsonb_has_exact_keys(
      operation,
      array['type', case when operation_type = 'set_archived' then 'archivedAt' else 'deletedAt' end]
    ) and jsonb_typeof(operation -> case when operation_type = 'set_archived' then 'archivedAt' else 'deletedAt' end) in ('string', 'null')
      and (jsonb_typeof(operation -> case when operation_type = 'set_archived' then 'archivedAt' else 'deletedAt' end) = 'null'
        or private.valid_iso_offset_datetime(operation ->> case when operation_type = 'set_archived' then 'archivedAt' else 'deletedAt' end));
  elsif operation_type = 'set_tags' then
    return private.jsonb_has_exact_keys(operation, array['type', 'tagIds'])
      and private.valid_typed_id_array(operation -> 'tagIds', 'tag', 100);
  elsif operation_type = 'set_note_links' then
    return private.jsonb_has_exact_keys(operation, array['type', 'links'])
      and private.valid_note_link_values(operation -> 'links');
  elsif operation_type = 'toggle_item_checked' then
    return private.jsonb_has_exact_keys(operation, array['type', 'itemId', 'checked'])
      and jsonb_typeof(operation -> 'itemId') = 'string'
      and operation ->> 'itemId' ~ '^itm_[0-9A-HJKMNP-TV-Z]{26}$'
      and jsonb_typeof(operation -> 'checked') = 'boolean';
  elsif operation_type = 'update_log_field' then
    if not private.jsonb_has_exact_keys(operation, array['type', 'entryId', 'fieldPath', 'value'])
      or jsonb_typeof(operation -> 'entryId') <> 'string'
      or operation ->> 'entryId' !~ '^ent_[0-9A-HJKMNP-TV-Z]{26}$'
      or jsonb_typeof(operation -> 'fieldPath') <> 'array'
      or jsonb_array_length(operation -> 'fieldPath') not between 1 and 8
      or exists (
        select 1 from jsonb_array_elements(operation -> 'fieldPath') as path_part
        where jsonb_typeof(path_part) <> 'string'
          or char_length(btrim(path_part #>> '{}')) not between 1 and 80
      )
    then return false;
    end if;
    return (jsonb_typeof(operation -> 'value') = 'string'
        and char_length(operation ->> 'value') <= 500)
      or jsonb_typeof(operation -> 'value') = 'null'
      or private.valid_contract_number(operation -> 'value');
  elsif operation_type = 'edit_item_text' then
    return private.jsonb_has_exact_keys(operation, array['type', 'itemId', 'text'])
      and jsonb_typeof(operation -> 'itemId') = 'string'
      and operation ->> 'itemId' ~ '^itm_[0-9A-HJKMNP-TV-Z]{26}$'
      and jsonb_typeof(operation -> 'text') = 'string'
      and char_length(btrim(operation ->> 'text')) between 1 and 500
      and operation ->> 'text' !~ E'[\r\n]';
  elsif operation_type = 'remove_item' then
    return private.jsonb_has_exact_keys(operation, array['type', 'itemId'])
      and jsonb_typeof(operation -> 'itemId') = 'string'
      and operation ->> 'itemId' ~ '^itm_[0-9A-HJKMNP-TV-Z]{26}$';
  elsif operation_type <> 'restore_snapshot'
    or not private.jsonb_has_exact_keys(operation, array[
      'type', 'spaceId', 'noteType', 'title', 'bodyMarkdown', 'structuredData',
      'privacy', 'isOpen', 'pinnedAt', 'archivedAt', 'deletedAt', 'tagIds', 'links'
    ])
  then return false;
  end if;
  if jsonb_typeof(operation -> 'noteType') <> 'string'
    or operation ->> 'noteType' not in ('generic', 'list', 'log', 'principle', 'project')
    or jsonb_typeof(operation -> 'title') <> 'string'
    or char_length(operation ->> 'title') not between 1 and 200
    or jsonb_typeof(operation -> 'bodyMarkdown') <> 'string'
    or char_length(operation ->> 'bodyMarkdown') > 200000
    or jsonb_typeof(operation -> 'privacy') <> 'string'
    or operation ->> 'privacy' not in ('ai_assisted', 'private_manual')
    or jsonb_typeof(operation -> 'isOpen') <> 'boolean'
    or jsonb_typeof(operation -> 'spaceId') not in ('string', 'null')
    or (jsonb_typeof(operation -> 'spaceId') = 'string'
      and operation ->> 'spaceId' !~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$')
    or not private.valid_typed_id_array(operation -> 'tagIds', 'tag', 100)
    or not private.valid_note_link_values(operation -> 'links')
  then return false;
  end if;
  foreach item in array array[operation -> 'pinnedAt', operation -> 'archivedAt', operation -> 'deletedAt'] loop
    if jsonb_typeof(item) not in ('string', 'null')
      or (jsonb_typeof(item) = 'string' and not private.valid_iso_offset_datetime(item #>> '{}'))
    then return false;
    end if;
  end loop;
  note_kind := (operation ->> 'noteType')::public.note_type;
  return private.valid_note_structured_data(note_kind, operation -> 'structuredData');
exception when others then
  return false;
end;
$$;

create or replace function private.reconcile_log_markdown(
  previous_value jsonb,
  body_value text
)
returns jsonb
language plpgsql
volatile
set search_path = ''
set extra_float_digits = 3
as $$
declare
  source_line text;
  occurred_at text;
  entry_id text;
  field_key text;
  field_text text;
  field_value jsonb;
  fields_value jsonb := '{}'::jsonb;
  entries_value jsonb := '[]'::jsonb;
  seen_times text[] := array[]::text[];
  occurrence_index integer;
begin
  if jsonb_typeof(previous_value -> 'entries') <> 'array' then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;
  foreach source_line in array string_to_array(coalesce(body_value, ''), E'\n') loop
    if btrim(source_line) = '' then continue; end if;
    if source_line ~ '^##\s+\S' then
      if occurred_at is not null then
        entries_value := entries_value || jsonb_build_array(jsonb_build_object(
          'id', entry_id, 'occurredAt', occurred_at, 'fields', fields_value
        ));
      end if;
      occurred_at := btrim(regexp_replace(source_line, '^##\s+', ''));
      if not private.valid_iso_offset_datetime(occurred_at) then
        raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      select count(*) into occurrence_index
      from unnest(seen_times) as seen(value)
      where value = occurred_at;
      seen_times := array_append(seen_times, occurred_at);
      select entry ->> 'id' into entry_id
      from jsonb_array_elements(previous_value -> 'entries') as entry
      where entry ->> 'occurredAt' = occurred_at
      order by entry ->> 'id'
      offset occurrence_index
      limit 1;
      entry_id := coalesce(entry_id, public.new_entity_id('ent'));
      fields_value := '{}'::jsonb;
    elsif source_line ~ '^\s*-\s+[^:]+:\s*.*$' and occurred_at is not null then
      field_key := btrim(substring(source_line from '^\s*-\s+([^:]+):'));
      field_text := regexp_replace(source_line, '^\s*-\s+[^:]+:\s*', '');
      if char_length(field_key) not between 1 and 80
        or fields_value ? field_key
      then raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      if field_text ~ '^".*"$' then
        begin field_value := field_text::jsonb;
        exception when others then
          raise exception using errcode = 'P0001', message = 'structure_conflict'; end;
        if jsonb_typeof(field_value) <> 'string' then
          raise exception using errcode = 'P0001', message = 'structure_conflict';
        end if;
      elsif field_text = 'null' then field_value := 'null'::jsonb;
      elsif field_text ~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' then
        begin field_value := to_jsonb(field_text::double precision);
        exception when others then
          raise exception using errcode = 'P0001', message = 'structure_conflict'; end;
      else field_value := to_jsonb(field_text);
      end if;
      if (jsonb_typeof(field_value) = 'string' and char_length(field_value #>> '{}') > 500)
        or (jsonb_typeof(field_value) = 'number' and not private.valid_contract_number(field_value))
      then raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      fields_value := jsonb_set(fields_value, array[field_key], field_value, true);
    else
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end if;
  end loop;
  if occurred_at is not null then
    entries_value := entries_value || jsonb_build_array(jsonb_build_object(
      'id', entry_id, 'occurredAt', occurred_at, 'fields', fields_value
    ));
  elsif btrim(coalesce(body_value, '')) <> '' then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;
  return jsonb_build_object('schemaVersion', 1, 'entries', entries_value);
end;
$$;

create or replace function private.valid_note_structured_data(
  note_kind public.note_type,
  value jsonb
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  item jsonb;
  field record;
  item_key text;
  seen_ids text[] := array[]::text[];
begin
  if jsonb_typeof(value) <> 'object'
    or value ->> 'schemaVersion' <> '1'
  then return false;
  end if;

  if note_kind in ('generic', 'principle') then
    return value - 'schemaVersion' = '{}'::jsonb;
  end if;
  if note_kind = 'log' then
    if value - array['schemaVersion', 'entries'] <> '{}'::jsonb
      or jsonb_typeof(value -> 'entries') <> 'array'
      or jsonb_array_length(value -> 'entries') > 2000
    then return false;
    end if;
    for item in select entry from jsonb_array_elements(value -> 'entries') as entry loop
      if not private.jsonb_has_exact_keys(item, array['id', 'occurredAt', 'fields'])
        or item ->> 'id' !~ '^ent_[0-9A-HJKMNP-TV-Z]{26}$'
        or item ->> 'id' = any(seen_ids)
        or jsonb_typeof(item -> 'occurredAt') <> 'string'
        or not private.valid_iso_offset_datetime(item ->> 'occurredAt')
        or jsonb_typeof(item -> 'fields') <> 'object'
        or (select count(*) from jsonb_object_keys(item -> 'fields')) > 50
      then return false;
      end if;
      perform (item ->> 'occurredAt')::timestamptz;
      seen_ids := array_append(seen_ids, item ->> 'id');
      for field in select key, field_value from jsonb_each(item -> 'fields') as pair(key, field_value) loop
        if field.key <> btrim(field.key)
          or char_length(field.key) not between 1 and 80
          or field.key ~ E'[:\r\n]'
          or jsonb_typeof(field.field_value) not in ('string', 'number', 'null')
          or (jsonb_typeof(field.field_value) = 'string' and char_length(field.field_value #>> '{}') > 500)
          or (jsonb_typeof(field.field_value) = 'number' and not private.valid_contract_number(field.field_value))
        then return false;
        end if;
      end loop;
    end loop;
    return true;
  end if;

  item_key := case when note_kind = 'project' then 'checklistItems' else 'items' end;
  if value - array['schemaVersion', item_key] <> '{}'::jsonb
    or jsonb_typeof(value -> item_key) <> 'array'
    or jsonb_array_length(value -> item_key) > 2000
  then return false;
  end if;
  for item in select entry from jsonb_array_elements(value -> item_key) as entry loop
    if not private.jsonb_has_exact_keys(
      item,
      case when note_kind = 'project'
        then array['id', 'text', 'checked', 'ordinal', 'lineIndex']
        else array['id', 'text', 'checked', 'ordinal', 'section'] end
    )
      or item ->> 'id' !~ '^itm_[0-9A-HJKMNP-TV-Z]{26}$'
      or item ->> 'id' = any(seen_ids)
      or jsonb_typeof(item -> 'text') <> 'string'
      or char_length(btrim(item ->> 'text')) not between 1 and 500
      or item ->> 'text' ~ E'[\r\n]'
      or jsonb_typeof(item -> 'checked') <> 'boolean'
      or jsonb_typeof(item -> 'ordinal') <> 'number'
      or item ->> 'ordinal' !~ '^\d+$'
      or (note_kind = 'project' and (
        jsonb_typeof(item -> 'lineIndex') <> 'number' or item ->> 'lineIndex' !~ '^\d+$'
      ))
      or (note_kind = 'list' and (
        jsonb_typeof(item -> 'section') not in ('string', 'null')
        or (jsonb_typeof(item -> 'section') = 'string'
          and (item ->> 'section' <> btrim(item ->> 'section')
            or char_length(item ->> 'section') not between 1 and 100))
      ))
    then return false;
    end if;
    seen_ids := array_append(seen_ids, item ->> 'id');
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

alter table public.notes
  add constraint notes_structured_data_contract
  check (private.valid_note_structured_data(type, structured_data));

alter table public.note_revisions
  add constraint note_revisions_structured_data_contract
  check (private.valid_note_structured_data(type, structured_data));

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
