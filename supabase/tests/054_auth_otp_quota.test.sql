create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select plan(17);

create function pg_temp.retry_after_seconds(
  email_hash text,
  ip_hash text,
  attempt_at timestamptz
)
returns integer
language plpgsql
as $$
declare
  exception_detail text;
begin
  perform public.consume_auth_otp_quota(email_hash, ip_hash, attempt_at);
  return null;
exception when sqlstate 'PGRST' then
  get stacked diagnostics exception_detail = pg_exception_detail;
  return (exception_detail::jsonb #>> '{headers,Retry-After}')::integer;
end;
$$;

select ok(not has_function_privilege('authenticated', 'public.consume_auth_otp_quota(text,text,timestamptz)', 'EXECUTE'), 'authenticated cannot execute the OTP quota function');
select ok(not has_function_privilege('anon', 'public.consume_auth_otp_quota(text,text,timestamptz)', 'EXECUTE'), 'anonymous cannot execute the OTP quota function');
select ok(has_function_privilege('service_role', 'public.consume_auth_otp_quota(text,text,timestamptz)', 'EXECUTE'), 'service role can execute the OTP quota function');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$select public.consume_auth_otp_quota(repeat('a', 64), repeat('b', 64), '2026-08-30T12:00:00Z')$$,
  '42501', 'permission denied for function consume_auth_otp_quota',
  'authenticated direct quota execution is denied'
);
select throws_ok($$select count(*) from public.auth_otp_quota_events$$, '42501', 'permission denied for table auth_otp_quota_events', 'authenticated cannot read hashed quota state');

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select max((public.consume_auth_otp_quota(repeat('a', 64), encode(digest('ip-' || ordinal::text, 'sha256'), 'hex'), '2026-08-30T12:00:00Z') ->> 'emailCount')::integer) from generate_series(1, 5) as ordinal),
  5,
  'the fifth request for one email is allowed'
);
select is(
  pg_temp.retry_after_seconds(
    repeat('a', 64), repeat('c', 64), '2026-08-30T12:00:00Z'
  ),
  3600,
  'email-only lockout exposes the exact full-window Retry-After'
);
reset role;
select is((select count(*) from public.auth_otp_quota_events where email_hash = repeat('a', 64)), 5::bigint, 'rate-limited email request writes no event');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select max((public.consume_auth_otp_quota(encode(digest('email-' || ordinal::text, 'sha256'), 'hex'), repeat('d', 64), '2026-08-30T14:00:00Z') ->> 'ipCount')::integer) from generate_series(1, 20) as ordinal),
  20,
  'the twentieth request for one IP is allowed'
);
select is(
  pg_temp.retry_after_seconds(
    repeat('e', 64), repeat('d', 64), '2026-08-30T14:00:00Z'
  ),
  3600,
  'IP-only lockout exposes the exact full-window Retry-After'
);
select is(public.consume_auth_otp_quota(repeat('a', 64), repeat('f', 64), '2026-08-30T14:00:00Z') ->> 'emailCount', '1', 'email quota expires after the rolling one-hour window');
select throws_ok($$select public.consume_auth_otp_quota('plaintext@example.test', repeat('f', 64), '2026-08-30T14:00:00Z')$$, '22023', 'validation_failed', 'quota function rejects non-HMAC input');

select is(
  (
    select max((public.consume_auth_otp_quota(
      repeat('1', 64),
      encode(digest('both-email-ip-' || ordinal::text, 'sha256'), 'hex'),
      '2026-08-30T16:00:00Z'
    ) ->> 'emailCount')::integer)
    from generate_series(1, 5) as ordinal
  ),
  5,
  'both-limit fixture fills the email window first'
);
select is(
  (
    select max((public.consume_auth_otp_quota(
      encode(digest('both-ip-email-' || ordinal::text, 'sha256'), 'hex'),
      repeat('2', 64),
      '2026-08-30T16:05:00Z'
    ) ->> 'ipCount')::integer)
    from generate_series(1, 20) as ordinal
  ),
  20,
  'both-limit fixture fills a later IP window'
);
select is(
  pg_temp.retry_after_seconds(
    repeat('1', 64), repeat('2', 64), '2026-08-30T16:10:00Z'
  ),
  3300,
  'a request limited by both dimensions waits for the later permitting deadline'
);
select is(
  (
    select max((public.consume_auth_otp_quota(
      repeat('3', 64),
      encode(digest('near-expiry-ip-' || ordinal::text, 'sha256'), 'hex'),
      '2026-08-30T18:00:00.500Z'
    ) ->> 'emailCount')::integer)
    from generate_series(1, 5) as ordinal
  ),
  5,
  'near-expiry fixture fills one email window'
);
select is(
  pg_temp.retry_after_seconds(
    repeat('3', 64), repeat('4', 64), '2026-08-30T18:59:59.750Z'
  ),
  1,
  'subsecond remainder is ceiled and clamped to a positive Retry-After'
);

select * from finish();
rollback;
