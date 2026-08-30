-- Unfiled security boundary, client grants, and atomic capture entry point.
-- Depends on 20260830000000_initial_unfiled_schema.sql.

create or replace function public.create_capture_with_job(p_capture jsonb)
returns public.captures
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := auth.uid();
  v_capture_id text;
  v_capture_source public.capture_source;
  v_raw_text text;
  v_destination_note_id text;
  v_capture_row public.captures%rowtype;
  v_job_id text;
  v_capture_inserted boolean := false;
  v_job_inserted boolean := false;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if p_capture is null or jsonb_typeof(p_capture) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_capture_payload';
  end if;

  if p_capture ? 'userId' or p_capture ? 'user_id' then
    raise exception using errcode = '22023', message = 'user_id_not_allowed';
  end if;

  v_capture_id := coalesce(
    nullif(p_capture ->> 'clientCaptureId', ''),
    nullif(p_capture ->> 'id', '')
  );
  v_raw_text := coalesce(
    p_capture ->> 'rawContent',
    p_capture ->> 'raw_text'
  );
  v_destination_note_id := coalesce(
    nullif(p_capture ->> 'explicitDestinationNoteId', ''),
    nullif(p_capture ->> 'explicit_destination_note_id', '')
  );

  if v_capture_id is null
    or v_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or v_raw_text is null
    or char_length(v_raw_text) not between 1 and 10000
    or btrim(v_raw_text) = ''
    or coalesce(
      nullif(p_capture ->> 'clientCreatedAt', ''),
      nullif(p_capture ->> 'client_created_at', '')
    ) is null
    or coalesce(
      nullif(p_capture ->> 'clientTimezone', ''),
      nullif(p_capture ->> 'client_timezone', '')
    ) is null
  then
    raise exception using errcode = '22023', message = 'invalid_capture_payload';
  end if;

  begin
    v_capture_source := (p_capture ->> 'source')::public.capture_source;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_capture_source';
  end;

  if v_capture_source is null then
    raise exception using errcode = '22023', message = 'invalid_capture_source';
  end if;

  if v_destination_note_id is not null and not exists (
    select 1
    from public.notes
    where id = v_destination_note_id
      and user_id = v_owner_id
      and deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'explicit_destination_not_owned';
  end if;

  insert into public.captures (
    id,
    user_id,
    source,
    device_id,
    raw_text,
    privacy,
    explicit_destination_note_id,
    expansion_disabled,
    client_created_at,
    client_timezone
  )
  values (
    v_capture_id,
    v_owner_id,
    v_capture_source,
    coalesce(p_capture ->> 'deviceId', p_capture ->> 'device_id', ''),
    v_raw_text,
    coalesce(
      nullif(p_capture ->> 'privacy', '')::public.privacy_mode,
      'ai_assisted'::public.privacy_mode
    ),
    v_destination_note_id,
    coalesce(
      nullif(
        coalesce(
          p_capture ->> 'expansionDisabled',
          p_capture ->> 'expansion_disabled'
        ),
        ''
      )::boolean,
      false
    ),
    coalesce(
      p_capture ->> 'clientCreatedAt',
      p_capture ->> 'client_created_at'
    )::timestamptz,
    coalesce(
      p_capture ->> 'clientTimezone',
      p_capture ->> 'client_timezone'
    )
  )
  on conflict (id) do nothing
  returning * into v_capture_row;

  v_capture_inserted := found;

  if not v_capture_inserted then
    select *
    into v_capture_row
    from public.captures as existing_capture
    where existing_capture.id = v_capture_id
      and existing_capture.user_id = v_owner_id;

    if not found then
      raise exception using errcode = '23505', message = 'capture_id_conflict';
    end if;
  end if;

  insert into public.organization_jobs (
    capture_id,
    user_id,
    prompt_version,
    schema_version
  )
  values (v_capture_id, v_owner_id, 'routing-v1', 1)
  on conflict (capture_id) do nothing
  returning id into v_job_id;

  v_job_inserted := found;

  if v_job_id is null then
    select id
    into v_job_id
    from public.organization_jobs as existing_job
    where existing_job.capture_id = v_capture_id
      and existing_job.user_id = v_owner_id;
  end if;

  if v_job_id is null then
    raise exception using errcode = '23505', message = 'capture_job_conflict';
  end if;

  if v_capture_inserted then
    perform private.emit_user_event(v_owner_id, 'capture', v_capture_id);
  end if;

  if v_job_inserted then
    perform private.emit_user_event(v_owner_id, 'organization_job', v_job_id);
  end if;

  return v_capture_row;
end;
$$;

alter table public.profiles enable row level security;
alter table public.user_provider_keys enable row level security;
alter table public.spaces enable row level security;
alter table public.notes enable row level security;
alter table public.note_revisions enable row level security;
alter table public.captures enable row level security;
alter table public.organization_jobs enable row level security;
alter table public.organization_decisions enable row level security;
alter table public.note_mutations enable row level security;
alter table public.generated_blocks enable row level security;
alter table public.capture_note_links enable row level security;
alter table public.routing_rules enable row level security;
alter table public.review_items enable row level security;
alter table public.note_chunks enable row level security;
alter table public.tags enable row level security;
alter table public.note_tags enable row level security;
alter table public.note_links enable row level security;
alter table public.feedback_events enable row level security;
alter table public.user_events enable row level security;

create policy profiles_select on public.profiles
for select using (id = auth.uid());
create policy profiles_insert on public.profiles
for insert with check (id = auth.uid());
create policy profiles_update on public.profiles
for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete on public.profiles
for delete using (id = auth.uid());

-- No policies are intentionally defined for user_provider_keys. Clients have
-- no table privileges and key material is reachable only through reviewed RPCs.

create policy spaces_select on public.spaces
for select using (user_id = auth.uid());
create policy spaces_insert on public.spaces
for insert with check (
  user_id = auth.uid()
  and (parent_id is null or private.owns_root_space(parent_id))
);
create policy spaces_update on public.spaces
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and (parent_id is null or private.owns_root_space(parent_id))
);
create policy spaces_delete on public.spaces
for delete using (user_id = auth.uid());

