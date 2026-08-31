-- Retention participates in the same workflow lock order as capture deletion
-- and delayed organization: job -> capture -> note. Snapshot idempotency rows
-- are acquired after the workflow fence but before the note, so manual
-- mutation's idempotency -> note order cannot form the reverse edge. A receipt
-- whose destination expires becomes non-actionable Inbox history before the
-- note graph is removed.

alter table public.capture_receipts
  drop constraint capture_receipts_review_item_id_fkey,
  add constraint capture_receipts_review_item_id_fkey
    foreign key (review_item_id)
    references public.review_items(id)
    on delete set null,
  drop constraint capture_receipts_mutation_id_fkey,
  add constraint capture_receipts_mutation_id_fkey
    foreign key (mutation_id)
    references public.note_mutations(id)
    on delete set null,
  drop constraint capture_receipts_destination_note_id_fkey,
  add constraint capture_receipts_destination_note_id_fkey
    foreign key (destination_note_id)
    references public.notes(id)
    on delete set null;

create or replace function private.note_retention_capture_ids(
  p_note_id text
)
returns table (capture_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select related.capture_id
  from (
    select capture_record.id as capture_id
    from public.captures as capture_record
    where capture_record.explicit_destination_note_id = p_note_id

    union

    select decision_record.capture_id
    from public.organization_decisions as decision_record
    where decision_record.destination_note_id = p_note_id

    union

    select mutation_decision.capture_id
    from public.note_mutations as mutation_record
    join public.organization_decisions as mutation_decision
      on mutation_decision.id = mutation_record.decision_id
    where mutation_record.note_id = p_note_id

    union

    select link_record.capture_id
    from public.capture_note_links as link_record
    where link_record.note_id = p_note_id

    union

    select review_record.capture_id
    from public.review_items as review_record
    where review_record.note_id = p_note_id
      and review_record.capture_id is not null

    union

    select block_decision.capture_id
    from public.generated_blocks as block_record
    join public.organization_decisions as block_decision
      on block_decision.id = block_record.decision_id
    where block_record.note_id = p_note_id

    union

    select attempt_job.capture_id
    from public.organization_mutation_attempts as attempt_record
    join public.organization_jobs as attempt_job
      on attempt_job.id = attempt_record.job_id
    where attempt_record.note_id = p_note_id

    union

    select receipt_record.capture_id
    from public.capture_receipts as receipt_record
    where receipt_record.destination_note_id = p_note_id
      or exists (
        select 1
        from jsonb_array_elements(receipt_record.actions) as action_record
        where action_record ->> 'noteId' = p_note_id
      )

    union

    select mutation_receipt.capture_id
    from public.capture_receipts as mutation_receipt
    join public.note_mutations as receipt_mutation
      on receipt_mutation.id = mutation_receipt.mutation_id
    where receipt_mutation.note_id = p_note_id

    union

    select review_receipt.capture_id
    from public.capture_receipts as review_receipt
    join public.review_items as receipt_review
      on receipt_review.id = review_receipt.review_item_id
    where receipt_review.note_id = p_note_id
  ) as related
  where related.capture_id is not null
  group by related.capture_id;
$$;

revoke execute on function private.note_retention_capture_ids(text)
  from public, anon, authenticated, service_role;

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
  planned_capture_ids text[];
  planned_job_ids text[];
  current_capture_ids text[];
  receipt_changed_ids text[];
  capture_changed_ids text[];
  event_capture_id text;
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

  -- Candidate discovery deliberately does not lock the note. Each candidate
  -- is fenced below in the workflow-wide order before its note row is taken.
  for candidate in
    select note_record.id, note_record.user_id
    from public.notes as note_record
    where note_record.deleted_at is not null
      and note_record.deleted_at <= cutoff_at
      and (p_owner_id is null or note_record.user_id = p_owner_id)
    order by note_record.deleted_at, note_record.id
    limit p_batch_size
  loop
    select coalesce(
      array_agg(related.capture_id order by related.capture_id),
      array[]::text[]
    )
    into planned_capture_ids
    from private.note_retention_capture_ids(candidate.id) as related;

    select coalesce(
      array_agg(job_record.id order by job_record.id),
      array[]::text[]
    )
    into planned_job_ids
    from public.organization_jobs as job_record
    where job_record.capture_id = any(planned_capture_ids);

    -- Workflow lock order: job -> capture -> note. Sorting makes multi-capture
    -- purges deterministic when one note received effects from several jobs.
    perform 1
    from public.organization_jobs as job_record
    where job_record.id = any(planned_job_ids)
    order by job_record.id
    for update;

    perform 1
    from public.captures as capture_record
    where capture_record.id = any(planned_capture_ids)
    order by capture_record.id
    for update;

    -- Existing mutation responses are acquired after the workflow fence but
    -- before the note. A manual mutation that already owns one can finish its
    -- note write; a delayed/capture workflow cannot pass the job fence. This
    -- avoids both idempotency -> job and note -> idempotency reverse edges.
    perform 1
    from public.api_idempotency_records as idempotency_record
    where idempotency_record.user_id = candidate.user_id
      and (
        idempotency_record.response_json #>> '{note,id}' = candidate.id
        or idempotency_record.response_json #>> '{revision,noteId}' = candidate.id
      )
    order by idempotency_record.idempotency_key
    for update;

    perform 1
    from public.notes as note_record
    where note_record.id = candidate.id
      and note_record.user_id = candidate.user_id
      and note_record.deleted_at is not null
      and note_record.deleted_at <= cutoff_at
    for update skip locked;
    if not found then
      continue;
    end if;

    select coalesce(
      array_agg(related.capture_id order by related.capture_id),
      array[]::text[]
    )
    into current_capture_ids
    from private.note_retention_capture_ids(candidate.id) as related;

    -- A relation or job created between discovery and the note fence was not
    -- locked in global order. Defer this candidate rather than lock backwards.
    if exists (
      select 1
      from unnest(current_capture_ids) as current_capture(capture_id)
      where not (current_capture.capture_id = any(planned_capture_ids))
    ) or exists (
      select 1
      from public.organization_jobs as current_job
      where current_job.capture_id = any(current_capture_ids)
        and not (current_job.id = any(planned_job_ids))
    ) then
      continue;
    end if;

    -- Fail closed if a privileged write ever created a cross-owner relation.
    -- Without this guard, cascading or historical downgrade could alter a
    -- different account.
    if exists (
      select 1 from public.note_revisions as linked
      where linked.note_id = candidate.id and linked.user_id <> candidate.user_id
      union all
      select 1 from public.captures as linked
      where linked.id = any(current_capture_ids)
        and linked.user_id <> candidate.user_id
      union all
      select 1 from public.organization_jobs as linked
      where linked.capture_id = any(current_capture_ids)
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
      union all
      select 1 from public.capture_receipts as linked
      where linked.capture_id = any(current_capture_ids)
        and linked.user_id <> candidate.user_id
    ) then
      raise exception using errcode = '23514', message = 'owner_scope_violation';
    end if;

    -- Never rewrite a live lease or nonterminal audit trail for retention.
    -- The note remains recoverable as a deleted tombstone until the workflow
    -- reaches a terminal state and a later bounded sweep can safely continue.
    if exists (
      select 1
      from public.organization_jobs as active_job
      where active_job.capture_id = any(current_capture_ids)
        and active_job.state in ('created', 'running', 'awaiting_retry')
    ) then
      continue;
    end if;

    -- Terminal receipts become valid, non-actionable history. Clear every
    -- destination, mutation, review, inserted-content, and action reference
    -- before their referenced rows cascade away.
    with changed_receipts as (
      update public.capture_receipts as receipt_record
      set
        review_item_id = null,
        mutation_id = null,
        outcome = 'kept_in_inbox',
        headline = 'Kept in Inbox after note expired',
        destination_note_id = null,
        inserted_content = '[]'::jsonb,
        actions = '[]'::jsonb,
        reason_codes = case
          when 'destination_expired' = any(receipt_record.reason_codes)
            then receipt_record.reason_codes
          when cardinality(receipt_record.reason_codes) < 20
            then array_append(receipt_record.reason_codes, 'destination_expired')
          else receipt_record.reason_codes[1:19]
            || array['destination_expired']::text[]
        end
      where receipt_record.capture_id = any(current_capture_ids)
      returning receipt_record.capture_id
    )
    select coalesce(
      array_agg(changed_receipts.capture_id order by changed_receipts.capture_id),
      array[]::text[]
    )
    into receipt_changed_ids
    from changed_receipts;

    with changed_captures as (
      update public.captures as capture_record
      set
        status = 'inbox',
        last_error_code = null,
        explicit_destination_note_id = case
          when capture_record.explicit_destination_note_id = candidate.id then null
          else capture_record.explicit_destination_note_id
        end
      where capture_record.id = any(current_capture_ids)
        and capture_record.user_id = candidate.user_id
        and capture_record.deleted_at is null
        and capture_record.status <> 'deleted'
      returning capture_record.id
    )
    select coalesce(
      array_agg(changed_captures.id order by changed_captures.id),
      array[]::text[]
    )
    into capture_changed_ids
    from changed_captures;

    update public.organization_decisions as decision_record
    set destination_note_id = null
    where decision_record.destination_note_id = candidate.id
      and decision_record.user_id = candidate.user_id;

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
      for event_capture_id in
        select distinct changed_capture.capture_id
        from unnest(
          receipt_changed_ids || capture_changed_ids
        ) as changed_capture(capture_id)
        order by changed_capture.capture_id
      loop
        perform private.emit_user_event(
          candidate.user_id,
          'capture_receipt',
          event_capture_id
        );
        perform private.emit_user_event(
          candidate.user_id,
          'capture',
          event_capture_id
        );
      end loop;
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
