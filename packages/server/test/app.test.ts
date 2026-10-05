import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RulePlanner, type DocumentRef, type OnshapeConfig, type Planner } from "@slop/onshape";
import { FakeOnshape, plateWorld } from "../../onshape/test/fake.ts";
import type { Accounts } from "../src/accounts.ts";
import { createApp } from "../src/app.ts";
import type { DocumentInfo, ElementInfo, StudioOnshape } from "../src/onshape.ts";
import { Runs } from "../src/runs.ts";
import { Sources } from "../src/sources.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ir", "fixtures");
const D = "aaaaaaaaaaaaaaaaaaaaaaaa";
const W = "bbbbbbbbbbbbbbbbbbbbbbbb";
const E = "cccccccccccccccccccccccc";
const SECRET = "s3cr3t-never-echoed";

/** The builder fake plus the document calls and a tessellation that grows by two faces per call. */
class StudioFake extends FakeOnshape implements StudioOnshape {
  tessellations = 0;
  partStudios: ElementInfo[] = [{ id: E, name: "Part Studio 1", elementType: "PARTSTUDIO" }];

  async getDocument(did: string): Promise<DocumentInfo> {
    this.calls++;
    return { id: did, name: "Judges' document", owner: { name: "Judge" }, defaultWorkspace: { id: W }, permissionSet: ["READ", "WRITE"] };
  }
  async getElements(): Promise<ElementInfo[]> {
    this.calls++;
    return this.partStudios;
  }
  async createPartStudio(_did: string, _wid: string, name: string): Promise<ElementInfo> {
    this.calls++;
    const el = { id: "dddddddddddddddddddddddd", name, elementType: "PARTSTUDIO" };
    this.partStudios.push(el);
    return el;
  }
  async tessellatedFaces(_ref: DocumentRef): Promise<unknown> {
    this.calls++;
    this.tessellations++;
    const faces = Array.from({ length: this.tessellations * 2 }, (_, i) => ({ id: `face${i}`, facets: [{ indices: [0, 1, 2], normals: [] }] }));
    return { facetPoints: [{ x: 0, y: 0, z: 0 }, { x: 0.01, y: 0, z: 0 }, { x: 0, y: 0.01, z: 0.005 }], bodies: [{ id: "B", name: "Part 1", bodyType: "SOLID", faces }] };
  }
}

/** Tokens the fake accounts accept: "judge" has Onshape keys on file, "newbie" has none. */
const fakeAccounts: Accounts = {
  async verify(token) {
    if (token === "judge-token") return "judge";
    if (token === "newbie-token") return "newbie";
    throw new Error("bad token");
  },
  async keysFor(uid) {
    return uid === "judge" ? { accessKey: "ak", secretKey: SECRET, onshapeName: "Judge" } : null;
  },
};

async function start(opts: { recordDir?: string; shared?: boolean; planner?: () => Planner; accounts?: false } = {}) {
  const fakes: Array<{ cfg: OnshapeConfig; fake: StudioFake }> = [];
  const plate = new Sources({ samplesDir: FIXTURES }).get("sample:plate")!.ir;
  const one = new StudioFake(plateWorld(plate));
  const connect = (cfg: OnshapeConfig) => {
    const fake = opts.shared ? one : new StudioFake(plateWorld(plate));
    fakes.push({ cfg, fake });
    return fake;
  };
  const sources = new Sources({ samplesDir: FIXTURES });
  const runs = new Runs({ connect, planner: opts.planner ?? (() => new RulePlanner()), authScheme: "basic", apiVersion: "v10", ...(opts.recordDir ? { recordDir: opts.recordDir } : {}) });
  const server: Server = createServer(
    createApp({ sources, runs, connect, authScheme: "basic", apiVersion: "v10", claude: { available: false }, ...(opts.accounts === false ? {} : { accounts: fakeAccounts }) }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Signed in as the judge unless `token` says otherwise (null: no Authorization header). */
  const call = async (method: string, path: string, body?: unknown, token: string | null = "judge-token") => {
    const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) };
    const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { base, call, fakes, close: () => new Promise<void>((r) => server.close(() => r())), server };
}

/** Reads the SSE stream until the `finished` event. */
async function streamUntilFinished(base: string, id: string) {
  const res = await fetch(`${base}/api/runs/${id}/events`);
  const reader = res.body!.getReader();
  const events: Array<{ seq: number; kind: string; payload: Record<string, any> }> = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
    if (events.at(-1)?.kind === "finished") break;
  }
  await reader.cancel();
  return events;
}

const DOC = `https://cad.onshape.com/documents/${D}/w/${W}/e/${E}`;