create policy notes_select on public.notes
for select using (user_id = auth.uid());
create policy notes_insert on public.notes
for insert with check (
  user_id = auth.uid()
  and (space_id is null or private.owns_space(space_id))
);
create policy notes_update on public.notes
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and (space_id is null or private.owns_space(space_id))
);
create policy notes_delete on public.notes
for delete using (user_id = auth.uid());

create policy note_revisions_select on public.note_revisions
for select using (user_id = auth.uid());
create policy note_revisions_insert on public.note_revisions
for insert with check (user_id = auth.uid() and private.owns_note(note_id));

create policy captures_select on public.captures
for select using (user_id = auth.uid());
create policy captures_delete on public.captures
for delete using (user_id = auth.uid());

create policy organization_jobs_select on public.organization_jobs
for select using (user_id = auth.uid());
create policy organization_decisions_select on public.organization_decisions
for select using (user_id = auth.uid());
create policy note_mutations_select on public.note_mutations
for select using (user_id = auth.uid());
create policy note_chunks_select on public.note_chunks
for select using (user_id = auth.uid());
create policy feedback_events_select on public.feedback_events
for select using (user_id = auth.uid());
create policy user_events_select on public.user_events
for select using (user_id = auth.uid());

create policy generated_blocks_select on public.generated_blocks
for select using (user_id = auth.uid());
create policy generated_blocks_insert on public.generated_blocks
for insert with check (
  user_id = auth.uid()
  and private.owns_note(note_id)
  and private.owns_decision(decision_id)
);
create policy generated_blocks_update on public.generated_blocks
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and private.owns_note(note_id)
  and private.owns_decision(decision_id)
);
create policy generated_blocks_delete on public.generated_blocks
for delete using (user_id = auth.uid());

create policy capture_note_links_select on public.capture_note_links
for select using (user_id = auth.uid());
create policy capture_note_links_insert on public.capture_note_links
for insert with check (
  user_id = auth.uid()
  and private.owns_capture(capture_id)
  and private.owns_note(note_id)
  and private.owns_mutation(mutation_id)
);
create policy capture_note_links_update on public.capture_note_links
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and private.owns_capture(capture_id)
  and private.owns_note(note_id)
  and private.owns_mutation(mutation_id)
);
create policy capture_note_links_delete on public.capture_note_links
for delete using (user_id = auth.uid());

