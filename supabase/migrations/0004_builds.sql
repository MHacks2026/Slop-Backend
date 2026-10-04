-- =====================================================================
-- CAD Hub 0004: SolidWorks -> Onshape builds.
--
-- A build takes an IR document (extracted on the user's machine), rebuilds
-- it in Onshape feature by feature with per-feature checks, runs the
-- behaviour tests, and stores the report and the accepted plan.
--
--   builds        one migration run per IR document (queue + result)
--   build_events  ordered progress stream written by the runner; the web
--                 app subscribes through Realtime
--
-- Writers: request_build() for users (RLS applies), claim_build() and
-- direct writes for the runner (service role). Readers: anyone who can
-- read the project.
-- =====================================================================

create table public.builds (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects(id) on delete cascade,
  name                   text not null,
  /** The IR document as submitted. Validated by the runner before building. */
  ir                     jsonb not null,
  ir_intent_hash         text,
  planner                text not null default 'rules' check (planner in ('rules', 'claude')),
  status                 public.job_status not null default 'queued',
  error                  text,
  attempts               int not null default 0,
  worker_id              text,
  onshape_document_id    text,
  onshape_workspace_id   text,
  onshape_element_id     text,
  /** report.summary: counts by rung, checks, behaviour results, LLM usage. */
  summary                jsonb,
  /** The full BuildReport. */
  report                 jsonb,
  /** The accepted plan; replaying it reproduces the migration without the LLM. */
  plan                   jsonb,
  requested_by           text references public.profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  started_at             timestamptz,
  finished_at            timestamptz
);
create index on public.builds (project_id, created_at desc);
create index builds_queue_idx on public.builds (created_at) where status = 'queued';

create table public.build_events (
  id          bigserial primary key,
  build_id    uuid not null references public.builds(id) on delete cascade,
  seq         int not null,
  /** document | feature | behavior | log | finished */
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (build_id, seq)
);
create index on public.build_events (build_id, seq);

-- ---------------------------------------------------------------------
-- Row Level Security: project readers see builds and their events.
-- Writes go through request_build() or the service role.
-- ---------------------------------------------------------------------
alter table public.builds       enable row level security;
alter table public.build_events enable row level security;

create policy "read builds" on public.builds for select using (public.can_read_project(project_id));
create policy "read build events" on public.build_events for select
  using (exists (select 1 from public.builds b where b.id = build_id and public.can_read_project(b.project_id)));

-- ---------------------------------------------------------------------
-- Identity helpers for the Worker, which uses the service role and so has
-- no JWT claims: the same checks as can_read_project / has_project_role
-- for an explicit uid. Not callable by clients.
-- ---------------------------------------------------------------------
create or replace function public.can_read_project_as(p_project uuid, p_uid text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects p where p.id = p_project and p.visibility = 'public')
      or exists (select 1 from project_members m where m.project_id = p_project and m.user_id = p_uid);
$$;
revoke execute on function public.can_read_project_as(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- request_build: queue a build. Contributors and above.
--
-- Users call it with their JWT (p_uid must be null). The Worker calls it
-- with the service role on behalf of a verified Firebase user and passes
-- p_uid; a user JWT cannot impersonate another user that way.
-- ---------------------------------------------------------------------
create or replace function public.request_build(
  p_project_id uuid,
  p_ir         jsonb,
  p_planner    text default 'rules',
  p_name       text default null,
  p_uid        text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_jwt_uid text := public.current_uid();
  v_uid     text;
  v_name    text;
  v_build   uuid;
begin
  if v_jwt_uid is not null and p_uid is not null and p_uid <> v_jwt_uid then
    raise exception 'p_uid may only be set by the service role' using errcode = '42501';
  end if;
  v_uid := coalesce(v_jwt_uid, p_uid);
  if v_uid is null then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from project_members m
    where m.project_id = p_project_id and m.user_id = v_uid and m.role >= 'contributor'
  ) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if p_planner is null or p_planner not in ('rules', 'claude') then
    raise exception 'planner must be rules or claude' using errcode = '22023';
  end if;
  if jsonb_typeof(p_ir) <> 'object' or p_ir->>'irVersion' is null or jsonb_typeof(p_ir->'partStudio'->'features') <> 'array' then
    raise exception 'ir must be an IR document (irVersion, partStudio.features)' using errcode = '22023';
  end if;

  v_name := nullif(btrim(coalesce(p_name, p_ir->'partStudio'->>'name', '')), '');
  if v_name is null then v_name := 'migration'; end if;

  insert into builds (project_id, name, ir, planner, requested_by)
  values (p_project_id, v_name, p_ir, p_planner, v_uid)
  returning id into v_build;
  return v_build;
end $$;

revoke execute on function public.request_build(uuid, jsonb, text, text, text) from public, anon;
grant  execute on function public.request_build(uuid, jsonb, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- claim_build: the runner takes the oldest queued build. Service role only.
-- ---------------------------------------------------------------------
create or replace function public.claim_build(p_worker_id text)
returns setof public.builds
language sql security definer set search_path = public as $$
  update builds b
     set status = 'processing', started_at = now(), attempts = attempts + 1, worker_id = p_worker_id, error = null
   where b.id = (
     select id from builds
     where status = 'queued'
     order by created_at
     for update skip locked
     limit 1
   )
  returning b.*;
$$;
revoke execute on function public.claim_build(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: build status and progress events
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.builds, public.build_events;
