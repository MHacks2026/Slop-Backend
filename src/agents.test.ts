import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { agentRoutes, agentUserRoutes, hashAgentToken, newAgentToken, POLL_MS, type AgentRow, type AgentsDb, type ExtractionRow } from "./agents";
import { DbError } from "./builds";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const EXTRACTION = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-04T12:00:00Z");
const TOKEN = "slop_agent_test-token";

const ir = { irVersion: "0.1.0", source: { cad: "solidworks" }, parameters: [], partStudio: { id: "ps1", name: "plate", features: [] } };

const agentRow = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: AGENT,
  owner_id: "alice",
  name: "Alice's PC",
  status: { version: "0.1.0", solidworks: { running: true } },
  last_seen_at: new Date(NOW - 5_000).toISOString(),
  created_at: "2026-10-04T00:00:00Z",
  revoked_at: null,
  ...over,
});

const extraction: ExtractionRow = {
  id: EXTRACTION,
  project_id: PROJECT,
  agent_id: AGENT,
  requested_by: "alice",
  target: { kind: "active" },
  planner: "rules",
  behavior: 0,
  status: "processing",
  progress: null,
  error: null,
  report: null,
  build_id: null,
  created_at: "2026-10-04T00:00:00Z",
  claimed_at: "2026-10-04T00:00:01Z",
  updated_at: "2026-10-04T00:00:01Z",
  finished_at: null,
};

async function fakeDb(overrides: Partial<AgentsDb> = {}) {
  const tokenHash = await hashAgentToken(TOKEN);
  const calls: Record<string, unknown[]> = {};
  const log = (name: string, args: unknown) => void (calls[name] ??= []).push(args);
  const db: AgentsDb = {
    async createAgent(input) {
      log("createAgent", input);
      return agentRow({ name: input.name, last_seen_at: null });
    },
    async listAgents(ownerId) {
      log("listAgents", ownerId);
      return ownerId === "alice" ? [agentRow(), agentRow({ id: OTHER_AGENT, name: "Laptop", last_seen_at: new Date(NOW - 60_000).toISOString() })] : [];
    },
    async revokeAgent(id, ownerId) {
      log("revokeAgent", [id, ownerId]);
      return id === AGENT && ownerId === "alice";
    },
    async agentByTokenHash(hash) {
      return hash === tokenHash ? { id: AGENT, owner_id: "alice" } : null;
    },
    async requestExtraction(input) {
      log("requestExtraction", input);
      return EXTRACTION;
    },
    async getExtraction(id) {
      return id === EXTRACTION ? extraction : null;
    },
    async canReadProject(projectId, uid) {
      return projectId === PROJECT && uid === "alice";
    },
    async poll(agentId, status) {
      log("poll", [agentId, status]);
      return extraction;
    },
    async progress(id, agentId, line) {
      log("progress", [id, agentId, line]);
      return id === EXTRACTION ? "processing" : null;
    },
    async complete(id, agentId, irDoc, report) {
      log("complete", [id, agentId, irDoc, report]);
      return "b1";
    },
    async fail(id, agentId, error, report) {
      log("fail", [id, agentId, error, report]);
      return id === EXTRACTION;
    },
    ...overrides,
  };
  return { db, calls };
}

function userApp(db: AgentsDb) {
  const root = new Hono();
  root.route(
    "/api",
    agentUserRoutes({
      verifyToken: async (token) => {
        if (token === "alice-token") return { uid: "alice" };
        if (token === "bob-token") return { uid: "bob" };
        throw new Error("bad token");
      },
      db,
      now: () => NOW,
      newToken: () => TOKEN,
    }),
  );
  return root;
}

function agentApp(db: AgentsDb) {
  const root = new Hono();
  root.route("/api", agentRoutes({ db }));
  return root;
}

