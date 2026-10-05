import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentRoutes, agentUserRoutes } from "./agents";
import { buildRoutes } from "./builds";
import { setCustomClaims, verifyIdToken } from "./firebase";
import { checkOnshapeKeys, onshapeCredentialRoutes } from "./onshape-credentials";
import { supabaseAgentsDb, supabaseBuildsDb, supabaseOnshapeCredentialsDb } from "./supabase";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("/api/*", cors());

function firebaseUser(env: CloudflareBindings) {
  return async (token: string) => ({ uid: (await verifyIdToken(env, token)).sub });
}

// Builds: POST /api/projects/:projectId/builds, GET /api/builds/:id, GET /api/builds/:id/events
app.all("/api/projects/:projectId/builds", (c) => mountBuilds(c.env).fetch(c.req.raw));
app.all("/api/builds/*", (c) => mountBuilds(c.env).fetch(c.req.raw));

function mountBuilds(env: CloudflareBindings) {
  const root = new Hono();
  root.route("/api", buildRoutes({ verifyToken: firebaseUser(env), db: supabaseBuildsDb(env) }));
  return root;
}

// The user's Onshape API keys: PUT (sent once, at sign-up), GET, DELETE /api/me/onshape
app.all("/api/me/onshape", (c) => mountOnshapeCredentials(c.env).fetch(c.req.raw));

function mountOnshapeCredentials(env: CloudflareBindings) {
  const root = new Hono();
  root.route("/api", onshapeCredentialRoutes({ verifyToken: firebaseUser(env), checkKeys: checkOnshapeKeys, db: supabaseOnshapeCredentialsDb(env) }));
  return root;
}

// SOLIDWORKS agents. The user pairs an agent and asks it for extractions:
//   POST/GET /api/agents, DELETE /api/agents/:id,
//   POST /api/projects/:projectId/extractions, GET /api/extractions/:id
// The agent, with its own token: POST /api/agent/poll,
//   POST /api/agent/extractions/:id/{progress,result,fail}
app.all("/api/agents", (c) => mountAgentUser(c.env).fetch(c.req.raw));
app.all("/api/agents/:id", (c) => mountAgentUser(c.env).fetch(c.req.raw));
app.all("/api/projects/:projectId/extractions", (c) => mountAgentUser(c.env).fetch(c.req.raw));
app.all("/api/extractions/:id", (c) => mountAgentUser(c.env).fetch(c.req.raw));
app.all("/api/agent/*", (c) => mountAgent(c.env).fetch(c.req.raw));

function mountAgentUser(env: CloudflareBindings) {
  const root = new Hono();
  root.route("/api", agentUserRoutes({ verifyToken: firebaseUser(env), db: supabaseAgentsDb(env) }));
  return root;
}

function mountAgent(env: CloudflareBindings) {
  const root = new Hono();
  root.route("/api", agentRoutes({ db: supabaseAgentsDb(env) }));
  return root;
}

app.get("/api/health", (c) => {
  return c.json({ ok: true });
});

// Supabase only accepts Firebase tokens carrying role: "authenticated".
// The client calls this after sign-in when its token lacks the claim, then
// force-refreshes the token (getIdToken(true)) to pick it up.
app.post("/api/auth/claim", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return c.json({ error: "missing bearer token" }, 401);

  let uid: string;
  let role: unknown;
  try {
    const payload = await verifyIdToken(c.env, token);
    uid = payload.sub;
    role = payload.role;
  } catch {
    return c.json({ error: "invalid token" }, 401);
  }

  if (role === "authenticated") return c.json({ updated: false });

  await setCustomClaims(c.env, uid, { role: "authenticated" });
  return c.json({ updated: true });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
