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

### Sign-up

The sign-up form asks for an email, a password, a username, and the user's Onshape API access key and secret key (Onshape → [Developer portal](https://dev-portal.onshape.com) → API keys). The keys are entered once; every build the user requests runs with them, and its Onshape document lands in their Onshape account.

1. `createUserWithEmailAndPassword(email, password)`. The password goes to Firebase only.
2. `POST /api/auth/claim`, then `getIdToken(true)` (above).
3. `ensure_profile({ p_username })`. The profile must exist before the keys are saved.
4. `PUT /api/me/onshape` with `{ accessKey, secretKey }` (below). On 400, show the error next to the key fields and let the user retry; the account already exists.
5. `accept_pending_invites`.

## Setup

Requires Node 22 (`nvm use`).

1. **Secrets.** Copy `.dev.vars.example` to `.dev.vars` and fill it in:
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys.
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: Firebase console → Project settings → Service accounts → *Generate new private key*. Take `project_id`, `client_email` and `private_key` from the JSON. Keep the `\n` escapes and quote the key.
2. **Enable the Firebase integration in Supabase.** Supabase dashboard → Authentication → Sign In / Providers → Third-party auth → *Add provider* → Firebase, with project ID `mhacks-2026`.
3. **Enable sign-in methods in Firebase.** Firebase console → Authentication → Sign-in method → turn on *Email/Password*.
4. **Apply migrations** in order, `0001` through `0005`. Either run `npx supabase db push` after `npx supabase link`, or paste each file into the Supabase SQL editor.
5. **Run the Worker:** `npm install && npm run dev` (serves on `http://localhost:8787`).

## Deploy

```sh
npx wrangler login
npx wrangler secret bulk .dev.vars   # or: npx wrangler secret put <NAME>
npm run deploy
```

After deploying, set the frontend's `VITE_API_URL` to the Worker's URL.

## Onshape keys

One Onshape API key per user, which has two parts, both stored in Supabase (`0005_onshape_credentials.sql`): the **access key** in `onshape_credentials.access_key`, and the **secret key** encrypted in Supabase Vault, referenced by `onshape_credentials.secret_key_vault_id`. Clients can't read the table; the Worker writes it and the runner reads it, both with the service role.

```
PUT    /api/me/onshape   { accessKey, secretKey }  -> 200 { connected: true, accessKeyHint: "…abcd", onshapeUser: { id, name }, verifiedAt }
GET    /api/me/onshape                             -> the same, or { connected: false }
DELETE /api/me/onshape                             -> { connected: false }
```

`PUT` checks the keys against Onshape (`/users/sessioninfo`) before storing them, and replaces any keys already on file. Errors: 400 when the body is malformed or Onshape rejects the keys, 409 when the user has no profile yet (`ensure_profile` first), 502 when Onshape can't be reached. The secret key is never returned.

## Builds: SolidWorks IR → Onshape

