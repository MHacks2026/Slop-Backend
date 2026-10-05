-- =====================================================================
-- CAD Hub 0006: SOLIDWORKS agents and extraction requests.
--
-- The extractor (extractors/solidworks) runs as an agent on the user's
-- Windows machine, next to SOLIDWORKS. The backend cannot reach that
-- machine, so the agent calls out: it polls the Worker for work, reads the
-- part from SOLIDWORKS, and posts the IR back, which queues a build.
--
--   agents       one per paired machine; the agent signs its requests with
--                a token whose SHA-256 is stored here. status is its last
--                heartbeat (SOLIDWORKS running, open documents).
--   extractions  "read this part from my SOLIDWORKS and build it": queued
--                by a user for one of their own agents, claimed by that
--                agent, finished with the IR (-> a build) or an error.
--
-- Writers: request_extraction() for users (or the Worker on their behalf);
-- agent_poll(), agent_progress(), complete_extraction(),
-- fail_extraction() for the Worker acting for an agent (service role).
-- Readers: owners see their agents; project readers see extractions.
-- =====================================================================

create table public.agents (
  id            uuid primary key default gen_random_uuid(),
  owner_id      text not null references public.profiles(id) on delete cascade,
  name          text not null,
  /** SHA-256 (hex) of the agent's token. The token itself is shown once, at pairing. */
  token_hash    text not null unique,
  /** Last heartbeat: { version, solidworks: { running, release, activeDocument, documents } }. */
  status        jsonb not null default '{}'::jsonb,
  /** Online = seen in the last 30 seconds (polls every ~2 s, progress every few seconds while busy). */
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index on public.agents (owner_id);

create table public.extractions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  agent_id      uuid not null references public.agents(id) on delete cascade,
  requested_by  text references public.profiles(id) on delete set null,
  /** {"kind":"active"} (the part in front of the user) or {"kind":"path","path":"C:\\parts\\plate.SLDPRT"}. */
  target        jsonb not null default '{"kind":"active"}'::jsonb,
  /** Planner for the build this extraction queues. */
  planner       text not null default 'rules' check (planner in ('rules', 'claude')),
  /**
   * Driving dimensions to perturb for Level 3 evidence. 0 by default: on an
   * open document the extractor changes and restores the user's dimensions.
   */
  behavior      int not null default 0 check (behavior between 0 and 10),
  status        public.job_status not null default 'queued',
  /** The agent's latest progress line. */
  progress      text,
  error         text,
  /** The extractor's report (<part>.extract.json): what was and was not carried. */
  report        jsonb,
  build_id      uuid references public.builds(id) on delete set null,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index on public.extractions (project_id, created_at desc);
create index extractions_queue_idx on public.extractions (agent_id, created_at) where status = 'queued';

-- ---------------------------------------------------------------------
-- Row Level Security. token_hash is never readable by clients.
-- ---------------------------------------------------------------------
alter table public.agents      enable row level security;
alter table public.extractions enable row level security;

revoke all on public.agents from anon, authenticated;
grant select (id, owner_id, name, status, last_seen_at, created_at, revoked_at) on public.agents to authenticated;
create policy "read own agents" on public.agents for select using (owner_id = public.current_uid());

revoke insert, update, delete on public.extractions from anon, authenticated;
create policy "read extractions" on public.extractions for select using (public.can_read_project(project_id));

-- ---------------------------------------------------------------------
-- request_extraction: ask one of your agents to read a part and build it.
-- Contributors and above, on your own agent, which must be online, and you
-- must have Onshape keys on file (the build runs with them).
--
-- Users call it with their JWT (p_uid null); the Worker calls it with the
-- service role and the verified uid, as with request_build.
-- ---------------------------------------------------------------------
create or replace function public.request_extraction(
  p_project_id uuid,
  p_agent_id   uuid,
  p_target     jsonb default '{"kind":"active"}'::jsonb,
  p_planner    text default 'rules',
  p_behavior   int default 0,
  p_uid        text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_jwt_uid text := public.current_uid();
  v_uid     text;
  v_agent   agents;
  v_id      uuid;
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
  if p_behavior is null or p_behavior < 0 or p_behavior > 10 then
    raise exception 'behavior must be between 0 and 10' using errcode = '22023';
  end if;
  if jsonb_typeof(p_target) is distinct from 'object'
     or coalesce(p_target->>'kind', '') not in ('active', 'path')
     or (p_target->>'kind' = 'path' and coalesce(p_target->>'path', '') !~* '\.sldprt$') then
    raise exception 'target must be {"kind":"active"} or {"kind":"path","path":"...SLDPRT"}' using errcode = '22023';
  end if;

  select * into v_agent from agents where id = p_agent_id;
  if not found or v_agent.owner_id <> v_uid or v_agent.revoked_at is not null then
    raise exception 'agent not found' using errcode = 'P0002';
  end if;
  if v_agent.last_seen_at is null or v_agent.last_seen_at < now() - interval '30 seconds' then
    raise exception 'the SOLIDWORKS agent is offline' using errcode = '55000';
  end if;
  if not exists (select 1 from onshape_credentials where user_id = v_uid) then
    raise exception 'connect your Onshape account first' using errcode = '55000';
  end if;

  insert into extractions (project_id, agent_id, requested_by, target, planner, behavior)
  values (p_project_id, p_agent_id, v_uid, p_target, p_planner, p_behavior)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.request_extraction(uuid, uuid, jsonb, text, int, text) from public, anon;
grant  execute on function public.request_extraction(uuid, uuid, jsonb, text, int, text) to authenticated;

-- ---------------------------------------------------------------------
-- agent_poll: heartbeat and claim in one call. Records the agent's status,
-- then hands it the oldest queued extraction, if any. Service role only.
--
-- An agent polls only when it is idle, so an extraction still processing
-- for it was cut off (the agent was stopped or crashed) and is failed.
-- ---------------------------------------------------------------------
create or replace function public.agent_poll(p_agent_id uuid, p_status jsonb)
returns setof public.extractions
language plpgsql security definer set search_path = public as $$
begin
  update agents set status = coalesce(p_status, '{}'::jsonb), last_seen_at = now()
   where id = p_agent_id and revoked_at is null;
  if not found then
    raise exception 'unknown or revoked agent' using errcode = '42501';
  end if;

  update extractions
     set status = 'failed', error = 'the SOLIDWORKS agent restarted before finishing', finished_at = now(), updated_at = now()
   where agent_id = p_agent_id and status = 'processing';

  return query
  update extractions e
     set status = 'processing', claimed_at = now(), updated_at = now()
   where e.id = (
     select id from extractions
      where agent_id = p_agent_id and status = 'queued'
      order by created_at
      for update skip locked
      limit 1
   )
  returning e.*;
end $$;

revoke execute on function public.agent_poll(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- agent_progress: a progress line from the agent working on an extraction;
-- also its heartbeat while busy. Returns the extraction's status (the agent
-- stops if it is no longer processing), or null when it is not this
-- agent's. Service role only.
-- ---------------------------------------------------------------------
create or replace function public.agent_progress(p_extraction_id uuid, p_agent_id uuid, p_line text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_status public.job_status;
begin
  update agents set last_seen_at = now() where id = p_agent_id and revoked_at is null;
  update extractions
     set progress = coalesce(left(p_line, 500), progress), updated_at = now()
   where id = p_extraction_id and agent_id = p_agent_id and status = 'processing'
  returning status into v_status;
  if v_status is null then
    select status into v_status from extractions where id = p_extraction_id and agent_id = p_agent_id;
  end if;
  return v_status::text;
end $$;

revoke execute on function public.agent_progress(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- complete_extraction: the agent's IR. Queues the build as the user who
-- asked for the extraction (request_build checks they may) and links it.
-- Atomic: if the build can't be queued, nothing changes. Service role only.
-- ---------------------------------------------------------------------
create or replace function public.complete_extraction(
  p_extraction_id uuid,
  p_agent_id      uuid,
  p_ir            jsonb,
  p_report        jsonb default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_ext   extractions;
  v_build uuid;
begin
  select * into v_ext from extractions where id = p_extraction_id and agent_id = p_agent_id for update;
  if not found then
    raise exception 'extraction not found' using errcode = 'P0002';
  end if;
  if v_ext.status <> 'processing' then
    raise exception 'extraction is %, not processing', v_ext.status using errcode = '55000';
  end if;

  v_build := public.request_build(v_ext.project_id, p_ir, v_ext.planner, null, v_ext.requested_by);

  update extractions
     set status = 'succeeded', report = p_report, build_id = v_build, finished_at = now(), updated_at = now()
   where id = p_extraction_id;
  update agents set last_seen_at = now() where id = p_agent_id;
  return v_build;
end $$;

revoke execute on function public.complete_extraction(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- fail_extraction: the agent could not extract (or its IR was refused).
-- Returns false when the extraction was not this agent's or not processing.
-- Service role only.
-- ---------------------------------------------------------------------
create or replace function public.fail_extraction(
  p_extraction_id uuid,
  p_agent_id      uuid,
  p_error         text,
  p_report        jsonb default null
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update extractions
     set status = 'failed', error = left(coalesce(nullif(btrim(p_error), ''), 'extraction failed'), 4000),
         report = coalesce(p_report, report), finished_at = now(), updated_at = now()
   where id = p_extraction_id and agent_id = p_agent_id and status = 'processing';
  if not found then
    return false;
  end if;
  update agents set last_seen_at = now() where id = p_agent_id;
  return true;
end $$;

revoke execute on function public.fail_extraction(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: extraction status and progress. Agents are left out: their
-- heartbeat rewrites the row every few seconds.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.extractions;
