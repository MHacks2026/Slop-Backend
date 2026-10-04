import { Hono, type Context } from "hono";
import { requireUser, type UserEnv } from "./auth";
import { checkRequest, DbError } from "./builds";

/**
 * SOLIDWORKS agents: the extractor running on a user's Windows machine.
 * The backend cannot reach that machine, so the agent calls in. It polls for
 * extraction requests, reads the part from SOLIDWORKS, and posts the IR,
 * which queues a build as the user who asked for it.
 *
 * Two sets of routes:
 *   agentUserRoutes  the signed-in user (Firebase token): pair an agent,
 *                    list and revoke agents, request and read extractions.
 *   agentRoutes      the agent itself (its own token, from pairing):
 *                    poll, report progress, post the IR or the failure.
 *
 * Protocol for agents: poll only when idle (a poll fails any extraction
 * still processing for that agent, since it must have been cut off), and
 * while extracting send progress at least every 10 seconds so the agent
 * stays online.
 */

export const AGENT_TOKEN_PREFIX = "slop_agent_";
/** How often an idle agent should poll. Sent with every poll reply, so it can change without a new agent build. */
export const POLL_MS = 2000;
/** Seen within this window = online. Matches the 30 seconds in request_extraction(). */
export const ONLINE_WINDOW_MS = 30_000;

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  status: unknown;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ExtractionRow {
  id: string;
  project_id: string;
  agent_id: string;
  requested_by: string | null;
  target: unknown;
  planner: string;
  behavior: number;
  status: string;
  progress: string | null;
  error: string | null;
  report: unknown;
  build_id: string | null;
  created_at: string;
  claimed_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

export type ExtractionTarget = { kind: "active" } | { kind: "path"; path: string };

export interface AgentsDb {
  createAgent(input: { ownerId: string; name: string; tokenHash: string }): Promise<AgentRow>;
  /** The owner's agents that are not revoked. */
  listAgents(ownerId: string): Promise<AgentRow[]>;
  /** Returns false when there is no such unrevoked agent of this owner. */
  revokeAgent(id: string, ownerId: string): Promise<boolean>;
  /** The unrevoked agent with this token hash. */
  agentByTokenHash(tokenHash: string): Promise<{ id: string; owner_id: string } | null>;
  /** Calls request_extraction() as `uid`; returns the new extraction id. */
  requestExtraction(input: { projectId: string; uid: string; agentId: string; target: ExtractionTarget; planner: string; behavior: number }): Promise<string>;
  getExtraction(id: string): Promise<ExtractionRow | null>;
  canReadProject(projectId: string, uid: string): Promise<boolean>;
  /** agent_poll(): heartbeat, then the claimed extraction if one was queued. */
  poll(agentId: string, status: unknown): Promise<ExtractionRow | null>;
  /** agent_progress(): the extraction's status, or null when it is not this agent's. */
  progress(extractionId: string, agentId: string, line: string): Promise<string | null>;
  /** complete_extraction(): queues the build; returns its id. */
  complete(extractionId: string, agentId: string, ir: unknown, report: unknown): Promise<string>;
  /** fail_extraction(): false when it was not this agent's or not processing. */
  fail(extractionId: string, agentId: string, error: string, report: unknown): Promise<boolean>;
}

export interface AgentDeps {
  verifyToken(token: string): Promise<{ uid: string }>;
  db: AgentsDb;
  /** Tests pin these. */
  now?: () => number;
  newToken?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- the signed-in user -------------------------------------------------------

export function agentUserRoutes(deps: AgentDeps): Hono<UserEnv> {
  const app = new Hono<UserEnv>();
  const now = deps.now ?? Date.now;
  app.use("*", requireUser(deps.verifyToken));

  // POST /api/agents  { name? }  -> 201 { id, name, token }; the token is shown only here.
  app.post("/agents", async (c) => {
    const body = await readJson(c, true);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const name = body.name === undefined ? "SOLIDWORKS agent" : typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) return c.json({ error: "name must be a string of 1 to 100 characters" }, 400);

    const token = (deps.newToken ?? newAgentToken)();
    try {
      const agent = await deps.db.createAgent({ ownerId: c.get("uid"), name, tokenHash: await hashAgentToken(token) });
      return c.json({ id: agent.id, name: agent.name, token }, 201);
    } catch (err) {
      if (err instanceof DbError && err.code === "23503") return c.json({ error: "no profile for this user yet; call ensure_profile first" }, 409);
      return dbErrorResponse(c, err);
    }
  });

  // GET /api/agents
  app.get("/agents", async (c) => {
    const agents = await deps.db.listAgents(c.get("uid"));
    return c.json({ agents: agents.map((a) => describeAgent(a, now())) });
  });

  // DELETE /api/agents/:id  (revokes: its token stops working)
  app.delete("/agents/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id) || !(await deps.db.revokeAgent(id, c.get("uid")))) return c.json({ error: "not found" }, 404);
    return c.json({ revoked: true });
  });

  // POST /api/projects/:projectId/extractions  { agentId, target?, planner?, behavior? }
  app.post("/projects/:projectId/extractions", async (c) => {
    const projectId = c.req.param("projectId");
    if (!UUID.test(projectId)) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const checked = checkExtractionRequest(body);
    if (typeof checked === "string") return c.json({ error: checked }, 400);

    try {
      const id = await deps.db.requestExtraction({ projectId, uid: c.get("uid"), ...checked });
      return c.json({ id, status: "queued" }, 201);
    } catch (err) {
      return dbErrorResponse(c, err);
    }
  });

  // GET /api/extractions/:id
  app.get("/extractions/:id", async (c) => {
    const id = c.req.param("id");
    const extraction = UUID.test(id) ? await deps.db.getExtraction(id) : null;
    if (!extraction || !(await deps.db.canReadProject(extraction.project_id, c.get("uid")))) return c.json({ error: "not found" }, 404);
    return c.json(extraction);
  });

  return app;
}

