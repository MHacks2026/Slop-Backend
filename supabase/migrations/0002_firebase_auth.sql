-- =====================================================================
-- CAD Hub 0002: switch from Supabase Auth to Firebase Auth (third-party
-- auth), private profile emails, invites, and exports.
--
-- Firebase UIDs are opaque strings, not UUIDs, so every user reference
-- becomes text and auth.uid() is replaced by public.current_uid().
-- =====================================================================

-- ---------------------------------------------------------------------
-- Caller identity
-- ---------------------------------------------------------------------
create or replace function public.current_uid()
returns text language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '');
$$;

-- ---------------------------------------------------------------------
-- Drop Supabase Auth coupling
-- ---------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- Policies that reference user columns must go before their types change.
drop policy "update own profile" on public.profiles;
drop policy "create projects"    on public.projects;
drop policy "add members"        on public.project_members;
drop policy "edit members"       on public.project_members;
drop policy "remove members"     on public.project_members;
drop policy "create parts"       on public.parts;
drop policy "upload blobs"       on public.file_blobs;
drop policy "request jobs"       on public.conversion_jobs;

alter table public.profiles        drop constraint profiles_id_fkey;
alter table public.projects        drop constraint projects_owner_id_fkey;
alter table public.project_members drop constraint project_members_user_id_fkey;
alter table public.parts           drop constraint parts_created_by_fkey;
alter table public.file_blobs      drop constraint file_blobs_uploaded_by_fkey;
alter table public.commits         drop constraint commits_author_id_fkey;
alter table public.branches        drop constraint branches_created_by_fkey;
alter table public.tags            drop constraint tags_created_by_fkey;
alter table public.conversion_jobs drop constraint conversion_jobs_requested_by_fkey;

alter table public.profiles        alter column id           type text using id::text;
alter table public.projects        alter column owner_id     type text using owner_id::text;
alter table public.project_members alter column user_id      type text using user_id::text;
alter table public.parts           alter column created_by   type text using created_by::text;
alter table public.file_blobs      alter column uploaded_by  type text using uploaded_by::text;
alter table public.commits         alter column author_id    type text using author_id::text;
alter table public.branches        alter column created_by   type text using created_by::text;
alter table public.tags            alter column created_by   type text using created_by::text;
alter table public.conversion_jobs alter column requested_by type text using requested_by::text;

alter table public.projects        add constraint projects_owner_id_fkey
  foreign key (owner_id)     references public.profiles(id) on delete cascade;
alter table public.project_members add constraint project_members_user_id_fkey
  foreign key (user_id)      references public.profiles(id) on delete cascade;
alter table public.parts           add constraint parts_created_by_fkey
  foreign key (created_by)   references public.profiles(id) on delete set null;
alter table public.file_blobs      add constraint file_blobs_uploaded_by_fkey
  foreign key (uploaded_by)  references public.profiles(id) on delete set null;
alter table public.commits         add constraint commits_author_id_fkey
  foreign key (author_id)    references public.profiles(id) on delete set null;
alter table public.branches        add constraint branches_created_by_fkey
  foreign key (created_by)   references public.profiles(id) on delete set null;
alter table public.tags            add constraint tags_created_by_fkey
  foreign key (created_by)   references public.profiles(id) on delete set null;
alter table public.conversion_jobs add constraint conversion_jobs_requested_by_fkey
  foreign key (requested_by) references public.profiles(id) on delete set null;

-- ---------------------------------------------------------------------
-- Functions that used auth.uid()
-- ---------------------------------------------------------------------
create or replace function public.has_project_role(p_project uuid, p_min public.project_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from project_members m
    where m.project_id = p_project and m.user_id = public.current_uid() and m.role >= p_min
  );
$$;

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
  values (p_project_id, v_branch.head_commit_id, public.current_uid(), p_message)
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

-- ---------------------------------------------------------------------
-- Profiles: private email, created via ensure_profile()
-- ---------------------------------------------------------------------
alter table public.profiles add column email citext;
create index on public.profiles (email);

