-- Durable structure/revision review outcomes and the delayed organization path.

create unique index review_items_one_open_note_conflict
  on public.review_items (user_id, note_id, type)
  where state = 'open' and type in ('structure_conflict', 'revision_conflict');

alter function public.apply_user_note_mutation(text, integer, jsonb, text)
  rename to apply_user_note_mutation_core;
alter function public.apply_user_note_mutation_core(text, integer, jsonb, text)
  set schema private;
revoke execute on function private.apply_user_note_mutation_core(text, integer, jsonb, text)
  from public, anon, authenticated, service_role;

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
  review_id text;
  response_value jsonb;
begin
  begin
    return private.apply_user_note_mutation_core(
      p_note_id, p_expected_revision, p_operations, p_idempotency_key
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'structure_conflict' then raise; end if;
  end;
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
  insert into public.review_items (user_id, note_id, type)
  values (owner_id, p_note_id, 'structure_conflict')
  on conflict (user_id, note_id, type)
    where state = 'open' and type in ('structure_conflict', 'revision_conflict')
    do nothing
  returning id into review_id;
  if review_id is null then
    select id into review_id from public.review_items
    where user_id = owner_id and note_id = p_note_id
      and type = 'structure_conflict' and state = 'open';
  end if;
  response_value := jsonb_build_object(
    'errorCode', 'structure_conflict',
    'reviewItemId', review_id,
    'replayed', false
  );
  perform private.emit_user_event(owner_id, 'review_item', review_id);
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

revoke execute on function public.apply_user_note_mutation(text, integer, jsonb, text)
  from public, anon;
grant execute on function public.apply_user_note_mutation(text, integer, jsonb, text)
  to authenticated, service_role;

create table public.organization_mutation_attempts (
  job_id text not null references public.organization_jobs(id) on delete cascade,
  note_id text not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  planned_revision integer not null check (planned_revision >= 1),
  replan_count integer not null default 0 check (replan_count between 0 and 1),
  operations jsonb not null check (jsonb_typeof(operations) = 'array'),
  state text not null check (state in ('replanned', 'applied', 'needs_review')),
  review_item_id text references public.review_items(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (job_id, note_id)
);
create index organization_mutation_attempts_user_note
  on public.organization_mutation_attempts (user_id, note_id, updated_at desc);
create trigger organization_mutation_attempts_touch_updated_at
before update on public.organization_mutation_attempts
for each row execute function public.set_updated_at();

alter table public.organization_mutation_attempts enable row level security;
alter table public.organization_mutation_attempts force row level security;
create policy organization_mutation_attempts_select_own
on public.organization_mutation_attempts for select to authenticated
using (user_id = auth.uid());
revoke all on table public.organization_mutation_attempts from public, anon, authenticated;
grant select on table public.organization_mutation_attempts to authenticated;
grant all on table public.organization_mutation_attempts to service_role;

create or replace function public.apply_delayed_organization_mutation(
  p_job_id text,
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
  job_row public.organization_jobs%rowtype;
  note_row public.notes%rowtype;
  attempt_row public.organization_mutation_attempts%rowtype;
  claim jsonb;
  response_value jsonb;
  review_id text;
  previous_claims text := current_setting('request.jwt.claims', true);
  internal_key text;
  decision_value text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_expected_revision is null or p_expected_revision < 1
    or jsonb_typeof(p_operations) <> 'array'
    or jsonb_array_length(p_operations) not between 1 and 20
    or char_length(p_idempotency_key) not between 1 and 200
  then raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into job_row from public.organization_jobs where id = p_job_id;
  if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  claim := private.claim_idempotency(
    job_row.user_id, p_idempotency_key, 'apply_delayed_organization_mutation',
    jsonb_build_object(
      'jobId', p_job_id, 'noteId', p_note_id,
      'expectedRevision', p_expected_revision, 'operations', p_operations
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  select * into note_row from public.notes
  where id = p_note_id and user_id = job_row.user_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  select * into attempt_row from public.organization_mutation_attempts
  where job_id = p_job_id and note_id = p_note_id for update;

  if note_row.current_revision <> p_expected_revision then
    if attempt_row.job_id is null or attempt_row.replan_count = 0 then
      insert into public.organization_mutation_attempts (
        job_id, note_id, user_id, planned_revision, replan_count, operations, state
      ) values (
        p_job_id, p_note_id, job_row.user_id, note_row.current_revision, 1,
        p_operations, 'replanned'
      )
      on conflict (job_id, note_id) do update set
        planned_revision = excluded.planned_revision,
        replan_count = 1,
        operations = excluded.operations,
        state = 'replanned',
        review_item_id = null;
      response_value := jsonb_build_object(
        'status', 'replanned',
        'expectedRevision', note_row.current_revision,
        'replanCount', 1,
        'replayed', false
      );
      perform private.finish_idempotency(job_row.user_id, p_idempotency_key, response_value);
      return response_value;
    end if;
    insert into public.review_items (user_id, note_id, capture_id, type, choices)
    values (
      job_row.user_id, p_note_id, job_row.capture_id, 'revision_conflict',
      jsonb_build_array(jsonb_build_object(
        'plannedRevision', p_expected_revision,
        'currentRevision', note_row.current_revision
      ))
    )
    on conflict (user_id, note_id, type)
      where state = 'open' and type in ('structure_conflict', 'revision_conflict')
      do nothing
    returning id into review_id;
    if review_id is null then
      select id into review_id from public.review_items
      where user_id = job_row.user_id and note_id = p_note_id
        and type = 'revision_conflict' and state = 'open';
    end if;
    update public.organization_mutation_attempts
    set state = 'needs_review', review_item_id = review_id
    where job_id = p_job_id and note_id = p_note_id;
    response_value := jsonb_build_object(
      'status', 'needs_review',
      'errorCode', 'stale_revision',
      'reviewItemId', review_id,
      'replayed', false
    );
    perform private.emit_user_event(job_row.user_id, 'review_item', review_id);
    perform private.finish_idempotency(job_row.user_id, p_idempotency_key, response_value);
    return response_value;
  end if;

  internal_key := 'org_' || encode(extensions.digest(
    convert_to(p_job_id || ':' || p_idempotency_key, 'utf8'), 'sha256'
  ), 'hex');
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', job_row.user_id, 'role', 'service_role')::text,
    true
  );
  perform set_config('unfiled.revision_source', 'organization', true);
  perform set_config('unfiled.revision_actor', 'organization:' || p_job_id, true);
  begin
    response_value := private.apply_user_note_mutation_core(
      p_note_id, p_expected_revision, p_operations, internal_key
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'structure_conflict' then raise; end if;
    perform set_config('request.jwt.claims', coalesce(previous_claims, '{}'), true);
    perform set_config('unfiled.revision_source', '', true);
    perform set_config('unfiled.revision_actor', '', true);
    insert into public.review_items (user_id, note_id, capture_id, type)
    values (job_row.user_id, p_note_id, job_row.capture_id, 'structure_conflict')
    on conflict (user_id, note_id, type)
      where state = 'open' and type in ('structure_conflict', 'revision_conflict')
      do nothing
    returning id into review_id;
    if review_id is null then
      select id into review_id from public.review_items
      where user_id = job_row.user_id and note_id = p_note_id
        and type = 'structure_conflict' and state = 'open';
    end if;
    insert into public.organization_mutation_attempts (
      job_id, note_id, user_id, planned_revision, replan_count,
      operations, state, review_item_id
    ) values (
      p_job_id, p_note_id, job_row.user_id, p_expected_revision,
      coalesce(attempt_row.replan_count, 0), p_operations, 'needs_review', review_id
    ) on conflict (job_id, note_id) do update set
      planned_revision = excluded.planned_revision,
      operations = excluded.operations,
      state = 'needs_review',
      review_item_id = excluded.review_item_id;
    response_value := jsonb_build_object(
      'status', 'needs_review', 'errorCode', 'structure_conflict',
      'reviewItemId', review_id, 'replayed', false
    );
    perform private.emit_user_event(job_row.user_id, 'review_item', review_id);
    perform private.finish_idempotency(job_row.user_id, p_idempotency_key, response_value);
    return response_value;
  end;
  perform set_config('request.jwt.claims', coalesce(previous_claims, '{}'), true);
  perform set_config('unfiled.revision_source', '', true);
  perform set_config('unfiled.revision_actor', '', true);
  select decision.id into decision_value
  from public.organization_decisions as decision
  where decision.capture_id = job_row.capture_id and decision.user_id = job_row.user_id
  order by decision.created_at desc, decision.id desc limit 1;
  update public.note_mutations set decision_id = decision_value
  where id = response_value ->> 'mutationId';
  insert into public.organization_mutation_attempts (
    job_id, note_id, user_id, planned_revision, replan_count, operations, state
  ) values (
    p_job_id, p_note_id, job_row.user_id, p_expected_revision,
    coalesce(attempt_row.replan_count, 0), p_operations, 'applied'
  ) on conflict (job_id, note_id) do update set
    planned_revision = excluded.planned_revision,
    operations = excluded.operations,
    state = 'applied';
  response_value := response_value || jsonb_build_object('status', 'applied', 'replayed', false);
  perform private.finish_idempotency(job_row.user_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

revoke execute on function public.apply_delayed_organization_mutation(
  text, text, integer, jsonb, text
) from public, anon, authenticated;
grant execute on function public.apply_delayed_organization_mutation(
  text, text, integer, jsonb, text
) to service_role;

-- Search is deliberately limited to title, body, update date, and space path.
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
  if owner_id is null then raise exception using errcode = '42501', message = 'unauthorized'; end if;
  if normalized_query is null or normalized_query = '' or char_length(normalized_query) > 200
    or p_archive_filter is null or p_archive_filter not in ('exclude', 'include', 'only')
    or p_limit is null or p_limit not between 1 and 100
    or p_offset is null or p_offset not between 0 and 100000
  then raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  search_query := websearch_to_tsquery('simple', p_query);
  return query
  with candidates as (
    select
      note_record.*,
      case when child_space.id is null then null
        else concat_ws(' / ', parent_space.name, child_space.name) end as path_value,
      concat_ws(' ', note_record.title, note_record.body_markdown,
        note_record.updated_at::date::text, parent_space.name, child_space.name) as document_value
    from public.notes as note_record
    left join public.spaces as child_space
      on child_space.id = note_record.space_id and child_space.user_id = owner_id
    left join public.spaces as parent_space
      on parent_space.id = child_space.parent_id and parent_space.user_id = owner_id
    where note_record.user_id = owner_id and note_record.deleted_at is null
      and (p_archive_filter = 'include'
        or (p_archive_filter = 'exclude' and note_record.archived_at is null)
        or (p_archive_filter = 'only' and note_record.archived_at is not null))
  )
  select
    candidate.id,
    candidate.title,
    left(regexp_replace(
      case when position(normalized_query in lower(candidate.body_markdown)) > 0
        then substring(candidate.body_markdown from greatest(
          position(normalized_query in lower(candidate.body_markdown)) - 80, 1
        ) for 320)
        else candidate.body_markdown end,
      '[[:space:]]+', ' ', 'g'
    ), 240),
    candidate.path_value,
    candidate.updated_at,
    (case when lower(candidate.title) = normalized_query then 400.0
      when lower(candidate.title) like normalized_query || '%' then 300.0
      when lower(candidate.title) like '% ' || normalized_query || '%' then 250.0
      else 100.0 end
      + ts_rank(to_tsvector('simple', candidate.document_value), search_query)::double precision)
  from candidates as candidate
  where lower(candidate.document_value) like '%' || normalized_query || '%'
    or to_tsvector('simple', candidate.document_value) @@ search_query
  order by 6 desc, candidate.updated_at desc, candidate.id
  limit p_limit offset p_offset;
end;
$$;

revoke execute on function public.search_notes(text, text, integer, integer)
  from public, anon;
grant execute on function public.search_notes(text, text, integer, integer)
  to authenticated, service_role;
