# Slop-Backend

Backend for CAD Hub: the Supabase schema (`supabase/migrations/`) and a Cloudflare Worker (`src/`) that grants Supabase access to Firebase users.

## How auth works

Users sign in with **Firebase Auth**. The frontend sends the Firebase ID token straight to **Supabase**, which accepts it through its third-party auth integration with Firebase. Database permissions (RLS) identify the caller with `public.current_uid()`, which returns the Firebase UID (`sub` claim).

Supabase only accepts Firebase tokens that carry the custom claim `role: "authenticated"`. The Worker sets this claim:

1. After sign-in, the frontend checks the token's claims.
2. If `role` is missing, it calls `POST /api/auth/claim` with `Authorization: Bearer <firebase id token>`.
3. The Worker verifies the token and sets the claim through the Identity Toolkit API, using the Firebase service account. This is the same as the Admin SDK's `setCustomUserClaims`, which doesn't run on Workers.
4. The frontend force-refreshes the token with `getIdToken(true)` and then calls `ensure_profile` and `accept_pending_invites`.

The Worker does this instead of a Firebase Cloud Function, so the Blaze plan isn't needed. It overwrites any other custom claims on the user.

## Setup

Requires Node 22 (`nvm use`).

1. **Secrets.** Copy `.dev.vars.example` to `.dev.vars` and fill it in:
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys.
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: Firebase console → Project settings → Service accounts → *Generate new private key*. Take `project_id`, `client_email` and `private_key` from the JSON. Keep the `\n` escapes and quote the key.
2. **Enable the Firebase integration in Supabase.** Supabase dashboard → Authentication → Sign In / Providers → Third-party auth → *Add provider* → Firebase, with project ID `mhacks-2026`.
3. **Enable sign-in methods in Firebase.** Firebase console → Authentication → Sign-in method → turn on *Google* and *Email/Password*.
4. **Apply migrations** in order: `0001_cad_hub_schema.sql`, then `0002_firebase_auth.sql`. Either run `npx supabase db push` after `npx supabase link`, or paste each file into the Supabase SQL editor.
5. **Run the Worker:** `npm install && npm run dev` (serves on `http://localhost:8787`).

## Deploy

```sh
npx wrangler login
npx wrangler secret bulk .dev.vars   # or: npx wrangler secret put <NAME>
npm run deploy
```

After deploying, set the frontend's `VITE_API_URL` to the Worker's URL.

## Migrations

| File | Contents |
|---|---|
| `0001_cad_hub_schema.sql` | Projects, parts, content-addressed blobs, commits/snapshots, branches, tags, conversion jobs, RLS, storage buckets, `create_commit`, `claim_conversion_job` |
| `0002_firebase_auth.sql` | Firebase UIDs (`text`) in place of `auth.users` UUIDs, `current_uid()`, `ensure_profile`, private `profiles.email`, owner-protection trigger, `project_invites` + `add_member_by_identifier` / `accept_pending_invites`, `exports` / `export_items` + `request_export`, Realtime for export progress |

`profiles.email` is hidden with column-level grants, so clients must list profile columns explicitly (`select("id, username, display_name, avatar_url")`). `select("*")` on `profiles` returns a permission error.