test("status and sources list the samples; connect checks the user's own keys against the linked document", async () => {
  const s = await start();
  try {
    const status = await s.call("GET", "/api/status");
    assert.equal(status.body.claude.available, false);
    const sources = await s.call("GET", "/api/sources");
    assert.deepEqual(sources.body.sources.map((x: { id: string }) => x.id), ["sample:lcdm2", "sample:plate", "sample:shaft"]);
    const plate = sources.body.sources[1];
    assert.equal(plate.featureCount, 5);
    assert.deepEqual(plate.ops, { sketch: 2, extrude: 2, fillet: 1 });

    const ok = await s.call("POST", "/api/onshape/connect", { documentUrl: DOC });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.document.name, "Judges' document");
    assert.equal(ok.body.canWrite, true);
    assert.deepEqual(ok.body.linked, { id: E, name: "Part Studio 1", type: "PARTSTUDIO", featureCount: 0 });
    // The keys came from the judge's account, not from the request.
    assert.equal(s.fakes[0]!.cfg.baseUrl, "https://cad.onshape.com");
    assert.deepEqual([s.fakes[0]!.cfg.accessKey, s.fakes[0]!.cfg.secretKey], ["ak", SECRET]);

    const bad = await s.call("POST", "/api/onshape/connect", { documentUrl: "https://example.com/x" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /onshape\.com/);
    const missing = await s.call("POST", "/api/onshape/connect", {});
    assert.equal(missing.status, 400);
  } finally {
    await s.close();
  }
});

test("a run builds into a new tab, streams progress and one mesh per solid feature, and never echoes the keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slop-studio-"));
  const s = await start({ recordDir: dir });
  try {
    const noClaude = await s.call("POST", "/api/runs", { sourceId: "sample:plate", documentUrl: DOC, planner: "claude" });
    assert.equal(noClaude.status, 400);

    const created = await s.call("POST", "/api/runs", { sourceId: "sample:plate", documentUrl: DOC, planner: "rules", target: { mode: "newTab" } });
    assert.equal(created.status, 202);

    const events = await streamUntilFinished(s.base, created.body.id);
    const kinds = events.map((e) => e.kind).filter((k) => k !== "log" && k !== "stats");
    assert.deepEqual(kinds.slice(0, 3), ["status", "status", "document"]);
    assert.equal(kinds.filter((k) => k === "feature").length, 5);
    assert.equal(kinds.filter((k) => k === "featureStart").length, 5);
    assert.equal(kinds.at(-1), "finished");

    const doc = events.find((e) => e.kind === "document")!.payload;
    assert.equal(doc.elementName, "plate (from SolidWorks)");
    assert.equal(doc.name, "Judges' document");
    assert.equal(doc.url, `https://cad.onshape.com/documents/${D}/w/${W}/e/dddddddddddddddddddddddd`);

    // plate: extrude, extrude, fillet are solid; the two sketches are not.
    const meshes = events.filter((e) => e.kind === "mesh").map((e) => e.payload);
    assert.deepEqual(meshes.map((m) => [m.version, m.irId, m.added.length]), [[1, "f2", 2], [2, "f4", 2], [3, "f5", 2]]);
    // Each mesh comes before the next feature starts: the builder waited for the viewer.
    for (const m of meshes) {
      const at = events.findIndex((e) => e.kind === "mesh" && e.payload.version === m.version);
      const next = events.findIndex((e, i) => i > at && e.kind === "featureStart");
      const feature = events.findIndex((e) => e.kind === "feature" && e.payload.irId === m.irId);
      assert.ok(feature < at && (next === -1 || at < next), `mesh ${m.version} lands between its feature and the next`);
    }

    const finished = events.at(-1)!.payload;
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.summary.built, 5);
    assert.ok(finished.stats.apiCalls > 0);

    const mesh = await s.call("GET", `/api/runs/${created.body.id}/mesh/3`);
    assert.equal(mesh.body.bodies[0].faces.length, 6);
    const snapshot = await s.call("GET", `/api/runs/${created.body.id}`);
    assert.equal(snapshot.body.status, "succeeded");
    assert.equal(snapshot.body.meshVersion, 3);
    assert.ok(!JSON.stringify(snapshot.body).includes(SECRET));

    // Recorded, and a replay plays the same events back without touching Onshape.
    const recordings = await s.call("GET", "/api/recordings");
    assert.equal(recordings.body.recordings.length, 1);
    const connections = s.fakes.length;
    const replay = await s.call("POST", `/api/recordings/${recordings.body.recordings[0].id}/replay`, { speed: 20 });
    assert.equal(replay.status, 202);
    const replayed = await streamUntilFinished(s.base, replay.body.id);
    assert.deepEqual(replayed.map((e) => e.kind), events.map((e) => e.kind));
    assert.equal(s.fakes.length, connections);
    assert.equal((await s.call("GET", `/api/runs/${replay.body.id}/mesh/3`)).status, 200);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("building into the linked tab refuses to clear existing features unless asked", async () => {
  const s = await start({ shared: true });
  const migrate = async (target: Record<string, unknown>) => {
    const created = await s.call("POST", "/api/runs", { sourceId: "sample:plate", documentUrl: DOC, planner: "rules", target });
    return streamUntilFinished(s.base, created.body.id);
  };
  try {
    const first = await migrate({ mode: "linked" });
    assert.equal(first.at(-1)!.payload.status, "succeeded");
    assert.equal(first.find((e) => e.kind === "document")!.payload.eid, E);
    const fake = s.fakes[0]!.fake;
    assert.equal(fake.added.length, 5);

    const refused = await migrate({ mode: "linked" });
    assert.equal(refused.at(-1)!.payload.status, "failed");
    assert.match(refused.at(-1)!.payload.error, /already has 5 feature/);
    assert.equal(fake.added.length, 5, "nothing was deleted");

    const cleared = await migrate({ mode: "linked", clear: true });
    assert.equal(cleared.at(-1)!.payload.status, "succeeded");
    assert.ok(cleared.some((e) => e.kind === "status" && /Clearing 5 feature/.test(e.payload.message)));
    assert.equal(fake.added.length, 5, "the old features were replaced, not stacked");
  } finally {
    await s.close();
  }
});