create policy routing_rules_select on public.routing_rules
for select using (user_id = auth.uid());
create policy routing_rules_insert on public.routing_rules
for insert with check (
  user_id = auth.uid()
  and (
    (destination_note_id is not null and private.owns_note(destination_note_id))
    or (
      destination_space_id is not null
      and private.owns_space(destination_space_id)
    )
  )
);
create policy routing_rules_update on public.routing_rules
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and (
    (destination_note_id is not null and private.owns_note(destination_note_id))
    or (
      destination_space_id is not null
      and private.owns_space(destination_space_id)
    )
  )
);
create policy routing_rules_delete on public.routing_rules
for delete using (user_id = auth.uid());

create policy review_items_select on public.review_items
for select using (user_id = auth.uid());
create policy review_items_insert on public.review_items
for insert with check (
  user_id = auth.uid()
  and (capture_id is null or private.owns_capture(capture_id))
  and (note_id is null or private.owns_note(note_id))
);
create policy review_items_update on public.review_items
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and (capture_id is null or private.owns_capture(capture_id))
  and (note_id is null or private.owns_note(note_id))
);
create policy review_items_delete on public.review_items
for delete using (user_id = auth.uid());

create policy tags_select on public.tags
for select using (user_id = auth.uid());
create policy tags_insert on public.tags
for insert with check (user_id = auth.uid());
create policy tags_update on public.tags
for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tags_delete on public.tags
for delete using (user_id = auth.uid());

create policy note_tags_select on public.note_tags
for select using (user_id = auth.uid());
create policy note_tags_insert on public.note_tags
for insert with check (
  user_id = auth.uid()
  and private.owns_note(note_id)
  and private.owns_tag(tag_id)
  and (mutation_id is null or private.owns_mutation(mutation_id))
);
create policy note_tags_update on public.note_tags
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and private.owns_note(note_id)
  and private.owns_tag(tag_id)
  and (mutation_id is null or private.owns_mutation(mutation_id))
);
create policy note_tags_delete on public.note_tags
for delete using (user_id = auth.uid());

create policy note_links_select on public.note_links
for select using (user_id = auth.uid());
create policy note_links_insert on public.note_links
for insert with check (
  user_id = auth.uid()
  and private.owns_note(from_note_id)
  and private.owns_note(to_note_id)
  and (mutation_id is null or private.owns_mutation(mutation_id))
);
create policy note_links_update on public.note_links
for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and private.owns_note(from_note_id)
  and private.owns_note(to_note_id)
  and (mutation_id is null or private.owns_mutation(mutation_id))
);
create policy note_links_delete on public.note_links
for delete using (user_id = auth.uid());

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema private to authenticated, service_role;

revoke all privileges on all tables in schema public from anon, authenticated;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

grant select, insert, update, delete on table
  public.profiles,
  public.spaces,
  public.notes,
  public.generated_blocks,
  public.capture_note_links,
  public.routing_rules,
  public.review_items,
  public.tags,
  public.note_tags,
  public.note_links
to authenticated;

-- Milestone A permits direct note CRUD so the shells can compile against the
-- schema. Before the Milestone B gate, note writes move behind the reviewed
-- expected-revision mutation RPC and these direct note grants are narrowed.

-- Captures must be created by create_capture_with_job so capture + job remain
-- atomic. Only the future reviewed retention path may replace direct deletes.
grant select, delete on table public.captures to authenticated;

-- Revision history is append-only to clients. Existing revisions cannot be
-- rewritten or deleted even when the caller owns the corresponding note.
grant select, insert on table public.note_revisions to authenticated;

grant select on table
  public.organization_jobs,
  public.organization_decisions,
  public.note_mutations,
  public.note_chunks,
  public.feedback_events,
  public.user_events
to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema private to service_role;

grant execute on function public.generate_ulid() to authenticated;
grant execute on function public.new_entity_id(text) to authenticated;
grant execute on function public.create_capture_with_job(jsonb) to authenticated;
grant execute on function private.owns_space(text) to authenticated;
grant execute on function private.owns_root_space(text) to authenticated;
grant execute on function private.owns_note(text) to authenticated;
grant execute on function private.owns_capture(text) to authenticated;
grant execute on function private.owns_decision(text) to authenticated;
grant execute on function private.owns_mutation(text) to authenticated;
grant execute on function private.owns_tag(text) to authenticated;
