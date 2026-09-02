-- Cluster-global capability roles are seeded before database-local migrations.
-- On managed Supabase, `postgres` has CREATEROLE but is not SUPERUSER. PostgreSQL
-- therefore creates one automatic ADMIN-only management edge, granted by the
-- bootstrap superuser, for each role that `postgres` creates. The migrations
-- accept only that inert platform-management edge (INHERIT/SET both false), or
-- no membership at all after a real superuser removes it.

do $unfiled_capability_roles$
declare
  capability_role text;
begin
  foreach capability_role in array array[
    'unfiled_index_worker',
    'unfiled_rag_verifier',
    'unfiled_search_worker'
  ]
  loop
    if not exists (
      select 1 from pg_catalog.pg_roles where rolname = capability_role
    ) then
      execute format(
        'create role %I nosuperuser nocreatedb nocreaterole noinherit nologin '
          || 'noreplication nobypassrls',
        capability_role
      );
    end if;

    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = capability_role
        and not rolsuper
        and (
          rolcreatedb or rolcreaterole or rolinherit or rolcanlogin
          or rolreplication or rolbypassrls
        )
    ) then
      -- A non-superuser cannot spell NOSUPERUSER in ALTER ROLE, even when the
      -- target is already non-superuser. The final assertion enforces that bit.
      execute format(
        'alter role %I nocreatedb nocreaterole noinherit nologin '
          || 'noreplication nobypassrls',
        capability_role
      );
    end if;

    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = capability_role
        and (
          rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolcanlogin
          or rolreplication or rolbypassrls
        )
    ) then
      raise exception using
        errcode = '42501', message = 'capability_role_attributes_not_reconciled';
    end if;

    if exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as granted
        on granted.oid = membership.roleid
      join pg_catalog.pg_roles as member
        on member.oid = membership.member
      join pg_catalog.pg_roles as grantor
        on grantor.oid = membership.grantor
      where (
        granted.rolname = capability_role
        or member.rolname = capability_role
      )
        and not (
          granted.rolname = capability_role
          and member.rolname = 'postgres'
          and grantor.rolname = 'supabase_admin'
          and membership.admin_option
          and not membership.inherit_option
          and not membership.set_option
        )
    ) then
      raise exception using
        errcode = '42501', message = 'capability_role_membership_not_reconciled';
    end if;
  end loop;
end;
$unfiled_capability_roles$;
