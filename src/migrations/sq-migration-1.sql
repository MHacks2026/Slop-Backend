-- =====================================================================
-- CAD Hub: "GitHub for CAD" schema for Supabase (Postgres 15+)
--
-- Model:
--   projects        ~ repos
--   parts           ~ stable identity of a piece across all versions
--   file_blobs      ~ content-addressed STEP uploads (deduped per project by sha256)
--   commits         ~ immutable snapshots; commit_parts = the full "tree" at that commit
--   branches/tags   ~ named pointers to commits
--   conversion_jobs ~ STEP -> target format, processed by external workers
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------
-- Enums (role order matters: later = more privileged, so >= comparisons work)
-- ---------------------------------------------------------------------
create type public.project_visibility as enum ('public', 'private');
create type public.project_role       as enum ('viewer', 'contributor', 'maintainer', 'owner');
create type public.change_type        as enum ('added', 'modified', 'renamed', 'unchanged');
create type public.job_status         as enum ('queued', 'processing', 'succeeded', 'failed', 'canceled');

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     citext not null unique check (username ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user-' || substr(new.id::text, 1, 8)),
    new.raw_user_meta_data->>'display_name'
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Projects & membership
-- ---------------------------------------------------------------------
create table public.projects (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.profiles(id) on delete cascade,
  slug           citext not null check (slug ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  name           text not null,
  description    text,
  visibility     public.project_visibility not null default 'private',
  default_branch text not null default 'main',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_id, slug)
);

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       public.project_role not null default 'viewer',
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index on public.project_members (user_id);

-- ---------------------------------------------------------------------
-- Parts: stable identity of a piece. Name/path live in commit snapshots
-- so renames and moves are tracked per commit.
-- ---------------------------------------------------------------------
create table public.parts (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null,
  part_number text,
  description text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index on public.parts (project_id);
create unique index parts_project_part_number_uq
  on public.parts (project_id, part_number) where part_number is not null;

-- ---------------------------------------------------------------------
-- File blobs: uploaded STEP files, content-addressed within a project.
-- Storage path convention: cad-source/{project_id}/{sha256}.step
-- ---------------------------------------------------------------------
create table public.file_blobs (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path      text not null,
  size_bytes        bigint not null check (size_bytes >= 0),
  original_filename text,
  source_format     text not null default 'step',      -- step / stp / step-ap242 etc.
  units             text,                               -- mm, in, ...
  bbox              jsonb,                              -- {"min":[x,y,z],"max":[x,y,z]}
  metadata          jsonb not null default '{}'::jsonb, -- volume, mass props, AP schema...
  preview_path      text,                               -- glTF/PNG thumbnail in cad-derived
  uploaded_by       uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (project_id, sha256)
);

-- ---------------------------------------------------------------------
-- Commits and their full snapshots
-- ---------------------------------------------------------------------
create table public.commits (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  parent_id       uuid references public.commits(id),
  merge_parent_id uuid references public.commits(id),   -- second parent for merges
  author_id       uuid references public.profiles(id) on delete set null,
  message         text not null,
  created_at      timestamptz not null default now()
);
create index on public.commits (project_id, created_at desc);
create index on public.commits (parent_id);

-- Every commit lists every part in the tree at that point. A part missing
-- from a commit's snapshot has been deleted in that commit.
create table public.commit_parts (
  commit_id uuid not null references public.commits(id) on delete cascade,
  part_id   uuid not null references public.parts(id) on delete cascade,
  blob_id   uuid not null references public.file_blobs(id),
  path      text not null,                  -- e.g. 'chassis/left-rail.step'
  change    public.change_type not null,
  primary key (commit_id, part_id),
  unique (commit_id, path)
);
create index on public.commit_parts (part_id);   -- fast per-part history
create index on public.commit_parts (blob_id);

-- ---------------------------------------------------------------------
-- Branches & tags
-- ---------------------------------------------------------------------
create table public.branches (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  name           text not null check (name ~ '^[A-Za-z0-9._/-]{1,100}$'),
  head_commit_id uuid references public.commits(id),   -- null until first commit
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, name)
);

create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name       text not null,                -- e.g. 'rev-B', 'v1.2-release'
  commit_id  uuid not null references public.commits(id) on delete cascade,
  message    text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

-- ---------------------------------------------------------------------
-- Conversion targets & jobs
-- ---------------------------------------------------------------------
create table public.target_formats (
  code                  text primary key,
  label                 text not null,
  extension             text not null,
  target_application    text,                          -- null = neutral format
  requires_native_host  boolean not null default false, -- needs the real CAD app (or a paid SDK) to write
  enabled               boolean not null default true
);

insert into public.target_formats (code, label, extension, target_application, requires_native_host) values
  ('iges',    'IGES',                 'igs',     null,         false),
  ('stl',     'STL mesh',             'stl',     null,         false),
  ('3mf',     '3MF mesh',             '3mf',     null,         false),
  ('gltf',    'glTF (web preview)',   'glb',     null,         false),
  ('brep',    'OpenCascade BREP',     'brep',    null,         false),
  ('x_t',     'Parasolid',            'x_t',     null,         true),
  ('sldprt',  'SolidWorks Part',      'sldprt',  'SolidWorks', true),
  ('ipt',     'Inventor Part',        'ipt',     'Inventor',   true),
  ('f3d',     'Fusion 360 Archive',   'f3d',     'Fusion 360', true),
  ('catpart', 'CATIA Part',           'CATPart', 'CATIA',      true),
  ('prt_nx',  'Siemens NX Part',      'prt',     'NX',         true);

-- Conversions are keyed on the blob, so identical STEP content is converted once.
create table public.conversion_jobs (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  blob_id            uuid not null references public.file_blobs(id) on delete cascade,
  target_format      text not null references public.target_formats(code),
  options            jsonb not null default '{}'::jsonb,  -- tessellation tolerance, units, etc.
  status             public.job_status not null default 'queued',
  output_storage_path text,                               -- cad-derived/{project_id}/{blob_sha}/{format}.{ext}
  output_size_bytes  bigint,
  error              text,
  attempts           int not null default 0,
  worker_id          text,
  requested_by       uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  unique (blob_id, target_format, options)
);
create index conversion_jobs_queue_idx
  on public.conversion_jobs (target_format, created_at) where status = 'queued';

-- ---------------------------------------------------------------------
-- Permission helpers (security definer avoids RLS recursion on project_members)
-- ---------------------------------------------------------------------
create or replace function public.has_project_role(p_project uuid, p_min public.project_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from project_members m
    where m.project_id = p_project and m.user_id = auth.uid() and m.role >= p_min
  );
$$;

create or replace function public.can_read_project(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = p_project and visibility = 'public')
      or public.has_project_role(p_project, 'viewer');
$$;

-- New project: creator becomes owner, default branch is created.
create or replace function public.handle_new_project()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into project_members (project_id, user_id, role) values (new.id, new.owner_id, 'owner');
  insert into branches (project_id, name, created_by) values (new.id, new.default_branch, new.owner_id);
  return new;
end $$;

create trigger on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();

-- ---------------------------------------------------------------------
-- Commit RPC: the ONLY way to write commits. Atomic, with optimistic
-- concurrency (fails if the branch head moved since the client last pulled).
--
-- p_entries = full tree after the commit:
--   [{"part_id": "...", "path": "chassis/rail.step", "blob_id": "..."}, ...]
-- Client flow: upload STEP to storage -> insert file_blobs -> insert parts
-- for new pieces -> call create_commit.
-- ---------------------------------------------------------------------
create or replace function public.create_commit(
  p_project_id    uuid,
  p_branch        text,
  p_expected_head uuid,
  p_message       text,
  p_entries       jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_branch branches%rowtype;
  v_commit uuid;
begin
  if not has_project_role(p_project_id, 'contributor') then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  -- every referenced part and blob must belong to this project
  if exists (
    select 1
    from jsonb_to_recordset(p_entries) as e(part_id uuid, path text, blob_id uuid)
    left join parts p      on p.id = e.part_id and p.project_id = p_project_id
    left join file_blobs b on b.id = e.blob_id and b.project_id = p_project_id
    where p.id is null or b.id is null
  ) then
    raise exception 'entries reference parts or files outside this project';
  end if;

  select * into v_branch from branches
  where project_id = p_project_id and name = p_branch
  for update;
  if not found then
    raise exception 'branch % not found', p_branch;
  end if;
  if v_branch.head_commit_id is distinct from p_expected_head then
    raise exception 'branch has moved; pull and retry' using errcode = '40001';
  end if;

  insert into commits (project_id, parent_id, author_id, message)
  values (p_project_id, v_branch.head_commit_id, auth.uid(), p_message)
  returning id into v_commit;

  insert into commit_parts (commit_id, part_id, blob_id, path, change)
  select v_commit, e.part_id, e.blob_id, e.path,
         (case
            when prev.part_id is null      then 'added'
            when prev.blob_id <> e.blob_id then 'modified'
            when prev.path <> e.path       then 'renamed'
            else 'unchanged'
          end)::change_type
  from jsonb_to_recordset(p_entries) as e(part_id uuid, path text, blob_id uuid)
  left join commit_parts prev
    on prev.commit_id = v_branch.head_commit_id and prev.part_id = e.part_id;

  update branches set head_commit_id = v_commit, updated_at = now() where id = v_branch.id;
  update projects set updated_at = now() where id = p_project_id;
  return v_commit;
end $$;

revoke execute on function public.create_commit(uuid, text, uuid, text, jsonb) from public, anon;
grant  execute on function public.create_commit(uuid, text, uuid, text, jsonb) to authenticated;

-- Worker RPC: claim the next queued job for the formats this worker can produce.
-- A SolidWorks box claims {'sldprt'}, an OpenCascade container claims {'stl','iges','gltf',...}.
create or replace function public.claim_conversion_job(p_formats text[], p_worker_id text)
returns setof public.conversion_jobs
language sql security definer set search_path = public as $$
  update conversion_jobs j
     set status = 'processing', started_at = now(), attempts = attempts + 1, worker_id = p_worker_id
   where j.id = (
     select id from conversion_jobs
     where status = 'queued' and target_format = any(p_formats)
     order by created_at
     for update skip locked
     limit 1
   )
  returning j.*;
$$;
revoke execute on function public.claim_conversion_job(text[], text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Convenience view: current files on every branch
-- ---------------------------------------------------------------------
create view public.branch_files with (security_invoker = true) as
select b.project_id,
       b.name        as branch,
       b.head_commit_id,
       cp.part_id,
       p.name        as part_name,
       p.part_number,
       cp.path,
       cp.blob_id,
       fb.sha256,
       fb.storage_path,
       fb.size_bytes
from public.branches b
join public.commit_parts cp on cp.commit_id = b.head_commit_id
join public.parts p         on p.id = cp.part_id
join public.file_blobs fb   on fb.id = cp.blob_id;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.parts           enable row level security;
alter table public.file_blobs      enable row level security;
alter table public.commits         enable row level security;
alter table public.commit_parts    enable row level security;
alter table public.branches        enable row level security;
alter table public.tags            enable row level security;
alter table public.target_formats  enable row level security;
alter table public.conversion_jobs enable row level security;

-- profiles
create policy "profiles readable"  on public.profiles for select using (true);
create policy "update own profile" on public.profiles for update using (id = auth.uid());

-- projects
create policy "read projects"   on public.projects for select using (public.can_read_project(id));
create policy "create projects" on public.projects for insert with check (owner_id = auth.uid());
create policy "edit projects"   on public.projects for update using (public.has_project_role(id, 'maintainer'));
create policy "delete projects" on public.projects for delete using (public.has_project_role(id, 'owner'));

-- members (maintainers manage; tighten so only owners can grant 'owner' if needed)
create policy "read members"   on public.project_members for select using (public.can_read_project(project_id));
create policy "add members"    on public.project_members for insert with check (public.has_project_role(project_id, 'maintainer'));
create policy "edit members"   on public.project_members for update using (public.has_project_role(project_id, 'maintainer'));
create policy "remove members" on public.project_members for delete
  using (public.has_project_role(project_id, 'maintainer') or user_id = auth.uid());

-- parts
create policy "read parts"   on public.parts for select using (public.can_read_project(project_id));
create policy "create parts" on public.parts for insert
  with check (public.has_project_role(project_id, 'contributor') and created_by = auth.uid());
create policy "edit parts"   on public.parts for update using (public.has_project_role(project_id, 'contributor'));

-- file blobs (immutable once uploaded)
create policy "read blobs"   on public.file_blobs for select using (public.can_read_project(project_id));
create policy "upload blobs" on public.file_blobs for insert
  with check (public.has_project_role(project_id, 'contributor') and uploaded_by = auth.uid());

-- commits / snapshots: read-only to clients; writes go through create_commit()
create policy "read commits"      on public.commits for select using (public.can_read_project(project_id));
create policy "read commit parts" on public.commit_parts for select
  using (exists (select 1 from public.commits c where c.id = commit_id and public.can_read_project(c.project_id)));

-- branches: head moves only via create_commit()
create policy "read branches"   on public.branches for select using (public.can_read_project(project_id));
create policy "create branches" on public.branches for insert
  with check (public.has_project_role(project_id, 'contributor'));
create policy "delete branches" on public.branches for delete
  using (public.has_project_role(project_id, 'maintainer'));

-- tags
create policy "read tags"   on public.tags for select using (public.can_read_project(project_id));
create policy "create tags" on public.tags for insert with check (public.has_project_role(project_id, 'contributor'));
create policy "delete tags" on public.tags for delete using (public.has_project_role(project_id, 'maintainer'));

-- formats
create policy "read formats" on public.target_formats for select using (true);

-- conversion jobs: anyone who can read a project can request a conversion;
-- workers update status using the service role (bypasses RLS).
create policy "read jobs"    on public.conversion_jobs for select using (public.can_read_project(project_id));
create policy "request jobs" on public.conversion_jobs for insert
  with check (auth.uid() is not null and requested_by = auth.uid() and public.can_read_project(project_id));

-- ---------------------------------------------------------------------
-- Storage buckets & policies
-- Paths: cad-source/{project_id}/{sha256}.step
--        cad-derived/{project_id}/{sha256}/{format}.{ext}
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('cad-source', 'cad-source', false), ('cad-derived', 'cad-derived', false)
on conflict (id) do nothing;

create policy "read cad files" on storage.objects for select using (
  bucket_id in ('cad-source', 'cad-derived')
  and public.can_read_project(((storage.foldername(name))[1])::uuid)
);

create policy "upload source STEP" on storage.objects for insert with check (
  bucket_id = 'cad-source'
  and public.has_project_role(((storage.foldername(name))[1])::uuid, 'contributor')
);
-- cad-derived is written only by workers via the service role.