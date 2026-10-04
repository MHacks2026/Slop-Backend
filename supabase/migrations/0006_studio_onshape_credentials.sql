-- =====================================================================
-- CAD Hub 0006: Onshape keys for live migrations.
--
-- The studio server (packages/server) rebuilds a part in the signed-in
-- user's Onshape document while they watch. It verifies the user's
-- Firebase ID token itself, then reads that user's keys here, so the
-- browser never handles the secret key after sign-up (it goes in once,
-- through PUT /api/me/onshape; see 0005).
--
-- Same shape as build_onshape_credentials(), keyed by user instead of by
-- build. Service role only.
-- =====================================================================

create or replace function public.user_onshape_credentials(p_uid text)
returns table (access_key text, secret_key text, onshape_name text)
language sql stable security definer set search_path = public as $$
  select c.access_key, s.decrypted_secret, c.onshape_name
    from onshape_credentials c
    join vault.decrypted_secrets s on s.id = c.secret_key_vault_id
   where c.user_id = p_uid;
$$;

revoke execute on function public.user_onshape_credentials(text) from public, anon, authenticated;