function describeAgent(a: AgentRow, now: number) {
  const lastSeen = a.last_seen_at ? Date.parse(a.last_seen_at) : NaN;
  return {
    id: a.id,
    name: a.name,
    online: Number.isFinite(lastSeen) && now - lastSeen < ONLINE_WINDOW_MS,
    lastSeenAt: a.last_seen_at,
    createdAt: a.created_at,
    status: a.status,
  };
}

export function checkExtractionRequest(body: Record<string, unknown>): { agentId: string; target: ExtractionTarget; planner: string; behavior: number } | string {
  if (typeof body.agentId !== "string" || !UUID.test(body.agentId)) return "agentId must be an agent id";
  let target: ExtractionTarget = { kind: "active" };
  if (body.target !== undefined) {
    const t = body.target as Record<string, unknown> | null;
    if (t && typeof t === "object" && t.kind === "active") target = { kind: "active" };
    else if (t && typeof t === "object" && t.kind === "path" && typeof t.path === "string" && /\.sldprt$/i.test(t.path) && t.path.length <= 1000) target = { kind: "path", path: t.path };
    else return 'target must be {"kind":"active"} or {"kind":"path","path":"...SLDPRT"}';
  }
  if (body.planner !== undefined && body.planner !== "rules" && body.planner !== "claude") return "planner must be rules or claude";
  if (body.behavior !== undefined && !(Number.isInteger(body.behavior) && (body.behavior as number) >= 0 && (body.behavior as number) <= 10)) return "behavior must be an integer from 0 to 10";
  return { agentId: body.agentId, target, planner: (body.planner as string | undefined) ?? "rules", behavior: (body.behavior as number | undefined) ?? 0 };
}

// --- the agent ------------------------------------------------------------------

type AgentEnv = { Variables: { agentId: string } };

