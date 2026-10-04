import { createClient } from "@supabase/supabase-js";
import { DbError, type BuildEventRow, type BuildRow, type BuildsDb } from "./builds";
import type { OnshapeCredentialsDb } from "./onshape-credentials";

type SupabaseEnv = Pick<CloudflareBindings, "SUPABASE_URL" | "SUPABASE_SECRET_KEY">;

const BUILD_COLUMNS =
  "id, project_id, name, planner, status, error, attempts, onshape_document_id, onshape_workspace_id, onshape_element_id, summary, created_at, started_at, finished_at";

/** Service-role access to the builds tables and RPCs. One client per request; it is only a fetch wrapper. */
export function supabaseBuildsDb(env: SupabaseEnv): BuildsDb {
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const fail = (where: string, error: { message: string; code?: string }): never => {
    throw new DbError(`${where}: ${error.message}`, error.code);
  };

  return {
    async requestBuild({ projectId, uid, ir, planner, name }) {
      const { data, error } = await sb.rpc("request_build", {
        p_project_id: projectId,
        p_ir: ir,
        p_planner: planner,
        p_name: name ?? null,
        p_uid: uid,
      });
      if (error) fail("request_build", error);
      return data as string;
    },

    async getBuild(id) {
      const { data, error } = await sb.from("builds").select(BUILD_COLUMNS).eq("id", id).maybeSingle();
      if (error) fail("builds", error);
      return (data as BuildRow | null) ?? null;
    },

    async canReadProject(projectId, uid) {
      const { data, error } = await sb.rpc("can_read_project_as", { p_project: projectId, p_uid: uid });
      if (error) fail("can_read_project_as", error);
      return data === true;
    },

    async listEvents(buildId, afterSeq, limit) {
      const { data, error } = await sb
        .from("build_events")
        .select("seq, kind, payload, created_at")
        .eq("build_id", buildId)
        .gt("seq", afterSeq)
        .order("seq", { ascending: true })
        .limit(limit);
      if (error) fail("build_events", error);
      return (data as BuildEventRow[] | null) ?? [];
    },
  };
}

/** Service-role access to onshape_credentials. The secret key only goes in, through set_onshape_credentials(). */
export function supabaseOnshapeCredentialsDb(env: SupabaseEnv): OnshapeCredentialsDb {
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const fail = (where: string, error: { message: string; code?: string }): never => {
    throw new DbError(`${where}: ${error.message}`, error.code);
  };

  return {
    async save({ uid, accessKey, secretKey, onshapeUserId, onshapeName }) {
      const { error } = await sb.rpc("set_onshape_credentials", {
        p_uid: uid,
        p_access_key: accessKey,
        p_secret_key: secretKey,
        p_onshape_user_id: onshapeUserId,
        p_onshape_name: onshapeName,
      });
      if (error) fail("set_onshape_credentials", error);
    },

    async get(uid) {
      const { data, error } = await sb
        .from("onshape_credentials")
        .select("access_key, onshape_user_id, onshape_name, verified_at")
        .eq("user_id", uid)
        .maybeSingle();
      if (error) fail("onshape_credentials", error);
      if (!data) return null;
      const row = data as { access_key: string; onshape_user_id: string | null; onshape_name: string | null; verified_at: string };
      return { accessKey: row.access_key, onshapeUserId: row.onshape_user_id, onshapeName: row.onshape_name, verifiedAt: row.verified_at };
    },

    async remove(uid) {
      const { data, error } = await sb.from("onshape_credentials").delete().eq("user_id", uid).select("user_id");
      if (error) fail("onshape_credentials", error);
      return (data ?? []).length > 0;
    },
  };
}