test("one migration at a time, and cancel stops the build at its next step", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const rules = new RulePlanner();
  const planner: Planner = {
    provenance: rules.provenance,
    proposeStep: async (req) => (await held, rules.proposeStep(req)),
    reviseStep: (req, prev, fb) => rules.reviseStep(req, prev, fb),
    proposeBehaviorTests: (ir, steps) => rules.proposeBehaviorTests(ir, steps),
    usage: () => rules.usage(),
  };
  const s = await start({ planner: () => planner });
  try {
    const created = await s.call("POST", "/api/runs", { sourceId: "sample:plate", documentUrl: DOC, planner: "rules" });
    assert.equal(created.status, 202);
    const busy = await s.call("POST", "/api/runs", { sourceId: "sample:plate", documentUrl: DOC, planner: "rules" });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /still running/);
    assert.equal((await s.call("GET", "/api/status")).body.activeRun, created.body.id);

    const notYours = await s.call("POST", `/api/runs/${created.body.id}/cancel`, undefined, "newbie-token");
    assert.equal(notYours.status, 403);
    assert.deepEqual((await s.call("POST", `/api/runs/${created.body.id}/cancel`)).body, { cancelled: true });
    release();
    const events = await streamUntilFinished(s.base, created.body.id);
    assert.equal(events.at(-1)!.payload.status, "cancelled");
    assert.equal(s.fakes[0]!.fake.added.length, 0, "nothing was added after the cancel");
    assert.equal((await s.call("GET", "/api/status")).body.activeRun, null);
  } finally {
    await s.close();
  }
});

test("every change needs a signed-in user with keys on file; reads stay open for a second screen", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("GET", "/api/status", undefined, null)).body.accounts, true);
    assert.equal((await s.call("GET", "/api/sources", undefined, null)).status, 200);
    assert.equal((await s.call("GET", "/api/runs", undefined, null)).status, 200);

    const anonymous = await s.call("POST", "/api/runs", { sourceId: "sample:plate", documentUrl: DOC, planner: "rules" }, null);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.body.error, /Sign in/);
    assert.equal((await s.call("POST", "/api/onshape/connect", { documentUrl: DOC }, "forged-token")).status, 401);
    assert.equal((await s.call("POST", "/api/sources/upload", { ir: {} }, null)).status, 401);

    const noKeys = await s.call("POST", "/api/onshape/connect", { documentUrl: DOC }, "newbie-token");
    assert.equal(noKeys.status, 409);
    assert.match(noKeys.body.error, /no Onshape keys/);
    assert.equal(s.fakes.length, 0, "nothing reached Onshape");
  } finally {
    await s.close();
  }

  const unconfigured = await start({ accounts: false });
  try {
    assert.equal((await unconfigured.call("GET", "/api/status")).body.accounts, false);
    const res = await unconfigured.call("POST", "/api/onshape/connect", { documentUrl: DOC });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /SUPABASE_SECRET_KEY/);
  } finally {
    await unconfigured.close();
  }
});