export function agentRoutes(deps: Pick<AgentDeps, "db">): Hono<AgentEnv> {
  const app = new Hono<AgentEnv>();

  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token || !token.startsWith(AGENT_TOKEN_PREFIX)) return c.json({ error: "missing agent token" }, 401);
    const agent = await deps.db.agentByTokenHash(await hashAgentToken(token));
    if (!agent) return c.json({ error: "unknown or revoked agent token; pair the agent again" }, 401);
    c.set("agentId", agent.id);
    await next();
  });

  // POST /api/agent/poll  { version?, solidworks? }  -> { pollMs, job: null | { id, target, behavior } }
  app.post("/agent/poll", async (c) => {
    const body = await readJson(c, true);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const status = { version: typeof body.version === "string" ? body.version.slice(0, 50) : null, solidworks: body.solidworks ?? null };
    if (JSON.stringify(status).length > 32_000) return c.json({ error: "status is too large" }, 413);
    try {
      const job = await deps.db.poll(c.get("agentId"), status);
      return c.json({ pollMs: POLL_MS, job: job ? { id: job.id, target: job.target, behavior: job.behavior } : null });
    } catch (err) {
      if (err instanceof DbError && err.code === "42501") return c.json({ error: "unknown or revoked agent token; pair the agent again" }, 401);
      return dbErrorResponse(c, err);
    }
  });

  // POST /api/agent/extractions/:id/progress  { line }  -> { status }; stop unless "processing".
  app.post("/agent/extractions/:id/progress", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body || typeof body.line !== "string") return c.json({ error: "line must be a string" }, 400);
    const status = UUID.test(id) ? await deps.db.progress(id, c.get("agentId"), body.line.slice(0, 500)) : null;
    if (!status) return c.json({ error: "not found" }, 404);
    return c.json({ status });
  });

  // POST /api/agent/extractions/:id/result  { ir, report? }  -> 201 { buildId }
  app.post("/agent/extractions/:id/result", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const agentId = c.get("agentId");
    const body = await readJson(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const report = isObject(body.report) ? body.report : null;

    // A malformed IR won't get better on retry: record it as the extraction's failure.
    const problem = checkRequest({ ir: body.ir });
    if (problem) {
      await deps.db.fail(id, agentId, `the extractor produced an unusable IR: ${problem}`, report);
      return c.json({ error: problem }, 400);
    }

    try {
      const buildId = await deps.db.complete(id, agentId, body.ir, report);
      return c.json({ buildId }, 201);
    } catch (err) {
      // The build was refused (bad IR, or the requester lost access): the extraction fails with the reason.
      if (err instanceof DbError && (err.code === "22023" || err.code === "42501")) {
        await deps.db.fail(id, agentId, `the build could not be queued: ${err.message}`, report);
      }
      return dbErrorResponse(c, err);
    }
  });

  // POST /api/agent/extractions/:id/fail  { error, report? }
  app.post("/agent/extractions/:id/fail", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body || typeof body.error !== "string") return c.json({ error: "error must be a string" }, 400);
    const ok = UUID.test(id) && (await deps.db.fail(id, c.get("agentId"), body.error, isObject(body.report) ? body.report : null));
    if (!ok) return c.json({ error: "no extraction in progress with this id for this agent" }, 404);
    return c.json({ status: "failed" });
  });

  return app;
}

// --- tokens ---------------------------------------------------------------------

/** A new agent token: the prefix and 32 random bytes, base64url. */
export function newAgentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return AGENT_TOKEN_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex. Only the hash is stored; tokens are random enough that no salt or slow hash is needed. */
export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- helpers --------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The body as an object; null when it isn't one. With `emptyOk`, no body reads as {}. */
async function readJson(c: Context, emptyOk = false): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (!text.trim()) return emptyOk ? {} : null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function dbErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof DbError) {
    if (err.code === "42501") return c.json({ error: "forbidden" }, 403);
    if (err.code === "P0002") return c.json({ error: err.message }, 404);
    if (err.code === "55000") return c.json({ error: err.message }, 409);
    if (err.code === "22023" || err.code === "22P02") return c.json({ error: err.message }, 400);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
}
