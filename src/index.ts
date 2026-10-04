import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildRoutes } from "./builds";
import { setCustomClaims, verifyIdToken } from "./firebase";
import { supabaseBuildsDb } from "./supabase";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("/api/*", cors());

// Builds: POST /api/projects/:projectId/builds, GET /api/builds/:id, GET /api/builds/:id/events
app.all("/api/projects/:projectId/builds", (c) => mountBuilds(c.env).fetch(c.req.raw));
app.all("/api/builds/*", (c) => mountBuilds(c.env).fetch(c.req.raw));

function mountBuilds(env: CloudflareBindings) {
  const root = new Hono();
  root.route(
    "/api",
    buildRoutes({
      verifyToken: async (token) => ({ uid: (await verifyIdToken(env, token)).sub }),
      db: supabaseBuildsDb(env),
    }),
  );
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