A *build* takes an IR document (produced on the user's machine by the extractor) and rebuilds it in Onshape feature by feature, with per-feature checks and Level 3 behaviour tests. Three pieces:

| Piece | Where | Role |
|---|---|---|
| Tables `builds`, `build_events`; RPCs `request_build`, `claim_build` | `supabase/migrations/0004_builds.sql` | Queue, progress stream (Realtime-enabled), results. The web app uses these directly. |
| Worker routes | `src/builds.ts` | For clients without a Supabase SDK, chiefly the extractor. Firebase token in `Authorization: Bearer`. |
| Runner | `packages/runner` | Claims queued builds, runs `@slop/onshape` with the requester's Onshape keys and the server's LLM key, writes events and the report. |

Worker routes:

```
POST /api/projects/:projectId/builds   { ir, planner?: "rules" | "claude", name? }  -> 201 { id, status: "queued" }
GET  /api/builds/:id                                                              -> build row (status, Onshape ids, summary)
GET  /api/builds/:id/events?after=<seq>&limit=<n>                                 -> { build: { id, status }, events: [{ seq, kind, payload }] }
```

Event kinds, in order: `document` (Onshape ids and URL, as soon as the document exists); per IR feature, `featureStart`, one `attempt` per propose/execute/measure cycle (`outcome`: `invalid`, `execFailed`, `diverged` or `accepted`), then `feature` when it finishes; one `behavior` per behaviour test; `log` lines throughout; and `finished` last. Full IR validation happens in the runner; the Worker only checks the shape.

Run the runner on any machine with the Supabase service key and the Anthropic key (for a demo, a laptop):

```sh
cp packages/onshape/.env.example packages/onshape/.env   # Anthropic key; Onshape keys optional (see --env-keys)
npm run runner                                           # polls Supabase; --once to process one build and exit
```

Each build runs with the Onshape keys of the user who requested it. A build whose requester has none fails with "No Onshape API keys stored". For local development, `npm run runner -- --env-keys` falls back to the keys in `packages/onshape/.env` instead, so those documents land in that account.

Queue a build from the command line with a Firebase ID token:

```sh
curl -X POST "$VITE_API_URL/api/projects/<project-id>/builds" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  --data "{\"ir\": $(cat packages/ir/fixtures/plate.ir.json), \"planner\": \"rules\"}"
```

## Studio: live migrations from the web app

`packages/server` is the backend for the web app's live migrations (Slop-Frontend `/migrate`). A signed-in user pastes an Onshape document link, picks a part, and watches it rebuild in their Onshape account. Run the studio server on the laptop with SolidWorks:

```sh
npm run studio                 # http://localhost:8788; --port, --host 0.0.0.0
```

**Onshape keys never pass through the browser after sign-up.** The user saves them once, with `PUT /api/me/onshape` (above); the secret key is stored encrypted in Vault. For each change (connect, start, cancel, extract, upload, replay), the web app sends only the user's Firebase ID token. The studio server:

1. verifies the token, as the Worker does;
2. reads that user's keys with the service role (`user_onshape_credentials`, migration `0006`);
3. holds them only in that run's Onshape client while it runs. They are never written to events, snapshots, recordings or logs.

Users without keys on file get a 409. A run can only be cancelled by the user who started it. Reads (status, runs, events, meshes) stay open, so a second screen can watch without signing in; none of them include keys.

Configuration:
- Accounts: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (the secret key, `sb_secret_…`) and `FIREBASE_PROJECT_ID`, from the environment or `.dev.vars`, read the same way as the runner. Without them, "user" routes answer 503.
- Claude planner: `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` from `packages/onshape/.env`. Without them, only the rules planner is offered. The Onshape keys in that file are ignored.

| Piece | Role |
|---|---|
| `src/sources.ts` | Where the IR comes from: `SlopExtractor.exe extract --active` against the open SolidWorks (Windows, built extractor), the fixtures in `packages/ir/fixtures`, or an uploaded `.ir.json`. All are fully validated. |
| `src/runs.ts` | One run per migration: opens the document, builds into a new Part Studio tab or the linked one (clearing it only when asked), runs `runBuild` with `target`, and streams events. After each solid feature, the builder's next Onshape call waits until the viewer's tessellation has been fetched, so each mesh shows exactly that feature. Supports cancel; finished runs are recorded to `out/studio/recordings/` and can be replayed with no API calls. |
| `src/mesh.ts` | Onshape `tessellatedfaces` → per-face base64 Float32 triangles (about 1 MB of JSON down to tens of kB), keeping face ids so the viewer can light up new faces. |
| `src/accounts.ts` | Firebase ID token check and the per-user key lookup (`user_onshape_credentials`). |
| `src/app.ts` | HTTP API (route list in the file header): status, sources, `POST /api/onshape/connect` (the user's keys against the document), runs, Server-Sent Events, meshes, recordings. |

Each tessellation costs one Onshape call per solid feature, and the run's call counter includes it. A plate with the rules planner and no behaviour tests took 24 calls in total.

## Migrations

| File | Contents |
|---|---|
| `0001_cad_hub_schema.sql` | Projects, parts, content-addressed blobs, commits/snapshots, branches, tags, conversion jobs, RLS, storage buckets, `create_commit`, `claim_conversion_job` |
| `0002_firebase_auth.sql` | Firebase UIDs (`text`) in place of `auth.users` UUIDs, `current_uid()`, `ensure_profile`, private `profiles.email`, owner-protection trigger, `project_invites` + `add_member_by_identifier` / `accept_pending_invites`, `exports` / `export_items` + `request_export`, Realtime for export progress |
| `0003_export_triggers.sql` | pg_net triggers that call the `bundle-export` Edge Function when an export can be zipped |
| `0004_builds.sql` | `builds` + `build_events`, `request_build` (contributors), `claim_build` (runner), `can_read_project_as` (Worker), Realtime for build progress |
| `0005_onshape_credentials.sql` | `onshape_credentials` (one per user; secret key in Vault), `set_onshape_credentials` (Worker), `build_onshape_credentials` (runner) |
| `0006_studio_onshape_credentials.sql` | `user_onshape_credentials` (studio server): a signed-in user's keys for a live migration |

`profiles.email` is hidden with column-level grants, so clients must list profile columns explicitly (`select("id, username, display_name, avatar_url")`). `select("*")` on `profiles` returns a permission error.
