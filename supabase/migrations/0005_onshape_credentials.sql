-- =====================================================================
-- CAD Hub 0005: each user's Onshape API keys.
--
-- A user enters their Onshape access and secret key once, at sign-up (or
-- later, to replace them), and every build they request runs with those
-- keys, so the Onshape document lands in their own Onshape account.
--
--   onshape_credentials  one row per user holding both halves of their
--                        Onshape API key:
--                          access_key           the access key, as text
--                          secret_key_vault_id  the secret key, encrypted in
--                                               Supabase Vault (this column
--                                               is the vault.secrets id)
--                        plus the Onshape account the keys belong to. Vault
--                        keeps its encryption key outside the database, so
--                        dumps and backups only hold ciphertext.
--
-- Clients never touch this table. The Worker checks keys against Onshape
-- and saves them with set_onshape_credentials(); the runner reads them per
-- build with build_onshape_credentials(). Both are service role only.
--
-- The secret key reaches set_onshape_credentials() as a parameter. Keep
-- Postgres statement logging off (Vault's guidance) so it is never logged.
-- =====================================================================

create extension if not exists supabase_vault;

create table public.onshape_credentials (
  user_id              text primary key references public.profiles(id) on delete cascade,
  /** Onshape access key. */
  access_key           text not null,
  /** Onshape secret key: the vault.secrets id it is stored under, encrypted. Read it through build_onshape_credentials(). */
  secret_key_vault_id  uuid not null,
  /** The Onshape account the keys belong to, from /users/sessioninfo when they were checked. */
  onshape_user_id      text,
  onshape_name         text,
  verified_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- No policies: only the service role reads or writes.
alter table public.onshape_credentials enable row level security;
revoke all on public.onshape_credentials from anon, authenticated;

-- Removing a row (directly, or through the profile cascade) removes the secret.
create or replace function public.drop_onshape_secret()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from vault.secrets where id = old.secret_key_vault_id;
  return old;
end $$;

create trigger onshape_credentials_drop_secret
  after delete on public.onshape_credentials
  for each row execute function public.drop_onshape_secret();

-- ---------------------------------------------------------------------
-- set_onshape_credentials: store or replace a user's keys. Called by the
-- Worker after Onshape accepted them. Needs the user's profile to exist
-- (ensure_profile); otherwise fails with 23503 and nothing is stored.
-- ---------------------------------------------------------------------
create or replace function public.set_onshape_credentials(
  p_uid             text,
  p_access_key      text,
  p_secret_key      text,
  p_onshape_user_id text default null,
  p_onshape_name    text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_secret uuid;
begin
  if p_uid is null or nullif(btrim(p_access_key), '') is null or nullif(p_secret_key, '') is null then
    raise exception 'uid, access key and secret key are required' using errcode = '22023';
  end if;

  select secret_key_vault_id into v_secret from onshape_credentials where user_id = p_uid for update;
  if v_secret is null then
    v_secret := vault.create_secret(p_secret_key, 'onshape_secret_key:' || p_uid, 'Onshape API secret key');
    insert into onshape_credentials (user_id, access_key, secret_key_vault_id, onshape_user_id, onshape_name)
    values (p_uid, btrim(p_access_key), v_secret, p_onshape_user_id, p_onshape_name);
  else
    perform vault.update_secret(v_secret, p_secret_key);
    update onshape_credentials
       set access_key      = btrim(p_access_key),
           onshape_user_id = p_onshape_user_id,
           onshape_name    = p_onshape_name,
           verified_at     = now(),
           updated_at      = now()
     where user_id = p_uid;
  end if;
end $$;

revoke execute on function public.set_onshape_credentials(text, text, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- build_onshape_credentials: the access key and decrypted secret key a
-- build runs with, those of the user who requested it. No row when that
-- user has none. Runner only.
-- ---------------------------------------------------------------------
create or replace function public.build_onshape_credentials(p_build_id uuid)
returns table (user_id text, access_key text, secret_key text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.access_key, s.decrypted_secret
    from builds b
    join onshape_credentials c on c.user_id = b.requested_by
    join vault.decrypted_secrets s on s.id = c.secret_key_vault_id
   where b.id = p_build_id;
$$;

revoke execute on function public.build_onshape_credentials(uuid) from public, anon, authenticated;
