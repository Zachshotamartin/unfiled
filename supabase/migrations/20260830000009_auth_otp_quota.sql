-- Privacy-safe durable OTP request quota. Callers supply HMAC-SHA256 digests;
-- plaintext email and IP values never enter PostgreSQL. A rolling one-hour
-- window permits 5 requests per email digest and 20 per IP digest.

create table public.auth_otp_quota_events (
  id bigint generated always as identity primary key,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz not null default now()
);
create index auth_otp_quota_events_email_window
  on public.auth_otp_quota_events (email_hash, attempted_at desc);
create index auth_otp_quota_events_ip_window
  on public.auth_otp_quota_events (ip_hash, attempted_at desc);
create index auth_otp_quota_events_retention
  on public.auth_otp_quota_events (attempted_at);

alter table public.auth_otp_quota_events enable row level security;
alter table public.auth_otp_quota_events force row level security;
revoke all on table public.auth_otp_quota_events from public, anon, authenticated, service_role;
revoke all on sequence public.auth_otp_quota_events_id_seq from public, anon, authenticated, service_role;

create or replace function public.consume_auth_otp_quota(
  p_email_hash text,
  p_ip_hash text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  email_count integer;
  ip_count integer;
  first_lock bigint;
  second_lock bigint;
  email_retry_at timestamptz;
  ip_retry_at timestamptz;
  retry_at timestamptz;
  retry_after_seconds integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_email_hash !~ '^[0-9a-f]{64}$'
    or p_ip_hash !~ '^[0-9a-f]{64}$'
    or p_now is null
  then raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  first_lock := least(
    hashtextextended('email:' || p_email_hash, 0),
    hashtextextended('ip:' || p_ip_hash, 0)
  );
  second_lock := greatest(
    hashtextextended('email:' || p_email_hash, 0),
    hashtextextended('ip:' || p_ip_hash, 0)
  );
  perform pg_advisory_xact_lock(first_lock);
  if second_lock <> first_lock then perform pg_advisory_xact_lock(second_lock); end if;

  delete from public.auth_otp_quota_events
  where attempted_at <= p_now - interval '24 hours';
  select count(*) into email_count from public.auth_otp_quota_events
  where email_hash = p_email_hash
    and attempted_at > p_now - interval '1 hour'
    and attempted_at <= p_now;
  select count(*) into ip_count from public.auth_otp_quota_events
  where ip_hash = p_ip_hash
    and attempted_at > p_now - interval '1 hour'
    and attempted_at <= p_now;
  if email_count >= 5 or ip_count >= 20 then
    if email_count >= 5 then
      select quota_event.attempted_at + interval '1 hour'
      into email_retry_at
      from public.auth_otp_quota_events as quota_event
      where quota_event.email_hash = p_email_hash
        and quota_event.attempted_at > p_now - interval '1 hour'
        and quota_event.attempted_at <= p_now
      order by quota_event.attempted_at, quota_event.id
      offset email_count - 5
      limit 1;
    end if;
    if ip_count >= 20 then
      select quota_event.attempted_at + interval '1 hour'
      into ip_retry_at
      from public.auth_otp_quota_events as quota_event
      where quota_event.ip_hash = p_ip_hash
        and quota_event.attempted_at > p_now - interval '1 hour'
        and quota_event.attempted_at <= p_now
      order by quota_event.attempted_at, quota_event.id
      offset ip_count - 20
      limit 1;
    end if;
    retry_at := case
      when email_retry_at is null then ip_retry_at
      when ip_retry_at is null then email_retry_at
      else greatest(email_retry_at, ip_retry_at)
    end;
    retry_after_seconds := greatest(
      1,
      least(3600, ceil(extract(epoch from retry_at - p_now))::integer)
    );
    raise sqlstate 'PGRST' using
      message = '{"code":"rate_limited","message":"Try requesting another code later.","details":null,"hint":null}',
      detail = jsonb_build_object(
        'status', 429,
        'headers', jsonb_build_object(
          'Retry-After', retry_after_seconds::text
        )
      )::text;
  end if;
  insert into public.auth_otp_quota_events (email_hash, ip_hash, attempted_at)
  values (p_email_hash, p_ip_hash, p_now);
  return jsonb_build_object(
    'allowed', true,
    'emailCount', email_count + 1,
    'ipCount', ip_count + 1,
    'windowSeconds', 3600
  );
end;
$$;

revoke execute on function public.consume_auth_otp_quota(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_auth_otp_quota(text, text, timestamptz)
  to service_role;