-- Column-level grants keep email unreadable to clients. Clients must
-- select profile columns explicitly (select=* would hit email and fail).
revoke select, insert, update on public.profiles from anon, authenticated;
grant select (id, username, display_name, avatar_url, created_at) on public.profiles to anon, authenticated;
grant update (username, display_name, avatar_url)                 on public.profiles to authenticated;

create policy "update own profile" on public.profiles for update
  using (id = public.current_uid()) with check (id = public.current_uid());

-- Upserts the caller's profile. Email comes from the verified token, never
-- the client. Returns no row when the caller has no profile yet and gave no
-- username: the client should send them to onboarding.
create or replace function public.ensure_profile(
  p_username     text default null,
  p_display_name text default null,
  p_avatar_url   text default null
) returns setof public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_uid   text := public.current_uid();
  v_email text := case when (auth.jwt() ->> 'email_verified')::boolean
                       then auth.jwt() ->> 'email' end;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if p_username is null then
    update profiles
       set display_name = coalesce(p_display_name, display_name),
           avatar_url   = coalesce(p_avatar_url, avatar_url),
           email        = coalesce(v_email, email)
     where id = v_uid;
  else
    insert into profiles (id, username, display_name, avatar_url, email)
    values (v_uid, lower(p_username), p_display_name, p_avatar_url, v_email)
    on conflict (id) do update
      set username     = excluded.username,
          display_name = coalesce(excluded.display_name, profiles.display_name),
          avatar_url   = coalesce(excluded.avatar_url, profiles.avatar_url),
          email        = coalesce(excluded.email, profiles.email);
  end if;

  return query select * from profiles where id = v_uid;
end $$;

revoke execute on function public.ensure_profile(text, text, text) from public, anon;
grant  execute on function public.ensure_profile(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Projects & membership policies
-- ---------------------------------------------------------------------
create policy "create projects" on public.projects for insert
  with check (owner_id = public.current_uid());

-- The owner's membership row is added by an AFTER trigger, so without the
-- owner_id check `insert ... returning` (supabase-js .insert().select())
-- fails RLS on the new row.
drop policy "read projects" on public.projects;
create policy "read projects" on public.projects for select
  using (owner_id = public.current_uid() or public.can_read_project(id));

-- Only owners may grant 'owner'.
create policy "add members" on public.project_members for insert
  with check (
    public.has_project_role(project_id, 'maintainer')
    and (role <> 'owner' or public.has_project_role(project_id, 'owner'))
  );
create policy "edit members" on public.project_members for update
  using (public.has_project_role(project_id, 'maintainer'))
  with check (role <> 'owner' or public.has_project_role(project_id, 'owner'));
create policy "remove members" on public.project_members for delete
  using (public.has_project_role(project_id, 'maintainer') or user_id = public.current_uid());

-- Owner rows can only be changed or removed by owners, and a project always
-- keeps at least one owner. Skipped when the project itself is being deleted.
create or replace function public.guard_project_owners()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from projects where id = old.project_id) then
    return coalesce(new, old);
  end if;

  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if not has_project_role(old.project_id, 'owner') then
      raise exception 'only owners can change or remove an owner' using errcode = '42501';
    end if;
    if not exists (
      select 1 from project_members
      where project_id = old.project_id and role = 'owner' and user_id <> old.user_id
    ) then
      raise exception 'a project must keep at least one owner' using errcode = '23514';
    end if;
  end if;

  return coalesce(new, old);
end $$;

create trigger guard_project_owners
  before update or delete on public.project_members
  for each row execute function public.guard_project_owners();

-- ---------------------------------------------------------------------
-- Parts / blobs / jobs policies
-- ---------------------------------------------------------------------
create policy "create parts" on public.parts for insert
  with check (public.has_project_role(project_id, 'contributor') and created_by = public.current_uid());

create policy "upload blobs" on public.file_blobs for insert
  with check (public.has_project_role(project_id, 'contributor') and uploaded_by = public.current_uid());

create policy "request jobs" on public.conversion_jobs for insert
  with check (
    public.current_uid() is not null
    and requested_by = public.current_uid()
    and public.can_read_project(project_id)
  );

