-- =====================================================================
-- CAD Hub 0003: call the bundle-export Edge Function when an export may
-- be ready to zip (or has failed).
--
--   * conversion_jobs: a job reaches succeeded/failed/canceled while it
--     belongs to an unfinished export
--   * exports: a new export is created (its jobs may all have been reused
--     and already succeeded)
--
-- pg_net queues the request and sends it only after the transaction
-- commits, so request_export()'s export_items are visible to the function.
--
-- One-time setup (SQL editor; secrets never live in migrations):
--
--   select vault.create_secret(
--     'https://<project-ref>.supabase.co/functions/v1/bundle-export',
--     'bundle_export_url');
--   select vault.create_secret('<long random string>', 'export_webhook_secret');
--
-- and give the function the same secret:
--
--   npx supabase secrets set EXPORT_WEBHOOK_SECRET=<long random string>
--   npx supabase functions deploy bundle-export
--
-- Until both vault secrets exist the triggers do nothing.
-- =====================================================================

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_bundle_export(p_payload jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'bundle_export_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'export_webhook_secret';
  if v_url is null or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url                  := v_url,
    body                 := p_payload,
    headers              := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    timeout_milliseconds := 10000
  );
exception when others then
  -- Never fail the job/export write because the notification couldn't be queued.
  raise warning 'notify_bundle_export: %', sqlerrm;
end $$;

revoke execute on function public.notify_bundle_export(jsonb) from public, anon, authenticated;

create or replace function public.on_conversion_job_finished()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1
    from export_items ei
    join exports e on e.id = ei.export_id
    where ei.conversion_job_id = new.id and e.status = 'queued'
  ) then
    perform notify_bundle_export(jsonb_build_object(
      'type', tg_op, 'table', tg_table_name, 'schema', tg_table_schema,
      'record', jsonb_build_object('id', new.id, 'status', new.status),
      'old_record', jsonb_build_object('id', old.id, 'status', old.status)
    ));
  end if;
  return new;
end $$;

create trigger conversion_job_finished
  after update of status on public.conversion_jobs
  for each row
  when (old.status is distinct from new.status and new.status in ('succeeded', 'failed', 'canceled'))
  execute function public.on_conversion_job_finished();

create or replace function public.on_export_created()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_bundle_export(jsonb_build_object(
    'type', tg_op, 'table', tg_table_name, 'schema', tg_table_schema,
    'record', jsonb_build_object('id', new.id, 'status', new.status),
    'old_record', null
  ));
  return new;
end $$;

create trigger export_created
  after insert on public.exports
  for each row execute function public.on_export_created();
