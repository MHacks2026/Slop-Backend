import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { buildRoutes, checkRequest, DbError, type BuildRow, type BuildsDb } from "./builds";

const ir = { irVersion: "0.1.0", source: { cad: "solidworks" }, parameters: [], partStudio: { id: "ps1", name: "plate", features: [] } };

const build: BuildRow = {
  id: "b1",
  project_id: "p1",
  name: "plate",
  planner: "rules",
  status: "processing",
  error: null,
  attempts: 1,
  onshape_document_id: "D1",
  onshape_workspace_id: "W1",
  onshape_element_id: "E1",
  summary: null,
  created_at: "2026-10-03T00:00:00Z",
  started_at: "2026-10-03T00:00:01Z",
  finished_at: null,
};

function fakeDb(overrides: Partial<BuildsDb> = {}) {
  const calls: Record<string, unknown[]> = { requestBuild: [], getBuild: [], canReadProject: [], listEvents: [] };
  const db: BuildsDb = {
    async requestBuild(input) {
      calls.requestBuild!.push(input);
      return "b1";
    },
    async getBuild(id) {
      calls.getBuild!.push(id);
      return id === "b1" ? build : null;
    },
    async canReadProject(projectId, uid) {
      calls.canReadProject!.push([projectId, uid]);
      return uid === "alice";
    },
    async listEvents(buildId, after, limit) {
      calls.listEvents!.push([buildId, after, limit]);
      return [
        { seq: after + 1, kind: "feature", payload: { irId: "f1" }, created_at: "t" },
        { seq: after + 2, kind: "feature", payload: { irId: "f2" }, created_at: "t" },
      ];
    },
    ...overrides,
  };
  return { db, calls };
}

function app(db: BuildsDb) {
  const root = new Hono();
  root.route(
    "/api",
    buildRoutes({
      verifyToken: async (token) => {
        if (token === "alice-token") return { uid: "alice" };
        if (token === "bob-token") return { uid: "bob" };
        throw new Error("bad token");
      },
      db,
    }),
  );
  return root;
}

const json = (body: unknown, token?: string) =>
  new Request("http://x/api/projects/p1/builds", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test("queueing a build needs a valid token", async () => {
  const { db } = fakeDb();
  const a = app(db);
  assert.equal((await a.request(json({ ir }))).status, 401);
  assert.equal((await a.request(json({ ir }, "nope"))).status, 401);
});

test("a well-formed request is queued as the verified user", async () => {
  const { db, calls } = fakeDb();
  const res = await app(db).request(json({ ir, planner: "claude", name: "LCDM2" }, "alice-token"));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: "b1", status: "queued" });
  assert.deepEqual(calls.requestBuild, [{ projectId: "p1", uid: "alice", ir, planner: "claude", name: "LCDM2" }]);
});

test("the planner defaults to rules and the name is optional", async () => {
  const { db, calls } = fakeDb();
  assert.equal((await app(db).request(json({ ir }, "alice-token"))).status, 201);
  assert.deepEqual(calls.requestBuild![0], { projectId: "p1", uid: "alice", ir, planner: "rules" });
});

test("malformed bodies are rejected before touching the database", async () => {
  const { db, calls } = fakeDb();
  const a = app(db);
  for (const body of [{}, { ir: [] }, { ir: { irVersion: 1 } }, { ir: { irVersion: "0.1.0", partStudio: {} } }, { ir, planner: "gpt" }, { ir, name: 3 }]) {
    const res = await a.request(json(body, "alice-token"));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const notJson = new Request("http://x/api/projects/p1/builds", { method: "POST", headers: { authorization: "Bearer alice-token" }, body: "{" });
  assert.equal((await a.request(notJson)).status, 400);
  assert.equal(calls.requestBuild!.length, 0);
});

test("database permission errors become 403, bad arguments 400, anything else 500", async () => {
  const code = (c: string) => fakeDb({ requestBuild: async () => Promise.reject(new DbError("x", c)) }).db;
  assert.equal((await app(code("42501")).request(json({ ir }, "alice-token"))).status, 403);
  assert.equal((await app(code("22023")).request(json({ ir }, "alice-token"))).status, 400);
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await app(code("XX000")).request(json({ ir }, "alice-token"))).status, 500);
  } finally {
    console.error = original;
  }
});

test("a build is readable only by someone who can read its project; unknown ids are 404 either way", async () => {
  const { db } = fakeDb();
  const a = app(db);
  const get = (path: string, token: string) => a.request(new Request(`http://x/api${path}`, { headers: { authorization: `Bearer ${token}` } }));
  const ok = await get("/builds/b1", "alice-token");
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as BuildRow).onshape_document_id, "D1");
  assert.equal((await get("/builds/b1", "bob-token")).status, 404);
  assert.equal((await get("/builds/nope", "alice-token")).status, 404);
});

test("events page by sequence number", async () => {
  const { db, calls } = fakeDb();
  const res = await app(db).request(new Request("http://x/api/builds/b1/events?after=3&limit=50", { headers: { authorization: "Bearer alice-token" } }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { build: { id: string; status: string }; events: Array<{ seq: number }> };
  assert.deepEqual(body.build, { id: "b1", status: "processing" });
  assert.deepEqual(
    body.events.map((e) => e.seq),
    [4, 5],
  );
  assert.deepEqual(calls.listEvents, [["b1", 3, 50]]);
  const bad = await app(db).request(new Request("http://x/api/builds/b1/events?after=-1", { headers: { authorization: "Bearer alice-token" } }));
  assert.equal(bad.status, 400);
});

test("checkRequest accepts the plate-shaped document", () => {
  assert.equal(checkRequest({ ir }), undefined);
  assert.match(checkRequest({ ir: { irVersion: "0.1.0" } })!, /features/);
});