-- ---------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------
create table public.project_invites (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  email       citext not null,
  role        public.project_role not null default 'viewer',
  invited_by  text references public.profiles(id) on delete set null,
  token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz
);
create unique index project_invites_pending_uq
  on public.project_invites (project_id, email) where accepted_at is null;
create index on public.project_invites (email) where accepted_at is null;

alter table public.project_invites enable row level security;

create policy "read invites" on public.project_invites for select
  using (public.has_project_role(project_id, 'maintainer'));
create policy "create invites" on public.project_invites for insert
  with check (
    public.has_project_role(project_id, 'maintainer')
    and invited_by = public.current_uid()
    and (role <> 'owner' or public.has_project_role(project_id, 'owner'))
  );
create policy "edit invites" on public.project_invites for update
  using (public.has_project_role(project_id, 'maintainer'))
  with check (role <> 'owner' or public.has_project_role(project_id, 'owner'));
create policy "revoke invites" on public.project_invites for delete
  using (public.has_project_role(project_id, 'maintainer'));

-- Adds an existing user (by username or email) as a member, or creates a
-- pending invite for an unknown email.
-- Returns {"kind": "member", "user_id": ...} or {"kind": "invite", "invite_id": ...}.
create or replace function public.add_member_by_identifier(
  p_project_id uuid,
  p_identifier text,
  p_role       public.project_role
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ident  text := btrim(p_identifier);
  v_user   text;
  v_invite uuid;
begin
  if not has_project_role(p_project_id, 'maintainer') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_role = 'owner' and not has_project_role(p_project_id, 'owner') then
    raise exception 'only owners can add owners' using errcode = '42501';
  end if;
  if v_ident is null or v_ident = '' then
    raise exception 'username or email required' using errcode = '22023';
  end if;

  select id into v_user from profiles
  where username = v_ident::citext or email = v_ident::citext
  limit 1;

  if v_user is not null then
    if exists (select 1 from project_members where project_id = p_project_id and user_id = v_user) then
      raise exception 'already a member' using errcode = '23505';
    end if;
    insert into project_members (project_id, user_id, role) values (p_project_id, v_user, p_role);
    return jsonb_build_object('kind', 'member', 'user_id', v_user);
  end if;

  if position('@' in v_ident) = 0 then
    raise exception 'no user named %', v_ident using errcode = 'P0002';
  end if;

  insert into project_invites (project_id, email, role, invited_by)
  values (p_project_id, v_ident, p_role, public.current_uid())
  on conflict (project_id, email) where accepted_at is null
    do update set role = excluded.role, invited_by = excluded.invited_by
  returning id into v_invite;

  -- TODO(invite-email): send the invitation email here (or from an Edge
  -- Function listening to project_invites inserts). Until then, invites are
  -- claimed automatically when the invitee signs in with this email.

  return jsonb_build_object('kind', 'invite', 'invite_id', v_invite);
end $$;

revoke execute on function public.add_member_by_identifier(uuid, text, public.project_role) from public, anon;
grant  execute on function public.add_member_by_identifier(uuid, text, public.project_role) to authenticated;

-- Converts pending invites for the caller's verified email into memberships.
-- Returns the number of projects joined.
create or replace function public.accept_pending_invites()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_uid   text := public.current_uid();
  v_email text := case when (auth.jwt() ->> 'email_verified')::boolean
                       then auth.jwt() ->> 'email' end;
  v_count integer;
begin
  if v_uid is null or v_email is null
     or not exists (select 1 from profiles where id = v_uid) then
    return 0;
  end if;

  with accepted as (
    update project_invites
       set accepted_at = now()
     where email = v_email::citext and accepted_at is null
    returning project_id, role
  ), joined as (
    insert into project_members (project_id, user_id, role)
    select project_id, v_uid, role from accepted
    on conflict (project_id, user_id)
      do update set role = greatest(project_members.role, excluded.role)
    returning 1
  )
  select count(*) into v_count from joined;

  return v_count;
end $$;

revoke execute on function public.accept_pending_invites() from public, anon;
grant  execute on function public.accept_pending_invites() to authenticated;

-- ---------------------------------------------------------------------
-- Exports
-- ---------------------------------------------------------------------
create table public.exports (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects(id) on delete cascade,
  commit_id           uuid not null references public.commits(id) on delete cascade,
  target_format       text not null references public.target_formats(code),
  options             jsonb not null default '{}'::jsonb,
  status              public.job_status not null default 'queued',
  error               text,
  requested_by        text references public.profiles(id) on delete set null,
  output_storage_path text,  -- cad-derived/{project_id}/exports/{export_id}.zip
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);
create index on public.exports (project_id, created_at desc);

create table public.export_items (
  export_id         uuid not null references public.exports(id) on delete cascade,
  part_id           uuid not null references public.parts(id) on delete cascade,
  blob_id           uuid not null references public.file_blobs(id),
  path              text not null,
  conversion_job_id uuid not null references public.conversion_jobs(id),
  primary key (export_id, part_id)
);
create index on public.export_items (conversion_job_id);

alter table public.exports      enable row level security;
alter table public.export_items enable row level security;

-- Read-only to clients; created via request_export(), finished by bundle-export.
create policy "read exports" on public.exports for select
  using (public.can_read_project(project_id));
create policy "read export items" on public.export_items for select
  using (exists (select 1 from public.exports e where e.id = export_id and public.can_read_project(e.project_id)));

-- Resolves p_paths (files or folder prefixes) against the commit snapshot.
-- An empty or null p_paths exports the whole commit.
create or replace function public.request_export(
  p_project_id    uuid,
  p_commit_id     uuid,
  p_paths         text[],
  p_target_format text,
  p_options       jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid     text := public.current_uid();
  v_options jsonb := coalesce(p_options, '{}'::jsonb);
  v_export  uuid;
begin
  if v_uid is null or not can_read_project(p_project_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (select 1 from commits where id = p_commit_id and project_id = p_project_id) then
    raise exception 'commit not found in this project' using errcode = 'P0002';
  end if;
  if not exists (select 1 from target_formats where code = p_target_format and enabled) then
    raise exception 'format % is not available', p_target_format using errcode = '22023';
  end if;

  create temp table _export_sel on commit drop as
  select cp.part_id, cp.blob_id, cp.path
  from commit_parts cp
  where cp.commit_id = p_commit_id
    and (
      coalesce(cardinality(p_paths), 0) = 0
      or exists (
        select 1 from unnest(p_paths) as sel(p)
        where btrim(sel.p, '/') = ''
           or cp.path = btrim(sel.p, '/')
           or starts_with(cp.path, btrim(sel.p, '/') || '/')
      )
    );

  if not exists (select 1 from _export_sel) then
    raise exception 'selection matches no files' using errcode = 'P0002';
  end if;

  -- One job per distinct blob. Succeeded and in-flight jobs are reused;
  -- failed or canceled ones are requeued.
  insert into conversion_jobs (project_id, blob_id, target_format, options, requested_by)
  select distinct p_project_id, s.blob_id, p_target_format, v_options, v_uid
  from _export_sel s
  on conflict (blob_id, target_format, options) do update
    set status      = case when conversion_jobs.status in ('failed', 'canceled')
                           then 'queued'::job_status else conversion_jobs.status end,
        error       = case when conversion_jobs.status in ('failed', 'canceled')
                           then null else conversion_jobs.error end,
        finished_at = case when conversion_jobs.status in ('failed', 'canceled')
                           then null else conversion_jobs.finished_at end;

  insert into exports (project_id, commit_id, target_format, options, requested_by)
  values (p_project_id, p_commit_id, p_target_format, v_options, v_uid)
  returning id into v_export;

  insert into export_items (export_id, part_id, blob_id, path, conversion_job_id)
  select v_export, s.part_id, s.blob_id, s.path, j.id
  from _export_sel s
  join conversion_jobs j
    on j.blob_id = s.blob_id and j.target_format = p_target_format and j.options = v_options;

  return v_export;
end $$;

revoke execute on function public.request_export(uuid, uuid, text[], text, jsonb) from public, anon;
grant  execute on function public.request_export(uuid, uuid, text[], text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: export progress
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.conversion_jobs, public.exports;
