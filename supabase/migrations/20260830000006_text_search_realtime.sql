-- Milestone B user-scoped text search and realtime cursor publication.

create or replace function public.search_notes(
  p_query text,
  p_archive_filter text default 'exclude',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  note_id text,
  title text,
  snippet text,
  space_path text,
  updated_at timestamptz,
  rank double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  normalized_query text := lower(btrim(p_query));
  search_query tsquery;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  if normalized_query is null
    or normalized_query = ''
    or char_length(normalized_query) > 200
    or p_archive_filter is null
    or p_archive_filter not in ('exclude', 'include', 'only')
    or p_limit is null
    or p_limit not between 1 and 100
    or p_offset is null
    or p_offset not between 0 and 100000
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  search_query := websearch_to_tsquery('simple', p_query);

  return query
  select
    note_record.id,
    note_record.title,
    left(
      regexp_replace(note_record.body_markdown, '[[:space:]]+', ' ', 'g'),
      240
    ),
    case
      when child_space.id is null then null
      else concat_ws(' / ', parent_space.name, child_space.name)
    end,
    note_record.updated_at,
    (
      case
        when lower(note_record.title) = normalized_query then 400.0
        when lower(note_record.title) like normalized_query || '%' then 300.0
        when lower(note_record.title) like '% ' || normalized_query || '%' then 250.0
        else 100.0
      end
      + ts_rank(
        to_tsvector('simple', note_record.title || ' ' || note_record.body_markdown),
        search_query
      )::double precision
    ) as result_rank
  from public.notes as note_record
  left join public.spaces as child_space
    on child_space.id = note_record.space_id
    and child_space.user_id = owner_id
  left join public.spaces as parent_space
    on parent_space.id = child_space.parent_id
    and parent_space.user_id = owner_id
  where note_record.user_id = owner_id
    and note_record.deleted_at is null
    and (
      p_archive_filter = 'include'
      or (p_archive_filter = 'exclude' and note_record.archived_at is null)
      or (p_archive_filter = 'only' and note_record.archived_at is not null)
    )
    and (
      lower(note_record.title) = normalized_query
      or lower(note_record.title) like normalized_query || '%'
      or lower(note_record.title) like '% ' || normalized_query || '%'
      or lower(note_record.body_markdown) like '%' || normalized_query || '%'
      or to_tsvector(
        'simple',
        note_record.title || ' ' || note_record.body_markdown
      ) @@ search_query
    )
  order by result_rank desc, note_record.updated_at desc, note_record.id
  limit p_limit
  offset p_offset;
end;
$$;

revoke execute on function public.search_notes(text, text, integer, integer)
  from public, anon;
grant execute on function public.search_notes(text, text, integer, integer)
  to authenticated, service_role;

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'user_events'
  ) then
    execute 'alter publication supabase_realtime add table public.user_events';
  end if;
end;
$$;
