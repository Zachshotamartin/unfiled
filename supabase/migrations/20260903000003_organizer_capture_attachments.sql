-- The organizer may read the photos and recordings bound to the capture of a
-- job it holds a live lease on, projected the way the claim projects the
-- capture itself: sealed envelope plus the worker-facing key records for the
-- object key and the MAC key. Only AI-assisted attachments are ever listed,
-- because that is the only key class the organizer authority can unwrap.

create function private.list_encrypted_organizer_attachments_impl(
  p_job_id text,
  p_lease_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  attachments_value jsonb;
begin
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'attachmentId', attachment.id,
      'kind', attachment.kind,
      'mediaType', attachment.media_type,
      'byteLength', attachment.byte_length,
      'width', attachment.width,
      'height', attachment.height,
      'durationMs', attachment.duration_ms,
      'source', jsonb_build_object(
        'resourceId', attachment.id,
        'recordVersion', 1,
        'envelope', attachment.content_envelope,
        'keyRecord', private.organizer_key_projection(source_key),
        'contentMac', private.encrypted_mac_projection(
          attachment.content_mac, attachment.mac_key_id,
          attachment.mac_key_class, attachment.mac_key_purpose,
          attachment.mac_key_version
        ),
        'contentMacKeyRecord', private.organizer_key_projection(mac_key),
        'encryptedByteLength', (
          pg_catalog.char_length(
            attachment.content_envelope -> 'payload' ->> 'ciphertext'
          ) * 3 / 4
        )::integer
      )
    )
    order by attachment.created_at, attachment.id
  ), '[]'::jsonb)
  into attachments_value
  from public.capture_attachments as attachment
  join public.user_content_keys as source_key
    on source_key.user_id = attachment.user_id
    and source_key.key_id = attachment.content_key_id
    and source_key.key_class = attachment.content_key_class
    and source_key.key_purpose = attachment.content_key_purpose
    and source_key.key_version = attachment.content_key_version
    and source_key.state in ('active', 'retired')
  join public.user_content_keys as mac_key
    on mac_key.user_id = attachment.user_id
    and mac_key.key_id = attachment.mac_key_id
    and mac_key.key_class = attachment.mac_key_class
    and mac_key.key_purpose = attachment.mac_key_purpose
    and mac_key.key_version = attachment.mac_key_version
    and mac_key.state in ('active', 'retired')
  where attachment.user_id = job_row.user_id
    and attachment.capture_id = job_row.capture_id
    and attachment.privacy = 'ai_assisted'
    and attachment.content_key_class = 'ai_assisted'
    and attachment.bound_at is not null
    and attachment.deleted_at is null;
  return jsonb_build_object(
    'jobId', job_row.id,
    'attachments', attachments_value,
    'returnedCount', jsonb_array_length(attachments_value)
  );
end;
$$;

create function public.list_encrypted_organizer_attachments(
  p_job_id text,
  p_lease_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.list_encrypted_organizer_attachments_impl(p_job_id, p_lease_token);
end;
$$;

revoke execute on function private.list_encrypted_organizer_attachments_impl(
  text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.list_encrypted_organizer_attachments(text, text)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
grant execute on function public.list_encrypted_organizer_attachments(text, text)
to unfiled_organizer_worker;
