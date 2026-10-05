import { Hono } from "hono";
import { requireUser, type UserEnv } from "./auth";

/**
 * Build routes: queue an IR document for migration into Onshape and read
 * progress. The web app can do the same directly against Supabase (RPC
 * `request_build`, tables `builds` / `build_events`); these routes exist for
 * clients without a Supabase SDK, chiefly the SolidWorks extractor posting
 * the IR it just produced.
 *
 * The Worker holds the service key, so authorization is explicit: the
 * caller's Firebase token is verified here and its uid is passed to SQL
 * functions that check project membership for that uid.
 */

export interface BuildRow {
  id: string;
  project_id: string;
  name: string;
  planner: string;
  status: string;
  error: string | null;
  attempts: number;
  onshape_document_id: string | null;
  onshape_workspace_id: string | null;
  onshape_element_id: string | null;
  summary: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface BuildEventRow {
  seq: number;
  kind: string;
  payload: unknown;
  created_at: string;
}

/** Thrown by the database layer; `code` is the Postgres SQLSTATE. */
export class DbError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

export interface BuildsDb {
  /** Calls request_build() as `uid`; returns the new build id. */
  requestBuild(input: { projectId: string; uid: string; ir: unknown; planner: string; name?: string }): Promise<string>;
  getBuild(id: string): Promise<BuildRow | null>;
  canReadProject(projectId: string, uid: string): Promise<boolean>;
  listEvents(buildId: string, afterSeq: number, limit: number): Promise<BuildEventRow[]>;
}

export interface BuildDeps {
  verifyToken(token: string): Promise<{ uid: string }>;
  db: BuildsDb;
}

export function buildRoutes(deps: BuildDeps): Hono<UserEnv> {
  const app = new Hono<UserEnv>();

  app.use("*", requireUser(deps.verifyToken));

  // POST /api/projects/:projectId/builds  { ir, planner?, name? }
  app.post("/projects/:projectId/builds", async (c) => {
    const projectId = c.req.param("projectId");
    let body: { ir?: unknown; planner?: unknown; name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const problem = checkRequest(body);
    if (problem) return c.json({ error: problem }, 400);

    try {
      const id = await deps.db.requestBuild({
        projectId,
        uid: c.get("uid"),
        ir: body.ir,
        planner: typeof body.planner === "string" ? body.planner : "rules",
        ...(typeof body.name === "string" ? { name: body.name } : {}),
      });
      return c.json({ id, status: "queued" }, 201);
    } catch (err) {
      return dbErrorResponse(c, err);
    }
  });

  // GET /api/builds/:id
  app.get("/builds/:id", async (c) => {
    const build = await deps.db.getBuild(c.req.param("id"));
    if (!build || !(await deps.db.canReadProject(build.project_id, c.get("uid")))) return c.json({ error: "not found" }, 404);
    return c.json(build);
  });

  // GET /api/builds/:id/events?after=<seq>&limit=<n>
  app.get("/builds/:id/events", async (c) => {
    const build = await deps.db.getBuild(c.req.param("id"));
    if (!build || !(await deps.db.canReadProject(build.project_id, c.get("uid")))) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? 0);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), 1000);
    if (!Number.isFinite(after) || after < 0) return c.json({ error: "after must be a non-negative integer" }, 400);
    const events = await deps.db.listEvents(build.id, after, limit);
    return c.json({ build: { id: build.id, status: build.status }, events });
  });

  return app;
}

/**
 * Shape check only. Full IR validation (schema plus referential rules) runs
 * in the runner: the IR validator compiles its schema with Ajv, which needs
 * code generation that Workers do not allow.
 */
export function checkRequest(body: { ir?: unknown; planner?: unknown; name?: unknown }): string | undefined {
  const ir = body.ir;
  if (!ir || typeof ir !== "object" || Array.isArray(ir)) return "ir must be an object";
  const doc = ir as Record<string, unknown>;
  if (typeof doc.irVersion !== "string") return "ir.irVersion must be a string";
  const ps = doc.partStudio as Record<string, unknown> | undefined;
  if (!ps || typeof ps !== "object" || !Array.isArray(ps.features)) return "ir.partStudio.features must be an array";
  if (body.planner !== undefined && body.planner !== "rules" && body.planner !== "claude") return "planner must be rules or claude";
  if (body.name !== undefined && typeof body.name !== "string") return "name must be a string";
  return undefined;
}

function dbErrorResponse(c: { json: (body: unknown, status: 400 | 403 | 404 | 500) => Response }, err: unknown): Response {
  if (err instanceof DbError) {
    if (err.code === "42501") return c.json({ error: "forbidden" }, 403);
    if (err.code === "22023" || err.code === "P0002" || err.code === "22P02") return c.json({ error: err.message }, 400);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
}
