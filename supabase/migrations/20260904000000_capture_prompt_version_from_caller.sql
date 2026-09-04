-- The capture RPCs stamped every organization job with the literal 'routing-v1'. The organizer
-- refuses a job whose prompt version is not the one it was built for, so when its constant moved
-- to 'routing-v2' every capture failed closed as validation_failed the moment that organizer was
-- live -- and no test could see it, because the literal and the constant lived in different
-- languages. The caller now sends promptVersion and schemaVersion with the capture and the RPC
-- stores them. A caller that sends neither (a web build from before this migration, during the
-- minutes between migrating and deploying) still gets the old literal, so the change is safe to
-- roll forward through.

create function private.capture_prompt_version(p_capture jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  value text := p_capture ->> 'promptVersion';
begin
  if value is null then
    return 'routing-v1';
  end if;
  if value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  return value;
end;
$$;

create function private.capture_schema_version(p_capture jsonb)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  value text := p_capture ->> 'schemaVersion';
begin
  if value is null then
    return 1;
  end if;
  if value !~ '^[1-9][0-9]{0,2}$' then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  return value::integer;
end;
$$;

-- Three definitions are rewritten from their live text: the public wrapper (which lists the
-- keys a capture may carry), the inner function it delegates to (which stamps the job), and the
-- legacy path. Each replaced fragment must appear exactly once in the live definition, so a
-- definition that has drifted stops the migration instead of being half-rewritten.
create function pg_temp.rewrite_function(p_signature text, p_fragments text[][])
returns void
language plpgsql
as $$
declare
  definition_value text;
  fragment text[];
begin
  definition_value := pg_catalog.pg_get_functiondef(p_signature::regprocedure);
  foreach fragment slice 1 in array p_fragments loop
    if (pg_catalog.length(definition_value)
      - pg_catalog.length(pg_catalog.replace(definition_value, fragment[1], '')))
      <> pg_catalog.length(fragment[1])
    then
      raise exception '% fragment moved: %', p_signature, left(fragment[1], 48);
    end if;
    definition_value := pg_catalog.replace(definition_value, fragment[1], fragment[2]);
  end loop;
  execute definition_value;
end;
$$;

-- The public wrapper: let the two keys through to the inner function.
select pg_temp.rewrite_function(
  'public.create_encrypted_capture_with_job(uuid, jsonb)',
  array[array[
    $f$'privateReceiptCipher','privateReceiptVerificationMac','routingRuleMatch',
      'attachmentIds'$f$,
    $f$'privateReceiptCipher','privateReceiptVerificationMac','routingRuleMatch',
      'attachmentIds','promptVersion','schemaVersion'$f$
  ]]
);

-- The inner function: accept the keys, and stamp the job from them.
select pg_temp.rewrite_function(
  'private.create_encrypted_capture_with_job_e1(uuid, jsonb)',
  array[
    array[
      $f$'explicitDestinationNoteId', 'expansionDisabled',
      'privateReceiptCipher', 'privateReceiptVerificationMac'
    ] <> '{}'::jsonb$f$,
      $f$'explicitDestinationNoteId', 'expansionDisabled',
      'privateReceiptCipher', 'privateReceiptVerificationMac',
      'promptVersion', 'schemaVersion'
    ] <> '{}'::jsonb$f$
    ],
    array[
      $f$'routing-v1', 1, occurred_value, occurred_value, occurred_value$f$,
      $f$private.capture_prompt_version(p_capture),
    private.capture_schema_version(p_capture),
    occurred_value, occurred_value, occurred_value$f$
    ]
  ]
);

-- The legacy path: the same two changes.
select pg_temp.rewrite_function(
  'public.create_capture_with_job(uuid, jsonb)',
  array[
    array[
      $f$'explicitDestinationNoteId', 'expansionDisabled'
    ]) <> '{}'::jsonb$f$,
      $f$'explicitDestinationNoteId', 'expansionDisabled',
      'promptVersion', 'schemaVersion'
    ]) <> '{}'::jsonb$f$
    ],
    array[
      $f$capture_id_value, owner_id, 'created', 'routing-v1', 1, now()$f$,
      $f$capture_id_value, owner_id, 'created',
    private.capture_prompt_version(p_capture),
    private.capture_schema_version(p_capture), now()$f$
    ]
  ]
);

-- The private-manual path. The public wrapper hands a private capture, payload intact, to the
-- original dual-write implementation, which carries its own key list and stamps its job as
-- already succeeded. 20260830000020 renamed it to _legacy and 20260830000027 renames it again to
-- create_encrypted_private_capture_with_job_impl -- but that rename does not run in every
-- environment, so the function is looked up by either name and the one that exists is
-- rewritten. Its body is the same text under both.
do $$
declare
  target regprocedure := coalesce(
    pg_catalog.to_regprocedure(
      'private.create_encrypted_private_capture_with_job_impl(uuid, jsonb)'
    ),
    pg_catalog.to_regprocedure(
      'private.create_encrypted_capture_with_job_legacy(uuid, jsonb)'
    )
  );
  present text;
begin
  if target is null then
    select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.proname)
    into present
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like '%capture%with_job%';
    raise exception 'no private capture implementation under either name; private has: %',
      coalesce(present, '(none)');
  end if;
  perform pg_temp.rewrite_function(
    target::text,
    array[
      array[
        $f$'explicitDestinationNoteId', 'expansionDisabled',
      'privateReceiptCipher', 'privateReceiptVerificationMac'
    ] <> '{}'::jsonb$f$,
        $f$'explicitDestinationNoteId', 'expansionDisabled',
      'privateReceiptCipher', 'privateReceiptVerificationMac',
      'promptVersion', 'schemaVersion'
    ] <> '{}'::jsonb$f$
      ],
      array[
        $f$job_id_value, capture_id_value, p_owner_id, 'succeeded', 'routing-v1', 1,
    occurred_value, occurred_value, occurred_value, occurred_value$f$,
        $f$job_id_value, capture_id_value, p_owner_id, 'succeeded',
    private.capture_prompt_version(p_capture),
    private.capture_schema_version(p_capture),
    occurred_value, occurred_value, occurred_value, occurred_value$f$
      ]
    ]
  );
end;
$$;

drop function pg_temp.rewrite_function(text, text[][]);
