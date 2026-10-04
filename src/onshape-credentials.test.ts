import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { DbError } from "./builds";
import { checkOnshapeKeys, onshapeCredentialRoutes, type KeyCheck, type OnshapeAccount, type OnshapeCredentialsDb } from "./onshape-credentials";

const GOOD = { accessKey: "AKgood0000000000abcd", secretKey: "SKgood00000000000000000000000000" };

function fakeDb(overrides: Partial<OnshapeCredentialsDb> = {}) {
  const stored = new Map<string, OnshapeAccount & { secretKey: string }>();
  const calls: Record<string, unknown[]> = { save: [], remove: [] };
  const db: OnshapeCredentialsDb = {
    async save(input) {
      calls.save!.push(input);
      stored.set(input.uid, { ...input, verifiedAt: "2026-10-04T00:00:00Z" });
    },
    async get(uid) {
      const row = stored.get(uid);
      return row ? { accessKey: row.accessKey, onshapeUserId: row.onshapeUserId, onshapeName: row.onshapeName, verifiedAt: row.verifiedAt } : null;
    },
    async remove(uid) {
      calls.remove!.push(uid);
      return stored.delete(uid);
    },
    ...overrides,
  };
  return { db, calls, stored };
}

function app(db: OnshapeCredentialsDb, checkKeys: (a: string, s: string) => Promise<KeyCheck> = fakeOnshape) {
  const root = new Hono();
  root.route(
    "/api",
    onshapeCredentialRoutes({
      verifyToken: async (token) => {
        if (token === "alice-token") return { uid: "alice" };
        throw new Error("bad token");
      },
      checkKeys,
      db,
    }),
  );
  return root;
}

async function fakeOnshape(accessKey: string, secretKey: string): Promise<KeyCheck> {
  return accessKey === GOOD.accessKey && secretKey === GOOD.secretKey ? { ok: true, user: { id: "osu1", name: "Alice Smith" } } : { ok: false };
}

const req = (method: string, body?: unknown, token = "alice-token") =>
  new Request("http://x/api/me/onshape", {
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

test("every method needs a valid token", async () => {
  const a = app(fakeDb().db);
  for (const method of ["GET", "PUT", "DELETE"]) {
    assert.equal((await a.request(req(method, method === "PUT" ? GOOD : undefined, ""))).status, 401, method);
    assert.equal((await a.request(req(method, method === "PUT" ? GOOD : undefined, "nope"))).status, 401, method);
  }
});

test("keys Onshape accepts are stored for the verified user, and the reply never contains the secret", async () => {
  const { db, calls } = fakeDb();
  const res = await app(db).request(req("PUT", { accessKey: ` ${GOOD.accessKey} `, secretKey: GOOD.secretKey }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(GOOD.secretKey));
  assert.ok(!text.includes(GOOD.accessKey));
  const body = JSON.parse(text) as { connected: boolean; accessKeyHint: string; onshapeUser: { id: string; name: string } };
  assert.equal(body.connected, true);
  assert.equal(body.accessKeyHint, "…abcd");
  assert.deepEqual(body.onshapeUser, { id: "osu1", name: "Alice Smith" });
  assert.deepEqual(calls.save, [{ uid: "alice", ...GOOD, onshapeUserId: "osu1", onshapeName: "Alice Smith" }]);
});

test("keys Onshape rejects are not stored", async () => {
  const { db, calls } = fakeDb();
  const res = await app(db).request(req("PUT", { accessKey: GOOD.accessKey, secretKey: "wrong" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /rejected/);
  assert.equal(calls.save!.length, 0);
});

test("malformed bodies are rejected before asking Onshape", async () => {
  const { db, calls } = fakeDb();
  let asked = 0;
  const a = app(db, async (k, s) => {
    asked++;
    return fakeOnshape(k, s);
  });
  for (const body of [{}, { accessKey: GOOD.accessKey }, { secretKey: GOOD.secretKey }, { ...GOOD, accessKey: "" }, { ...GOOD, secretKey: 42 }, { ...GOOD, accessKey: "has space" }, { ...GOOD, secretKey: "x".repeat(201) }, "{"]) {
    assert.equal((await a.request(req("PUT", body))).status, 400, JSON.stringify(body));
  }
  assert.equal(asked, 0);
  assert.equal(calls.save!.length, 0);
});

test("Onshape being unreachable is a 502, not a rejection", async () => {
  const { db, calls } = fakeDb();
  const res = await quietly(() => app(db, () => Promise.reject(new Error("network down"))).request(req("PUT", GOOD)));
  assert.equal(res.status, 502);
  assert.equal(calls.save!.length, 0);
});

test("saving before the profile exists is a 409; other database errors are 500", async () => {
  const failing = (code: string) => fakeDb({ save: () => Promise.reject(new DbError("x", code)) }).db;
  assert.equal((await app(failing("23503")).request(req("PUT", GOOD))).status, 409);
  assert.equal((await quietly(() => app(failing("XX000")).request(req("PUT", GOOD)))).status, 500);
});

test("GET reports whether keys are on file, DELETE removes them", async () => {
  const { db, calls } = fakeDb();
  const a = app(db);
  assert.deepEqual(await (await a.request(req("GET"))).json(), { connected: false });
  await a.request(req("PUT", GOOD));
  const got = (await (await a.request(req("GET"))).json()) as { connected: boolean; accessKeyHint: string; verifiedAt: string };
  assert.equal(got.connected, true);
  assert.equal(got.accessKeyHint, "…abcd");
  assert.equal(got.verifiedAt, "2026-10-04T00:00:00Z");
  const del = await a.request(req("DELETE"));
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { connected: false });
  assert.deepEqual(calls.remove, ["alice"]);
  assert.deepEqual(await (await a.request(req("GET"))).json(), { connected: false });
});

// Onshape's sessioninfo answers 200 with the account for valid keys and 204
// with no body for invalid or missing ones (checked against the live API).
test("checkOnshapeKeys: 200 with an id is accepted; 204, 401, 403 and id-less bodies are rejected; anything else throws", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const respond = (status: number, body?: unknown): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as typeof fetch;

  assert.deepEqual(await checkOnshapeKeys("ak", "sk", respond(200, { id: "osu1", name: "Alice Smith", email: "a@x" })), { ok: true, user: { id: "osu1", name: "Alice Smith" } });
  assert.equal(seen[0]!.url, "https://cad.onshape.com/api/v10/users/sessioninfo");
  assert.equal(seen[0]!.auth, `Basic ${btoa("ak:sk")}`);
  assert.deepEqual(await checkOnshapeKeys("ak", "sk", respond(200, { id: "osu1" })), { ok: true, user: { id: "osu1", name: null } });

  for (const status of [204, 401, 403]) assert.deepEqual(await checkOnshapeKeys("ak", "sk", respond(status)), { ok: false }, String(status));
  assert.deepEqual(await checkOnshapeKeys("ak", "sk", respond(200, {})), { ok: false });
  await assert.rejects(checkOnshapeKeys("ak", "sk", respond(503)), /503/);
});
