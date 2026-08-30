-- Service-only note retention. Calls default to a dry run; hard deletion
-- requires an explicit execution flag after the published 30-day window.

create index notes_deleted_retention
  on public.notes (deleted_at, id)
  include (user_id)
  where deleted_at is not null;

-- Long-lived telemetry keeps its history while losing a deleted destination.
alter table public.captures
  drop constraint captures_explicit_destination_note_id_fkey,
  add constraint captures_explicit_destination_note_id_fkey
    foreign key (explicit_destination_note_id)
    references public.notes(id)
    on delete set null;

alter table public.organization_decisions
  drop constraint organization_decisions_destination_note_id_fkey,
  add constraint organization_decisions_destination_note_id_fkey
    foreign key (destination_note_id)
    references public.notes(id)
    on delete set null;

-- A routing rule is invalid once its only destination has expired.
alter table public.routing_rules
  drop constraint routing_rules_destination_note_id_fkey,
  add constraint routing_rules_destination_note_id_fkey
    foreign key (destination_note_id)
    references public.notes(id)
    on delete cascade;

alter table public.feedback_events
  drop constraint feedback_events_old_destination_note_id_fkey,
  add constraint feedback_events_old_destination_note_id_fkey
    foreign key (old_destination_note_id)
    references public.notes(id)
    on delete set null,
  drop constraint feedback_events_new_destination_note_id_fkey,
  add constraint feedback_events_new_destination_note_id_fkey
    foreign key (new_destination_note_id)
    references public.notes(id)
    on delete set null;

create or replace function public.purge_expired_deleted_notes(
  p_owner_id uuid default null,
  p_now timestamptz default now(),
  p_batch_size integer default 100,
  p_execute boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate record;
  cutoff_at timestamptz;
  eligible_count integer;
  purged_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_now is null
    or p_batch_size is null
    or p_batch_size not between 1 and 500
    or p_execute is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  cutoff_at := p_now - interval '30 days';

  select count(*)::integer
  into eligible_count
  from (
    select 1
    from public.notes as note_record
    where note_record.deleted_at is not null
      and note_record.deleted_at <= cutoff_at
      and (p_owner_id is null or note_record.user_id = p_owner_id)
    order by note_record.deleted_at, note_record.id
    limit p_batch_size
  ) as eligible;

  if not p_execute then
    return jsonb_build_object(
      'cutoff', cutoff_at,
      'eligibleCount', eligible_count,
      'executed', false,
      'purgedCount', 0,
      'runAt', p_now
    );
  end if;

  for candidate in
    select note_record.id, note_record.user_id
    from public.notes as note_record
    where note_record.deleted_at is not null
      and note_record.deleted_at <= cutoff_at
      and (p_owner_id is null or note_record.user_id = p_owner_id)
    order by note_record.deleted_at, note_record.id
    for update skip locked
    limit p_batch_size
  loop
    -- Fail closed if a privileged write ever created a cross-owner relation.
    -- Without this guard, ON DELETE actions could alter a different account.
    if exists (
      select 1 from public.note_revisions as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.captures as linked
      where linked.explicit_destination_note_id = candidate.id
        and linked.user_id <> candidate.user_id
      union all
      select 1 from public.organization_decisions as linked
      where linked.destination_note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.note_mutations as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.generated_blocks as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.capture_note_links as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.routing_rules as linked
      where linked.destination_note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.review_items as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.note_chunks as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.note_tags as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.note_links as linked
      where (linked.from_note_id = candidate.id or linked.to_note_id = candidate.id)
        and linked.user_id <> candidate.user_id
      union all
      select 1 from public.feedback_events as linked
      where (linked.old_destination_note_id = candidate.id
          or linked.new_destination_note_id = candidate.id)
        and linked.user_id <> candidate.user_id
      union all
      select 1 from public.organization_mutation_attempts as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
    ) then
      raise exception using errcode = '23514', message = 'owner_scope_violation';
    end if;

    -- Mutation responses contain full note snapshots. Purge those opaque
    -- replay records alongside the canonical note and revision history.
    delete from public.api_idempotency_records as idempotency_record
    where idempotency_record.user_id = candidate.user_id
      and (
        idempotency_record.response_json #>> '{note,id}' = candidate.id
        or idempotency_record.response_json #>> '{revision,noteId}' = candidate.id
      );

    -- Replace stale note/revision/mutation cursor hints with one tombstone.
    delete from public.user_events as event_record
    where event_record.user_id = candidate.user_id
      and (
        event_record.entity_id = candidate.id
        or event_record.entity_id in (
          select revision_record.id
          from public.note_revisions as revision_record
          where revision_record.note_id = candidate.id
        )
        or event_record.entity_id in (
          select mutation_record.id
          from public.note_mutations as mutation_record
          where mutation_record.note_id = candidate.id
        )
      );

    delete from public.notes as note_record
    where note_record.id = candidate.id
      and note_record.user_id = candidate.user_id
      and note_record.deleted_at is not null
      and note_record.deleted_at <= cutoff_at;

    if found then
      purged_count := purged_count + 1;
      perform private.emit_user_event(candidate.user_id, 'note_purged', candidate.id);
    end if;
  end loop;

  return jsonb_build_object(
    'cutoff', cutoff_at,
    'eligibleCount', eligible_count,
    'executed', true,
    'purgedCount', purged_count,
    'runAt', p_now
  );
end;
$$;

revoke execute on function public.purge_expired_deleted_notes(
  uuid, timestamptz, integer, boolean
) from public, anon, authenticated;
grant execute on function public.purge_expired_deleted_notes(
  uuid, timestamptz, integer, boolean
) to service_role;