const req = (method: string, path: string, token: string | null, body?: unknown) =>
  new Request(`http://x/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const quietly = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

// --- tokens -----------------------------------------------------------------------

test("agent tokens are prefixed and random; the stored hash is SHA-256 hex", async () => {
  const a = newAgentToken();
  assert.match(a, /^slop_agent_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newAgentToken());
  assert.equal(await hashAgentToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// --- user routes ------------------------------------------------------------------

test("user routes need a Firebase token", async () => {
  const { db } = await fakeDb();
  const a = userApp(db);
  assert.equal((await a.request(req("GET", "/agents", null))).status, 401);
  assert.equal((await a.request(req("POST", "/agents", "nope", {}))).status, 401);
  assert.equal((await a.request(req("GET", `/extractions/${EXTRACTION}`, TOKEN))).status, 401);
});

test("pairing returns the token once and stores only its hash", async () => {
  const { db, calls } = await fakeDb();
  const res = await userApp(db).request(req("POST", "/agents", "alice-token", { name: "  Alice's PC " }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: AGENT, name: "Alice's PC", token: TOKEN });
  assert.deepEqual(calls.createAgent, [{ ownerId: "alice", name: "Alice's PC", tokenHash: await hashAgentToken(TOKEN) }]);

  const noBody = await userApp(db).request(new Request("http://x/api/agents", { method: "POST", headers: { authorization: "Bearer alice-token" } }));
  assert.equal(noBody.status, 201);
  assert.equal((calls.createAgent![1] as { name: string }).name, "SOLIDWORKS agent");

  for (const name of ["", "   ", 7, "x".repeat(101)]) {
    assert.equal((await userApp(db).request(req("POST", "/agents", "alice-token", { name }))).status, 400, JSON.stringify(name));
  }
});

test("pairing before the profile exists is a 409", async () => {
  const { db } = await fakeDb({ createAgent: () => Promise.reject(new DbError("fk", "23503")) });
  assert.equal((await userApp(db).request(req("POST", "/agents", "alice-token", {}))).status, 409);
});

test("listing shows who is online (seen in the last 30 s) and never a token", async () => {
  const { db } = await fakeDb();
  const res = await userApp(db).request(req("GET", "/agents", "alice-token"));
  const body = (await res.json()) as { agents: Array<{ id: string; online: boolean; token?: string; token_hash?: string }> };
  assert.deepEqual(
    body.agents.map((a) => [a.id, a.online]),
    [
      [AGENT, true],
      [OTHER_AGENT, false],
    ],
  );
  assert.ok(body.agents.every((a) => a.token === undefined && a.token_hash === undefined));
});

test("revoking: only your own agent; anything else is 404", async () => {
  const { db, calls } = await fakeDb();
  const a = userApp(db);
  assert.deepEqual(await (await a.request(req("DELETE", `/agents/${AGENT}`, "alice-token"))).json(), { revoked: true });
  assert.equal((await a.request(req("DELETE", `/agents/${AGENT}`, "bob-token"))).status, 404);
  assert.equal((await a.request(req("DELETE", "/agents/not-a-uuid", "alice-token"))).status, 404);
  assert.equal(calls.revokeAgent!.length, 2);
});

test("requesting an extraction: defaults, and validation before the database", async () => {
  const { db, calls } = await fakeDb();
  const a = userApp(db);
  const res = await a.request(req("POST", `/projects/${PROJECT}/extractions`, "alice-token", { agentId: AGENT }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: EXTRACTION, status: "queued" });
  assert.deepEqual(calls.requestExtraction, [{ projectId: PROJECT, uid: "alice", agentId: AGENT, target: { kind: "active" }, planner: "rules", behavior: 0 }]);

  const path = { kind: "path", path: "C:\\parts\\plate.SLDPRT" };
  await a.request(req("POST", `/projects/${PROJECT}/extractions`, "alice-token", { agentId: AGENT, target: path, planner: "claude", behavior: 3 }));
  assert.deepEqual(calls.requestExtraction![1], { projectId: PROJECT, uid: "alice", agentId: AGENT, target: path, planner: "claude", behavior: 3 });

  for (const body of [
    {},
    { agentId: "nope" },
    { agentId: AGENT, target: { kind: "path", path: "C:\\parts\\plate.step" } },
    { agentId: AGENT, target: { kind: "everything" } },
    { agentId: AGENT, planner: "gpt" },
    { agentId: AGENT, behavior: 11 },
    { agentId: AGENT, behavior: 1.5 },
    "{",
  ]) {
    assert.equal((await a.request(req("POST", `/projects/${PROJECT}/extractions`, "alice-token", body))).status, 400, JSON.stringify(body));
  }
  assert.equal(calls.requestExtraction!.length, 2);
});

test("request_extraction refusals: offline agent or no Onshape keys 409, not a contributor 403, unknown agent 404", async () => {
  const refusing = async (code: string, message: string) =>
    userApp((await fakeDb({ requestExtraction: () => Promise.reject(new DbError(message, code)) })).db).request(
      req("POST", `/projects/${PROJECT}/extractions`, "alice-token", { agentId: AGENT }),
    );
  const offline = await refusing("55000", "the SOLIDWORKS agent is offline");
  assert.equal(offline.status, 409);
  assert.deepEqual(await offline.json(), { error: "the SOLIDWORKS agent is offline" });
  assert.equal((await refusing("42501", "permission denied")).status, 403);
  assert.equal((await refusing("P0002", "agent not found")).status, 404);
  assert.equal((await quietly(() => refusing("XX000", "boom"))).status, 500);
});

test("an extraction is readable by project readers only", async () => {
  const { db } = await fakeDb();
  const a = userApp(db);
  const ok = await a.request(req("GET", `/extractions/${EXTRACTION}`, "alice-token"));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as ExtractionRow).status, "processing");
  assert.equal((await a.request(req("GET", `/extractions/${EXTRACTION}`, "bob-token"))).status, 404);
  assert.equal((await a.request(req("GET", "/extractions/nope", "alice-token"))).status, 404);
});

// --- agent routes -----------------------------------------------------------------

test("agent routes need the agent's own token; a Firebase token is refused", async () => {
  const { db } = await fakeDb();
  const a = agentApp(db);
  assert.equal((await a.request(req("POST", "/agent/poll", null, {}))).status, 401);
  assert.equal((await a.request(req("POST", "/agent/poll", "alice-token", {}))).status, 401);
  assert.equal((await a.request(req("POST", "/agent/poll", "slop_agent_revoked", {}))).status, 401);
  assert.equal((await a.request(req("POST", "/agent/poll", TOKEN, {}))).status, 200);
});

test("poll records the heartbeat and hands out the claimed job", async () => {
  const { db, calls } = await fakeDb();
  const solidworks = { running: true, release: "2026", activeDocument: "plate.SLDPRT" };
  const res = await agentApp(db).request(req("POST", "/agent/poll", TOKEN, { version: "0.2.0", solidworks }));
  assert.deepEqual(await res.json(), { pollMs: POLL_MS, job: { id: EXTRACTION, target: { kind: "active" }, behavior: 0 } });
  assert.deepEqual(calls.poll, [[AGENT, { version: "0.2.0", solidworks }]]);

  const idle = await agentApp((await fakeDb({ poll: async () => null })).db).request(req("POST", "/agent/poll", TOKEN));
  assert.deepEqual(await idle.json(), { pollMs: POLL_MS, job: null });

  const huge = await agentApp(db).request(req("POST", "/agent/poll", TOKEN, { solidworks: { documents: "x".repeat(40_000) } }));
  assert.equal(huge.status, 413);
});

test("progress returns the extraction's status; someone else's extraction is 404", async () => {
  const { db, calls } = await fakeDb();
  const a = agentApp(db);
  assert.deepEqual(await (await a.request(req("POST", `/agent/extractions/${EXTRACTION}/progress`, TOKEN, { line: "reading Boss-Extrude1" }))).json(), { status: "processing" });
  assert.deepEqual(calls.progress, [[EXTRACTION, AGENT, "reading Boss-Extrude1"]]);
  assert.equal((await a.request(req("POST", `/agent/extractions/${OTHER_AGENT}/progress`, TOKEN, { line: "x" }))).status, 404);
  assert.equal((await a.request(req("POST", `/agent/extractions/${EXTRACTION}/progress`, TOKEN, { line: 5 }))).status, 400);
});

test("posting the IR queues the build and returns its id", async () => {
  const { db, calls } = await fakeDb();
  const report = { unsupported: [] };
  const res = await agentApp(db).request(req("POST", `/agent/extractions/${EXTRACTION}/result`, TOKEN, { ir, report }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { buildId: "b1" });
  assert.deepEqual(calls.complete, [[EXTRACTION, AGENT, ir, report]]);
  assert.equal(calls.fail, undefined);
});

test("a malformed IR fails the extraction instead of leaving it processing", async () => {
  const { db, calls } = await fakeDb();
  const res = await agentApp(db).request(req("POST", `/agent/extractions/${EXTRACTION}/result`, TOKEN, { ir: { irVersion: "0.1.0" } }));
  assert.equal(res.status, 400);
  assert.equal(calls.complete, undefined);
  assert.equal(calls.fail!.length, 1);
  assert.match((calls.fail![0] as string[])[2]!, /unusable IR/);
});

test("a refused build fails the extraction; a finished or unknown extraction does not", async () => {
  const refused = await fakeDb({ complete: () => Promise.reject(new DbError("permission denied", "42501")) });
  assert.equal((await agentApp(refused.db).request(req("POST", `/agent/extractions/${EXTRACTION}/result`, TOKEN, { ir }))).status, 403);
  assert.match((refused.calls.fail![0] as string[])[2]!, /could not be queued/);

  const finished = await fakeDb({ complete: () => Promise.reject(new DbError("extraction is canceled, not processing", "55000")) });
  assert.equal((await agentApp(finished.db).request(req("POST", `/agent/extractions/${EXTRACTION}/result`, TOKEN, { ir }))).status, 409);
  assert.equal(finished.calls.fail, undefined);

  const unknown = await fakeDb({ complete: () => Promise.reject(new DbError("extraction not found", "P0002")) });
  assert.equal((await agentApp(unknown.db).request(req("POST", `/agent/extractions/${EXTRACTION}/result`, TOKEN, { ir }))).status, 404);
  assert.equal(unknown.calls.fail, undefined);
});

test("the agent can report a failure, with the extractor's report", async () => {
  const { db, calls } = await fakeDb();
  const a = agentApp(db);
  const res = await a.request(req("POST", `/agent/extractions/${EXTRACTION}/fail`, TOKEN, { error: "SOLIDWORKS is not open", report: { warnings: [] } }));
  assert.deepEqual(await res.json(), { status: "failed" });
  assert.deepEqual(calls.fail, [[EXTRACTION, AGENT, "SOLIDWORKS is not open", { warnings: [] }]]);
  assert.equal((await a.request(req("POST", `/agent/extractions/${OTHER_AGENT}/fail`, TOKEN, { error: "x" }))).status, 404);
  assert.equal((await a.request(req("POST", `/agent/extractions/${EXTRACTION}/fail`, TOKEN, {}))).status, 400);
});
