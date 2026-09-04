-- A log field holds one of the owner's values; the organizer files a whole capture as one entry
-- ("raw"), and a detailed workout or a day's notes runs well past 500 characters. The plan
-- schema and the preservation check accepted such an entry while the write refused it, so the
-- capture failed as provider_unavailable and Review answered "The service is busy". The bound
-- is 10,000 characters now, matching LOG_FIELD_VALUE_MAX_CHARACTERS in @unfiled/contracts and
-- the domain parser. Expand-compatible: every stored value already satisfies the wider bound.
-- The two validators are restated whole from 20260830000007 with only the bound changed.

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
      if (jsonb_typeof(field_value) = 'string' and char_length(field_value #>> '{}') > 10000)
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
          or (jsonb_typeof(field.field_value) = 'string' and char_length(field.field_value #>> '{}') > 10000)
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
