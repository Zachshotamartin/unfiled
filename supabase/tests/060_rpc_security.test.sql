create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;

select plan(43);

-- Every client-visible Milestone B function crosses the same reviewed boundary:
-- fixed search_path, SECURITY DEFINER, authenticated execution, and no anon path.
select ok(
  procedure_record.prosecdef,
  format('%s is SECURITY DEFINER', target.signature)
)
from unnest(array[
  'public.create_note(text,public.note_type,text,text,text,public.privacy_mode,jsonb,jsonb,jsonb)',
  'public.apply_user_note_mutation(text,integer,jsonb,text)',
  'public.undo_user_mutation(text,integer,text)',
  'public.restore_note_revision(text,text,integer,text)',
  'public.restore_note(text,integer,text)',
  'public.create_space(text,text,text,text,text)',
  'public.update_space(text,integer,jsonb,text)',
  'public.archive_space(text,integer,boolean,text)',
  'public.create_tag(text,text)',
  'public.update_tag(text,integer,text,text)',
  'public.delete_tag(text,integer,text)',
  'public.search_notes(text,text,integer,integer)'
]) as target(signature)
join pg_proc as procedure_record
  on procedure_record.oid = to_regprocedure(target.signature);

select ok(
  procedure_record.proconfig @> array['search_path=""'],
  format('%s pins an empty search_path', target.signature)
)
from unnest(array[
  'public.create_note(text,public.note_type,text,text,text,public.privacy_mode,jsonb,jsonb,jsonb)',
  'public.apply_user_note_mutation(text,integer,jsonb,text)',
  'public.undo_user_mutation(text,integer,text)',
  'public.restore_note_revision(text,text,integer,text)',
  'public.restore_note(text,integer,text)',
  'public.create_space(text,text,text,text,text)',
  'public.update_space(text,integer,jsonb,text)',
  'public.archive_space(text,integer,boolean,text)',
  'public.create_tag(text,text)',
  'public.update_tag(text,integer,text,text)',
  'public.delete_tag(text,integer,text)',
  'public.search_notes(text,text,integer,integer)'
]) as target(signature)
join pg_proc as procedure_record
  on procedure_record.oid = to_regprocedure(target.signature);

select ok(
  has_function_privilege('authenticated', target.signature, 'EXECUTE')
    and not has_function_privilege('anon', target.signature, 'EXECUTE'),
  format('%s is authenticated-only', target.signature)
)
from unnest(array[
  'public.create_note(text,public.note_type,text,text,text,public.privacy_mode,jsonb,jsonb,jsonb)',
  'public.apply_user_note_mutation(text,integer,jsonb,text)',
  'public.undo_user_mutation(text,integer,text)',
  'public.restore_note_revision(text,text,integer,text)',
  'public.restore_note(text,integer,text)',
  'public.create_space(text,text,text,text,text)',
  'public.update_space(text,integer,jsonb,text)',
  'public.archive_space(text,integer,boolean,text)',
  'public.create_tag(text,text)',
  'public.update_tag(text,integer,text,text)',
  'public.delete_tag(text,integer,text)',
  'public.search_notes(text,text,integer,integer)'
]) as target(signature);

select ok(to_regprocedure('public.update_space(text,jsonb,text)') is null, 'revisionless update_space overload is absent');
select ok(to_regprocedure('public.archive_space(text,boolean,text)') is null, 'revisionless archive_space overload is absent');
select ok(to_regprocedure('public.delete_tag(text,text)') is null, 'revisionless delete_tag overload is absent');
select ok(to_regprocedure('public.restore_note_revision(text,integer,integer,text)') is null, 'numeric revision restore overload is absent');
select ok(
  not has_function_privilege(
    'authenticated',
    'private.claim_idempotency(uuid,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot call the idempotency ledger helper'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.note_snapshot_with_relations(public.notes)',
    'EXECUTE'
  ),
  'authenticated cannot call the relation snapshot helper'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.restore_note_relations(uuid,text,jsonb,text)',
    'EXECUTE'
  ),
  'authenticated cannot call the relation restore helper'
);

select * from finish();
rollback;
