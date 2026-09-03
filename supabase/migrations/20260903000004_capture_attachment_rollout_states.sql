-- Photos and recordings have no legacy storage, so their write always takes the encrypted path
-- whatever rollout state the owner is in. It shipped with the two-state guard the schema used
-- before migration 27 contracted every other write to accept `encrypted_only` and `contracted`,
-- so it refused every upload from an owner who had finished the rollout. Production onboards a
-- fresh owner straight through to `encrypted_only`, which is why uploads were refused there
-- while the same code passed every test: the test owners sit at the two earlier states.
--
-- The replacement is surgical and self-contained, the way migration 20260903000002 extends the
-- preserved definitions it depends on: read the live definition, refuse to run unless the exact
-- old predicate appears once, and execute the rewritten definition.
do $capture_attachment_rollout_states$
declare
  definition_value text := pg_catalog.pg_get_functiondef(
    'public.create_encrypted_capture_attachment(uuid,jsonb)'::regprocedure
  );
  old_predicate constant text :=
    $old$where user_id = p_owner_id and state in ('dual_write', 'encrypted_read')$old$;
  new_predicate constant text :=
    $new$where user_id = p_owner_id and state in (
      'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
    )$new$;
begin
  if (pg_catalog.length(definition_value)
      - pg_catalog.length(pg_catalog.replace(definition_value, old_predicate, '')))
      / pg_catalog.length(old_predicate) <> 1
  then
    raise exception 'create_encrypted_capture_attachment rollout predicate moved';
  end if;
  execute pg_catalog.replace(definition_value, old_predicate, new_predicate);
end
$capture_attachment_rollout_states$;
