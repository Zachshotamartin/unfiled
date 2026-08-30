-- Milestone B space/tag RPCs and final direct-write lockdown.

create or replace function private.normalized_slug(name_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(both '-' from regexp_replace(
    lower(btrim(name_value)),
    '[^a-z0-9]+',
    '-',
    'g'
  ));
$$;

create or replace function public.create_space(
  p_idempotency_key text,
  p_name text,
  p_parent_id text default null,
  p_slug text default null,
  p_sort_key text default 'a0'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  claim jsonb;
  space_row public.spaces%rowtype;
  slug_value text;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'create_space',
    jsonb_build_object(
      'name', p_name,
      'parentId', p_parent_id,
      'slug', p_slug,
      'sortKey', p_sort_key
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;

  if p_name is null
    or char_length(btrim(p_name)) not between 1 and 60
    or char_length(p_sort_key) not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_parent_id is not null and not exists (
    select 1 from public.spaces
    where id = p_parent_id
      and user_id = owner_id
      and parent_id is null
      and archived_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  slug_value := coalesce(nullif(private.normalized_slug(p_slug), ''), private.normalized_slug(p_name));
  if char_length(slug_value) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  begin
    insert into public.spaces (user_id, parent_id, name, slug, sort_key)
    values (owner_id, p_parent_id, btrim(p_name), slug_value, p_sort_key)
    returning * into space_row;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'conflict_requires_review';
  end;

  perform private.emit_user_event(owner_id, 'space', space_row.id);
  response_value := jsonb_build_object(
    'space', private.space_json(space_row),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

create or replace function public.update_space(
  p_space_id text,
  p_expected_revision integer,
  p_patch jsonb,
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
  space_row public.spaces%rowtype;
  parent_value text;
  name_value text;
  slug_value text;
  sort_value text;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'update_space',
    jsonb_build_object(
      'spaceId', p_space_id,
      'expectedRevision', p_expected_revision,
      'patch', p_patch
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  if jsonb_typeof(p_patch) <> 'object'
    or p_expected_revision is null
    or p_expected_revision < 1
    or p_patch = '{}'::jsonb
    or (p_patch - array['name', 'parentId', 'slug', 'sortKey']) <> '{}'::jsonb
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into space_row from public.spaces
  where id = p_space_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if space_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  name_value := case when p_patch ? 'name' then btrim(p_patch ->> 'name') else space_row.name end;
  parent_value := case when p_patch ? 'parentId' then nullif(p_patch ->> 'parentId', '') else space_row.parent_id end;
  slug_value := case when p_patch ? 'slug' then private.normalized_slug(p_patch ->> 'slug') else space_row.slug end;
  sort_value := case when p_patch ? 'sortKey' then p_patch ->> 'sortKey' else space_row.sort_key end;
  if char_length(name_value) not between 1 and 60
    or char_length(slug_value) not between 1 and 80
    or char_length(sort_value) not between 1 and 100
    or parent_value = space_row.id
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if parent_value is not null and not exists (
    select 1 from public.spaces
    where id = parent_value
      and user_id = owner_id
      and parent_id is null
      and archived_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  begin
    update public.spaces
    set
      name = name_value,
      parent_id = parent_value,
      slug = slug_value,
      sort_key = sort_value,
      current_revision = current_revision + 1
    where id = space_row.id
    returning * into space_row;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'conflict_requires_review';
  end;

  perform private.emit_user_event(owner_id, 'space', space_row.id);
  response_value := jsonb_build_object(
    'space', private.space_json(space_row),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

create or replace function public.archive_space(
  p_space_id text,
  p_expected_revision integer,
  p_archived boolean,
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
  space_row public.spaces%rowtype;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'archive_space',
    jsonb_build_object(
      'spaceId', p_space_id,
      'expectedRevision', p_expected_revision,
      'archived', p_archived
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  if p_expected_revision is null or p_expected_revision < 1 or p_archived is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into space_row from public.spaces
  where id = p_space_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if space_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  update public.spaces
  set
    archived_at = case when p_archived then now() else null end,
    current_revision = current_revision + 1
  where id = space_row.id
  returning * into space_row;
  perform private.emit_user_event(owner_id, 'space', space_row.id);
  response_value := jsonb_build_object(
    'space', private.space_json(space_row),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

create or replace function public.create_tag(
  p_idempotency_key text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  claim jsonb;
  tag_row public.tags%rowtype;
  name_value text := lower(btrim(p_name));
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'create_tag',
    jsonb_build_object('name', name_value)
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  if char_length(name_value) not between 1 and 40 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  begin
    insert into public.tags (user_id, name)
    values (owner_id, name_value)
    returning * into tag_row;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'conflict_requires_review';
  end;
  perform private.emit_user_event(owner_id, 'tag', tag_row.id);
  response_value := jsonb_build_object(
    'tag', private.tag_json(tag_row),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

create or replace function public.update_tag(
  p_tag_id text,
  p_expected_revision integer,
  p_name text,
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
  tag_row public.tags%rowtype;
  name_value text := lower(btrim(p_name));
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'update_tag',
    jsonb_build_object(
      'tagId', p_tag_id,
      'expectedRevision', p_expected_revision,
      'name', name_value
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if char_length(name_value) not between 1 and 40 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into tag_row from public.tags
  where id = p_tag_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if tag_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  begin
    update public.tags
    set name = name_value, current_revision = current_revision + 1
    where id = tag_row.id
    returning * into tag_row;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'conflict_requires_review';
  end;

  perform private.emit_user_event(owner_id, 'tag', tag_row.id);
  response_value := jsonb_build_object(
    'tag', private.tag_json(tag_row),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

create or replace function public.delete_tag(
  p_tag_id text,
  p_expected_revision integer,
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
  tag_row public.tags%rowtype;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'delete_tag',
    jsonb_build_object('tagId', p_tag_id, 'expectedRevision', p_expected_revision)
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into tag_row from public.tags
  where id = p_tag_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if tag_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  delete from public.tags where id = tag_row.id;
  perform private.emit_user_event(owner_id, 'tag_deleted', tag_row.id);
  response_value := jsonb_build_object(
    'deletedId', tag_row.id,
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

-- All Milestone B entity writes use reviewed RPCs. Removing both policies and
-- grants ensures a future accidental grant cannot revive a permissive path.
drop policy if exists spaces_insert on public.spaces;
drop policy if exists spaces_update on public.spaces;
drop policy if exists spaces_delete on public.spaces;
drop policy if exists notes_insert on public.notes;
drop policy if exists notes_update on public.notes;
drop policy if exists notes_delete on public.notes;
drop policy if exists note_revisions_insert on public.note_revisions;
drop policy if exists captures_delete on public.captures;
drop policy if exists generated_blocks_insert on public.generated_blocks;
drop policy if exists generated_blocks_update on public.generated_blocks;
drop policy if exists generated_blocks_delete on public.generated_blocks;
drop policy if exists capture_note_links_insert on public.capture_note_links;
drop policy if exists capture_note_links_update on public.capture_note_links;
drop policy if exists capture_note_links_delete on public.capture_note_links;
drop policy if exists routing_rules_insert on public.routing_rules;
drop policy if exists routing_rules_update on public.routing_rules;
drop policy if exists routing_rules_delete on public.routing_rules;
drop policy if exists review_items_insert on public.review_items;
drop policy if exists review_items_update on public.review_items;
drop policy if exists review_items_delete on public.review_items;
drop policy if exists tags_insert on public.tags;
drop policy if exists tags_update on public.tags;
drop policy if exists tags_delete on public.tags;
drop policy if exists note_tags_insert on public.note_tags;
drop policy if exists note_tags_update on public.note_tags;
drop policy if exists note_tags_delete on public.note_tags;
drop policy if exists note_links_insert on public.note_links;
drop policy if exists note_links_update on public.note_links;
drop policy if exists note_links_delete on public.note_links;

revoke insert, update, delete on table
  public.spaces,
  public.notes,
  public.note_revisions,
  public.captures,
  public.generated_blocks,
  public.capture_note_links,
  public.routing_rules,
  public.review_items,
  public.tags,
  public.note_tags,
  public.note_links
from authenticated;

revoke execute on function public.create_space(text, text, text, text, text)
  from public, anon;
revoke execute on function public.update_space(text, integer, jsonb, text)
  from public, anon;
revoke execute on function public.archive_space(text, integer, boolean, text)
  from public, anon;
revoke execute on function public.create_tag(text, text) from public, anon;
revoke execute on function public.update_tag(text, integer, text, text)
  from public, anon;
revoke execute on function public.delete_tag(text, integer, text)
  from public, anon;

grant execute on function public.create_space(text, text, text, text, text)
  to authenticated, service_role;
grant execute on function public.update_space(text, integer, jsonb, text)
  to authenticated, service_role;
grant execute on function public.archive_space(text, integer, boolean, text)
  to authenticated, service_role;
grant execute on function public.create_tag(text, text)
  to authenticated, service_role;
grant execute on function public.update_tag(text, integer, text, text)
  to authenticated, service_role;
grant execute on function public.delete_tag(text, integer, text)
  to authenticated, service_role;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
