-- Milestone B reviewed note mutation, history, restore, and undo functions.
create or replace function public.create_note(
  p_idempotency_key text,
  p_type public.note_type,
  p_title text,
  p_body_markdown text default '',
  p_space_id text default null,
  p_privacy public.privacy_mode default 'ai_assisted',
  p_structured_data jsonb default null,
  p_tag_ids jsonb default '[]'::jsonb,
  p_links jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  claim jsonb;
  request_payload jsonb;
  note_row public.notes%rowtype;
  structured_value jsonb;
  body_value text := coalesce(p_body_markdown, '');
  original_body text := coalesce(p_body_markdown, '');
  projected_body text;
  is_open_value boolean := true;
  tag_id_value text;
  relation jsonb;
  relation_note_id text;
  relation_type public.link_type;
  mutation_id text := public.new_entity_id('mut');
  revision_id text;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  request_payload := jsonb_build_object(
    'type', p_type,
    'title', p_title,
    'bodyMarkdown', body_value,
    'spaceId', p_space_id,
    'privacy', p_privacy,
    'structuredData', p_structured_data,
    'tagIds', p_tag_ids,
    'links', p_links
  );
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'create_note',
    request_payload
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  if p_title is null
    or p_type is null
    or p_privacy is null
    or char_length(btrim(p_title)) not between 1 and 200
    or char_length(body_value) > 200000
    or p_tag_ids is null
    or jsonb_typeof(p_tag_ids) <> 'array'
    or jsonb_array_length(p_tag_ids) > 100
    or p_links is null
    or jsonb_typeof(p_links) <> 'array'
    or jsonb_array_length(p_links) > 100
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_space_id is not null and not exists (
    select 1
    from public.spaces
    where id = p_space_id
      and user_id = owner_id
      and archived_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  structured_value := p_structured_data;
  if p_type = 'list' then
    structured_value := coalesce(
      structured_value,
      private.list_from_markdown(body_value)
    );
    body_value := private.render_list_note(structured_value);
  elsif p_type = 'log' then
    if structured_value is null then
      structured_value := jsonb_build_object(
        'schemaVersion', 1,
        'entries', case when btrim(body_value) = '' then '[]'::jsonb else
          jsonb_build_array(jsonb_build_object(
            'id', public.new_entity_id('ent'),
            'occurredAt', clock_timestamp(),
            'fields', jsonb_build_object('text', body_value)
          )) end
      );
    end if;
    projected_body := private.render_log_note(structured_value);
    body_value := projected_body;
  elsif p_type = 'project' then
    structured_value := coalesce(
      structured_value,
      private.project_checklist_from_markdown(body_value)
    );
  else
    structured_value := coalesce(
      structured_value,
      jsonb_build_object('schemaVersion', 1)
    );
  end if;
  if not private.valid_note_structured_data(p_type, structured_value)
    or (p_structured_data is not null
      and not private.note_structure_matches_body(p_type, structured_value, original_body))
  then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;
  if p_type in ('list', 'project') then
    is_open_value := not (
      jsonb_array_length(
        structured_value -> case when p_type = 'project' then 'checklistItems' else 'items' end
      ) > 0
      and not exists (
        select 1
        from jsonb_array_elements(
          structured_value -> case when p_type = 'project' then 'checklistItems' else 'items' end
        ) as item
        where not coalesce((item ->> 'checked')::boolean, false)
      )
    );
  end if;
  insert into public.notes (
    user_id,
    space_id,
    type,
    title,
    body_markdown,
    structured_data,
    is_open,
    privacy
  )
  values (
    owner_id,
    p_space_id,
    p_type,
    btrim(p_title),
    body_value,
    structured_value,
    is_open_value,
    p_privacy
  )
  returning * into note_row;
  insert into public.note_mutations (
    id,
    user_id,
    note_id,
    idempotency_key,
    before_revision,
    after_revision,
    operations,
    inverse
  )
  values (
    mutation_id,
    owner_id,
    note_row.id,
    p_idempotency_key,
    0,
    1,
    jsonb_build_array(jsonb_build_object('type', 'create_note')),
    '{}'::jsonb
  );
  for tag_id_value in select jsonb_array_elements_text(p_tag_ids) loop
    if tag_id_value !~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$'
      or not exists (
        select 1 from public.tags
        where id = tag_id_value and user_id = owner_id
      )
    then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    insert into public.note_tags (note_id, tag_id, user_id, source, mutation_id)
    values (note_row.id, tag_id_value, owner_id, 'manual', mutation_id)
    on conflict (note_id, tag_id) do nothing;
  end loop;
  for relation in select value from jsonb_array_elements(p_links) loop
    if jsonb_typeof(relation) <> 'object'
      or (relation - array['toNoteId', 'linkType']) <> '{}'::jsonb
      or not (relation ?& array['toNoteId', 'linkType'])
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    relation_note_id := relation ->> 'toNoteId';
    begin
      relation_type := (relation ->> 'linkType')::public.link_type;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'validation_failed';
    end;
    if relation_note_id = note_row.id then
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end if;
    if not exists (
      select 1 from public.notes
      where id = relation_note_id and user_id = owner_id and deleted_at is null
    ) then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    begin
      insert into public.note_links (
        user_id, from_note_id, to_note_id, link_type, source, mutation_id
      ) values (
        owner_id, note_row.id, relation_note_id, relation_type, 'manual', mutation_id
      );
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end;
  end loop;
  update public.note_mutations
  set inverse = private.note_snapshot_with_relations(note_row)
    || jsonb_build_object('deletedAt', clock_timestamp())
  where id = mutation_id;
  revision_id := private.insert_note_revision(
    note_row,
    'manual',
    'user:manual-create',
    mutation_id
  );
  perform private.emit_user_event(owner_id, 'note', note_row.id);
  perform private.emit_user_event(owner_id, 'note_revision', revision_id);
  perform private.emit_user_event(owner_id, 'note_mutation', mutation_id);
  response_value := jsonb_build_object(
    'note', private.note_contract_json(note_row),
    'revision', (
      select private.revision_json(revision_row)
      from public.note_revisions as revision_row
      where revision_row.id = revision_id
    ),
    'mutationId', mutation_id,
    'undo', jsonb_build_object('eligible', true, 'expiresAt', null),
    'replayed', false
  );
  perform private.finish_idempotency(
    owner_id,
    p_idempotency_key,
    response_value
  );
  return response_value;
end;
$$;
create or replace function public.apply_user_note_mutation(
  p_note_id text,
  p_expected_revision integer,
  p_operations jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  claim jsonb;
  note_row public.notes%rowtype;
  before_snapshot jsonb;
  operation jsonb;
  operation_type text;
  new_title text;
  new_body text;
  new_structured jsonb;
  new_space_id text;
  new_type public.note_type;
  new_privacy public.privacy_mode;
  new_pinned_at timestamptz;
  new_archived_at timestamptz;
  new_deleted_at timestamptz;
  new_is_open boolean;
  new_tag_ids jsonb;
  new_links jsonb;
  relations_touched boolean := false;
  item_key text;
  item_id text;
  item_checked boolean;
  item_matches integer;
  updated_items jsonb;
  entry_id text;
  entry_matches integer;
  field_key text;
  updated_entries jsonb;
  project_item jsonb;
  project_line_index integer;
  project_lines text[];
  relation jsonb;
  relation_note_id text;
  tag_id_value text;
  revision_source_value public.revision_source;
  mutation_id text := public.new_entity_id('mut');
  revision_id text;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'apply_user_note_mutation',
    jsonb_build_object(
      'noteId', p_note_id,
      'expectedRevision', p_expected_revision,
      'operations', private.note_operations_idempotency_payload(p_operations)
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  if p_expected_revision is null
    or p_expected_revision < 1
    or jsonb_typeof(p_operations) <> 'array'
    or jsonb_array_length(p_operations) not between 1 and 20
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select *
  into note_row
  from public.notes
  where id = p_note_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if note_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  before_snapshot := private.note_snapshot_with_relations(note_row);
  new_title := note_row.title;
  new_body := note_row.body_markdown;
  new_structured := note_row.structured_data;
  new_space_id := note_row.space_id;
  new_type := note_row.type;
  new_privacy := note_row.privacy;
  new_pinned_at := note_row.pinned_at;
  new_archived_at := note_row.archived_at;
  new_deleted_at := note_row.deleted_at;
  new_is_open := note_row.is_open;
  new_tag_ids := before_snapshot -> 'tagIds';
  new_links := before_snapshot -> 'links';
  for operation in select value from jsonb_array_elements(p_operations) loop
    operation_type := operation ->> 'type';
    if not private.valid_user_operation_shape(operation) then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    if operation_type = 'set_title' then
      new_title := btrim(operation ->> 'title');
      if char_length(new_title) not between 1 and 200 then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
    elsif operation_type = 'replace_body_markdown' then
      new_body := coalesce(operation ->> 'bodyMarkdown', '');
      if char_length(new_body) > 200000 then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      if new_type = 'list' then
        new_structured := private.reconcile_parsed_items(
          new_structured,
          private.list_from_markdown(new_body),
          'items',
          'ordinal'
        );
      elsif new_type = 'log' then
        new_structured := private.reconcile_log_markdown(new_structured, new_body);
      elsif new_type = 'project' then
        new_structured := private.reconcile_parsed_items(
          new_structured,
          private.project_checklist_from_markdown(new_body),
          'checklistItems',
          'lineIndex'
        );
      end if;
    elsif operation_type = 'set_privacy' then
      begin
        new_privacy := (operation ->> 'privacy')::public.privacy_mode;
      exception when invalid_text_representation then
        raise exception using errcode = '22023', message = 'validation_failed';
      end;
    elsif operation_type = 'move_to_space' then
      new_space_id := nullif(operation ->> 'spaceId', '');
      if new_space_id is not null and not exists (
        select 1
        from public.spaces
        where id = new_space_id
          and user_id = owner_id
          and archived_at is null
      ) then
        raise exception using errcode = 'P0001', message = 'not_found';
      end if;
    elsif operation_type = 'set_archived' then
      if not (operation ? 'archivedAt') then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      begin
        new_archived_at := (operation ->> 'archivedAt')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'validation_failed';
      end;
    elsif operation_type = 'set_deleted' then
      if not (operation ? 'deletedAt') then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      begin
        new_deleted_at := (operation ->> 'deletedAt')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'validation_failed';
      end;
    elsif operation_type = 'restore_snapshot' then
      begin
        new_type := (operation ->> 'noteType')::public.note_type;
        new_privacy := (operation ->> 'privacy')::public.privacy_mode;
        new_is_open := (operation ->> 'isOpen')::boolean;
        new_pinned_at := (operation ->> 'pinnedAt')::timestamptz;
        new_archived_at := (operation ->> 'archivedAt')::timestamptz;
        new_deleted_at := (operation ->> 'deletedAt')::timestamptz;
      exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'validation_failed';
      end;
      new_space_id := nullif(operation ->> 'spaceId', '');
      if new_space_id is not null and not exists (
        select 1 from public.spaces where id = new_space_id and user_id = owner_id
      ) then
        raise exception using errcode = 'P0001', message = 'not_found';
      end if;
      new_title := btrim(operation ->> 'title');
      new_body := operation ->> 'bodyMarkdown';
      new_structured := operation -> 'structuredData';
      if not private.valid_note_structured_data(new_type, new_structured)
        or not private.note_structure_matches_body(new_type, new_structured, new_body)
      then
        raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      for tag_id_value in select jsonb_array_elements_text(operation -> 'tagIds') loop
        if not exists (select 1 from public.tags where id = tag_id_value and user_id = owner_id) then
          raise exception using errcode = 'P0001', message = 'not_found';
        end if;
      end loop;
      for relation in select value from jsonb_array_elements(operation -> 'links') loop
        if jsonb_typeof(relation) <> 'object'
          or (relation - array['toNoteId', 'linkType']) <> '{}'::jsonb
          or not (relation ?& array['toNoteId', 'linkType'])
        then
          raise exception using errcode = '22023', message = 'validation_failed';
        end if;
        begin perform (relation ->> 'linkType')::public.link_type;
        exception when invalid_text_representation then
          raise exception using errcode = '22023', message = 'validation_failed'; end;
        relation_note_id := relation ->> 'toNoteId';
        if relation_note_id = note_row.id then
          raise exception using errcode = 'P0001', message = 'structure_conflict';
        end if;
        if not exists (
          select 1 from public.notes
          where id = relation_note_id and user_id = owner_id and deleted_at is null
        ) then
          raise exception using errcode = 'P0001', message = 'not_found';
        end if;
      end loop;
      new_tag_ids := operation -> 'tagIds';
      new_links := operation -> 'links';
      relations_touched := true;
    elsif operation_type = 'update_log_field' then
      if new_type <> 'log'
        or jsonb_typeof(new_structured -> 'entries') <> 'array'
        or jsonb_typeof(operation -> 'fieldPath') <> 'array'
        or jsonb_array_length(operation -> 'fieldPath') <> 1
        or not (operation ? 'value')
        or jsonb_typeof(operation -> 'value') not in ('string', 'number', 'null')
      then
        raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      entry_id := operation ->> 'entryId';
      field_key := operation -> 'fieldPath' ->> 0;
      if entry_id is null
        or field_key is null
        or char_length(btrim(field_key)) not between 1 and 80
      then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      select count(*) into entry_matches
      from jsonb_array_elements(new_structured -> 'entries') as entry
      where entry ->> 'id' = entry_id;
      if entry_matches <> 1 then
        raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      select jsonb_agg(
        case when entry ->> 'id' = entry_id
          then jsonb_set(
            entry,
            array['fields', btrim(field_key)],
            operation -> 'value',
            true
          )
          else entry end
        order by entry ->> 'occurredAt', entry ->> 'id'
      )
      into updated_entries
      from jsonb_array_elements(new_structured -> 'entries') as entry;
      new_structured := jsonb_set(
        new_structured,
        '{entries}',
        updated_entries
      );
    elsif operation_type in ('toggle_item_checked', 'edit_item_text', 'remove_item') then
      item_key := case when new_type = 'project' then 'checklistItems' else 'items' end;
      if new_type not in ('list', 'project')
        or jsonb_typeof(new_structured -> item_key) <> 'array'
      then
        raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      item_id := operation ->> 'itemId';
      select count(*) into item_matches
      from jsonb_array_elements(new_structured -> item_key) as item
      where item ->> 'id' = item_id;
      if item_matches <> 1 then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      if new_type = 'project' then
        select item into project_item
        from jsonb_array_elements(new_structured -> item_key) as item
        where item ->> 'id' = item_id;
        project_line_index := (project_item ->> 'lineIndex')::integer;
        project_lines := string_to_array(new_body, E'\n');
        if project_line_index < 0
          or project_line_index + 1 > coalesce(array_length(project_lines, 1), 0)
          or project_lines[project_line_index + 1] !~ '^\s*[-*+]\s+\[[ xX]\]\s+'
          or regexp_replace(
            project_lines[project_line_index + 1],
            '^\s*[-*+]\s+\[[ xX]\]\s+',
            ''
          ) <> (project_item ->> 'text')
        then
          raise exception using errcode = 'P0001', message = 'structure_conflict';
        end if;
      end if;
      if operation_type = 'remove_item' then
        select coalesce(
          jsonb_agg(
            case when new_type = 'project' then
              jsonb_set(
                jsonb_set(item, '{ordinal}', to_jsonb(new_ordinal)),
                '{lineIndex}',
                to_jsonb(
                  (item ->> 'lineIndex')::integer
                    - case when (item ->> 'lineIndex')::integer > project_line_index then 1 else 0 end
                )
              )
            else jsonb_set(item, '{ordinal}', to_jsonb(new_ordinal)) end
            order by new_ordinal
          ),
          '[]'::jsonb
        )
        into updated_items
        from (
          select
            item,
            row_number() over (order by (item ->> 'ordinal')::integer, item ->> 'id') - 1
              as new_ordinal
          from jsonb_array_elements(new_structured -> item_key) as item
          where item ->> 'id' <> item_id
        ) as retained;
      elsif operation_type = 'edit_item_text' then
        if char_length(btrim(operation ->> 'text')) not between 1 and 500 then
          raise exception using errcode = '22023', message = 'validation_failed';
        end if;
        select jsonb_agg(
          case when item ->> 'id' = item_id
            then jsonb_set(item, '{text}', to_jsonb(btrim(operation ->> 'text')))
            else item end
          order by (item ->> 'ordinal')::integer
        )
        into updated_items
        from jsonb_array_elements(new_structured -> item_key) as item;
      else
        if jsonb_typeof(operation -> 'checked') <> 'boolean' then
          raise exception using errcode = '22023', message = 'validation_failed';
        end if;
        item_checked := (operation ->> 'checked')::boolean;
        select jsonb_agg(
          case when item ->> 'id' = item_id then
            jsonb_set(item, '{checked}', to_jsonb(item_checked))
          else item end
          order by (item ->> 'ordinal')::integer
        )
        into updated_items
        from jsonb_array_elements(new_structured -> item_key) as item;
      end if;
      new_structured := jsonb_set(new_structured, array[item_key], updated_items);
      if new_type = 'project' then
        if operation_type = 'remove_item' then
          select coalesce(array_agg(line order by ordinal), array[]::text[])
          into project_lines
          from unnest(project_lines) with ordinality as source(line, ordinal)
          where ordinal <> project_line_index + 1;
        else
          select item into project_item
          from jsonb_array_elements(new_structured -> item_key) as item
          where item ->> 'id' = item_id;
          project_lines[project_line_index + 1] := regexp_replace(
            project_lines[project_line_index + 1],
            '^([[:space:]]*[-*+][[:space:]]+\[)[ xX](\])',
            '\1' || case when (project_item ->> 'checked')::boolean then 'x' else ' ' end || '\2'
          );
          if operation_type = 'edit_item_text' then
            project_lines[project_line_index + 1] := regexp_replace(
              project_lines[project_line_index + 1],
              '^([[:space:]]*[-*+][[:space:]]+\[[ xX]\][[:space:]]+).*$',
              '\1' || (project_item ->> 'text')
            );
          end if;
        end if;
        new_body := array_to_string(project_lines, E'\n');
      end if;
    elsif operation_type = 'set_tags' then
      if jsonb_typeof(operation -> 'tagIds') <> 'array'
        or jsonb_array_length(operation -> 'tagIds') > 100
      then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      for tag_id_value in select jsonb_array_elements_text(operation -> 'tagIds') loop
        if tag_id_value !~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$'
          or not exists (
          select 1 from public.tags
          where id = tag_id_value and user_id = owner_id
        ) then
          raise exception using errcode = 'P0001', message = 'not_found';
        end if;
      end loop;
      select coalesce(jsonb_agg(tag_id order by tag_id), '[]'::jsonb)
      into new_tag_ids
      from (
        select distinct value #>> '{}' as tag_id
        from jsonb_array_elements(operation -> 'tagIds')
      ) as tags;
      relations_touched := true;
    elsif operation_type = 'set_note_links' then
      if jsonb_typeof(operation -> 'links') <> 'array'
        or jsonb_array_length(operation -> 'links') > 100
      then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      for relation in select value from jsonb_array_elements(operation -> 'links') loop
        if jsonb_typeof(relation) <> 'object'
          or (relation - array['toNoteId', 'linkType']) <> '{}'::jsonb
          or not (relation ?& array['toNoteId', 'linkType'])
        then
          raise exception using errcode = '22023', message = 'validation_failed';
        end if;
        relation_note_id := relation ->> 'toNoteId';
        begin
          perform (relation ->> 'linkType')::public.link_type;
        exception when invalid_text_representation then
          raise exception using errcode = '22023', message = 'validation_failed';
        end;
        if relation_note_id = note_row.id then
          raise exception using errcode = 'P0001', message = 'structure_conflict';
        end if;
        if not exists (
          select 1 from public.notes
          where id = relation_note_id
            and user_id = owner_id
            and deleted_at is null
        ) then
          raise exception using errcode = 'P0001', message = 'not_found';
        end if;
      end loop;
      if (
        select count(*) <> count(distinct (value ->> 'toNoteId') || ':' || (value ->> 'linkType'))
        from jsonb_array_elements(operation -> 'links')
      ) then
        raise exception using errcode = 'P0001', message = 'structure_conflict';
      end if;
      new_links := operation -> 'links';
      relations_touched := true;
    else
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  end loop;
  if new_type = 'list' then
    new_body := private.render_list_note(new_structured);
  elsif new_type = 'log' then
    new_body := private.render_log_note(new_structured);
  end if;
  if not private.valid_note_structured_data(new_type, new_structured) then
    raise exception using errcode = 'P0001', message = 'structure_conflict';
  end if;
  if new_type in ('list', 'project') then
    item_key := case when new_type = 'project' then 'checklistItems' else 'items' end;
    new_is_open := not (
      jsonb_array_length(new_structured -> item_key) > 0
      and not exists (
        select 1
        from jsonb_array_elements(new_structured -> item_key) as item
        where not coalesce((item ->> 'checked')::boolean, false)
      )
    );
  end if;
  update public.notes
  set
    space_id = new_space_id,
    type = new_type,
    title = new_title,
    body_markdown = new_body,
    structured_data = new_structured,
    current_revision = current_revision + 1,
    is_open = new_is_open,
    pinned_at = new_pinned_at,
    privacy = new_privacy,
    archived_at = new_archived_at,
    deleted_at = new_deleted_at
  where id = note_row.id
  returning * into note_row;
  insert into public.note_mutations (
    id,
    user_id,
    note_id,
    idempotency_key,
    before_revision,
    after_revision,
    operations,
    inverse
  )
  values (
    mutation_id,
    owner_id,
    note_row.id,
    p_idempotency_key,
    p_expected_revision,
    note_row.current_revision,
    p_operations,
    before_snapshot
  );
  if relations_touched then
    perform private.restore_note_relations(
      owner_id,
      note_row.id,
      jsonb_build_object('tagIds', new_tag_ids, 'links', new_links),
      mutation_id
    );
  end if;
  if auth.role() = 'service_role'
    and current_setting('unfiled.revision_source', true) = 'organization'
  then revision_source_value := 'organization';
  else
    select case when bool_and(value ->> 'type' in (
      'toggle_item_checked', 'update_log_field', 'edit_item_text', 'remove_item'
    )) then 'interactive' else 'manual' end::public.revision_source
    into revision_source_value from jsonb_array_elements(p_operations);
  end if;
  revision_id := private.insert_note_revision(
    note_row,
    revision_source_value,
    case when revision_source_value = 'organization'
      then coalesce(nullif(current_setting('unfiled.revision_actor', true), ''), 'organization:unknown')
      else 'user:' || revision_source_value::text end,
    mutation_id
  );
  perform private.emit_user_event(owner_id, 'note', note_row.id);
  perform private.emit_user_event(owner_id, 'note_revision', revision_id);
  perform private.emit_user_event(owner_id, 'note_mutation', mutation_id);
  response_value := jsonb_build_object(
    'note', private.note_contract_json(note_row),
    'revision', (
      select private.revision_json(revision_row)
      from public.note_revisions as revision_row
      where revision_row.id = revision_id
    ),
    'mutationId', mutation_id,
    'undo', jsonb_build_object('eligible', true, 'expiresAt', null),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;
