-- Photos and recordings have no legacy storage, so their write always takes the encrypted path
-- whatever rollout state the owner is in. It shipped with the two-state guard the schema used
-- before migration 27 contracted every other write to accept `encrypted_only` and `contracted`,
-- so it refused every photo from an owner who had finished the rollout. Production onboards a
-- fresh owner straight through to `encrypted_only`, which is why uploads were refused there
-- while the same code passed every test: the test owners sit at the two earlier states.
do $capture_attachment_rollout_states$
begin
  perform private.contract_replace_function(
    'public.create_encrypted_capture_attachment(uuid,jsonb)',
    $old$where user_id = p_owner_id and state in ('dual_write', 'encrypted_read')$old$,
    $new$where user_id = p_owner_id and state in (
      'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
    )$new$
  );
end
$capture_attachment_rollout_states$;
