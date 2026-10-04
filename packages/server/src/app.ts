/**
 * Studio HTTP API: the web app's backend for live migrations.
 *
 *   GET  /api/status                       planner/extractor/accounts availability
 *   GET  /api/sources                      samples + this session's extractions and uploads
 *   GET  /api/sources/:id                  { source, ir }
 *   POST /api/sources/solidworks     user  { behavior? }   read the part open in SolidWorks
 *   POST /api/sources/upload         user  { ir, fileName? }
 *   POST /api/onshape/connect        user  { documentUrl }  check the user's keys against the document
 *   GET  /api/runs                         recent runs, newest first
 *   POST /api/runs                   user  { sourceId, documentUrl, target, planner, behavior } -> 202 { id }
 *   GET  /api/runs/:id                     snapshot: status, IR, document, every event so far
 *   GET  /api/runs/:id/events              Server-Sent Events; resumes after Last-Event-ID or ?after=
 *   GET  /api/runs/:id/mesh/:version       the model after a feature (see mesh.ts)
 *   POST /api/runs/:id/cancel        user  (the run's owner)
 *   GET  /api/recordings                   finished runs saved to disk
 *   POST /api/recordings/:id/replay  user  { speed? } -> 202 { id }   play one back, no API calls
 *
 * "user" routes need `Authorization: Bearer <Firebase ID token>`. The
 * Onshape keys are the user's own, read server-side (accounts.ts); the
 * browser never sends them. Reads stay open so a second screen can watch
 * without signing in; they never include keys.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type { OnshapeConfig } from "@slop/onshape";
import { AccountsError, type Accounts, type OnshapeKeys } from "./accounts.ts";
import { documentUrl, LinkError, parseDocumentLink } from "./onshape-link.ts";
import { explainOnshapeError, type StudioOnshape } from "./onshape.ts";
import { RunError, type Runs } from "./runs.ts";
import { SourceError, type Sources } from "./sources.ts";

export interface AppDeps {
  sources: Sources;
  runs: Runs;
  connect(cfg: OnshapeConfig): StudioOnshape;
  authScheme: OnshapeConfig["authScheme"];
  apiVersion: string;
  claude: { available: boolean; model?: string };
  /** Sign-in and per-user Onshape keys. Without it, "user" routes answer 503. */
  accounts?: Accounts;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body(): Promise<Record<string, unknown>>;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: string[],
  ) {
    super(message);
  }
}

const MAX_BODY = 20 * 1024 * 1024;

export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
    routes.push({ method, pattern, keys, handler });
  };

  /** The signed-in user behind the request's Firebase ID token. */
  const signedIn = async (req: IncomingMessage): Promise<string> => {
    if (!deps.accounts) throw new HttpError(503, "The studio server isn't connected to CAD Hub accounts. Set SUPABASE_URL, SUPABASE_SECRET_KEY and FIREBASE_PROJECT_ID in Slop-Backend/.dev.vars and restart it.");
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(401, "Sign in to CAD Hub first.");
    try {
      return await deps.accounts.verify(token);
    } catch {
      throw new HttpError(401, "Your sign-in has expired. Sign in again.");
    }
  };

  /** The user's own Onshape keys, from their account. */
  const keysOf = async (uid: string): Promise<OnshapeKeys> => {
    const keys = await deps.accounts!.keysFor(uid);
    if (!keys) throw new HttpError(409, "There are no Onshape keys on your account. Add them under Onshape keys in the account menu.");
    return keys;
  };

  route("GET", "/api/status", ({ res }) =>
    json(res, 200, {
      ok: true,
      accounts: !!deps.accounts,
      claude: deps.claude,
      solidworks: { available: deps.sources.extractorAvailable },
      activeRun: deps.runs.active()?.id ?? null,
      // So the app can tell people which address opens it from another laptop.
      network: Object.values(networkInterfaces()).flatMap((addrs) => (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address)),
    }),
  );

  // --- sources -------------------------------------------------------------------

  route("GET", "/api/sources", ({ res }) => json(res, 200, { sources: deps.sources.list() }));

  route("GET", "/api/sources/:id", ({ res, params }) => {
    const source = deps.sources.get(params.id!);
    if (!source) throw new HttpError(404, "No such source.");
    json(res, 200, { source: source.info, ir: source.ir });
  });

  route("POST", "/api/sources/solidworks", async ({ req, res, body }) => {
    await signedIn(req);
    const b = await body();
    const { source, log } = await deps.sources.extractActive({ behavior: typeof b.behavior === "number" ? b.behavior : 0 });
    json(res, 201, { source: source.info, ir: source.ir, log });
  });

  route("POST", "/api/sources/upload", async ({ req, res, body }) => {
    await signedIn(req);
    const b = await body();
    const source = deps.sources.addUpload(b.ir, typeof b.fileName === "string" ? b.fileName : undefined);
    json(res, 201, { source: source.info, ir: source.ir });
  });

  // --- Onshape -------------------------------------------------------------------

  route("POST", "/api/onshape/connect", async ({ req, res, body }) => {
    const uid = await signedIn(req);
    const link = parseDocumentLink(documentLink(await body()));
    const keys = await keysOf(uid);
    const client = deps.connect({ baseUrl: link.baseUrl, accessKey: keys.accessKey, secretKey: keys.secretKey, authScheme: deps.authScheme, apiVersion: deps.apiVersion });
    const doc = await client.getDocument(link.did);
    const wid = link.wid ?? doc.defaultWorkspace?.id;
    if (!wid) throw new HttpError(422, "Couldn't find the document's workspace. Copy the link while the document is open.");
    const elements = await client.getElements(link.did, wid);
    const linkedEl = link.eid ? elements.find((e) => e.id === link.eid) : undefined;
    const featureCount = linkedEl?.elementType === "PARTSTUDIO" ? (await client.getFeatures({ did: link.did, wid, eid: linkedEl.id })).features.length : undefined;
    json(res, 200, {
      baseUrl: link.baseUrl,
      document: { id: doc.id, name: doc.name, ...(doc.owner?.name ? { owner: doc.owner.name } : {}), url: documentUrl({ baseUrl: link.baseUrl, did: link.did, wid }) },
      workspaceId: wid,
      canWrite: doc.permissionSet ? doc.permissionSet.includes("WRITE") : null,
      partStudios: elements.filter((e) => e.elementType === "PARTSTUDIO").map((e) => ({ id: e.id, name: e.name })),
      ...(linkedEl ? { linked: { id: linkedEl.id, name: linkedEl.name, type: linkedEl.elementType, ...(featureCount !== undefined ? { featureCount } : {}) } } : {}),
      apiCalls: client.callCount(),
    });
  });

  // --- runs ----------------------------------------------------------------------

  route("GET", "/api/runs", ({ res, query }) => json(res, 200, { runs: deps.runs.list(Math.min(Number(query.get("limit")) || 20, 50)) }));

  route("POST", "/api/runs", async ({ req, res, body }) => {
    const uid = await signedIn(req);
    const b = await body();
    const source = typeof b.sourceId === "string" ? deps.sources.get(b.sourceId) : undefined;
    if (!source) throw new HttpError(400, "Pick a part to migrate first.");
    const planner = b.planner === "rules" ? "rules" : "claude";
    if (planner === "claude" && !deps.claude.available) throw new HttpError(400, "Claude isn't configured on this server (ANTHROPIC_API_KEY in packages/onshape/.env). Use the rules planner.");
    const docUrl = documentLink(b);
    const keys = await keysOf(uid);
    const t = (b.target ?? {}) as { mode?: unknown; clear?: unknown };
    const run = deps.runs.start({
      source,
      owner: uid,
      onshape: { accessKey: keys.accessKey, secretKey: keys.secretKey, documentUrl: docUrl },
      target: { mode: t.mode === "linked" ? "linked" : "newTab", clear: t.clear === true },
      planner,
      behavior: b.behavior === true,
    });
    json(res, 202, { id: run.id });
  });

  route("GET", "/api/runs/:id", ({ res, params }) => json(res, 200, findRun(deps.runs, params.id!).snapshot()));

  route("GET", "/api/runs/:id/mesh/:version", ({ res, params }) => {
    const run = findRun(deps.runs, params.id!);
    const mesh = run.meshes[Number(params.version) - 1];
    if (!mesh) throw new HttpError(404, "No such mesh version.");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    json(res, 200, mesh);
  });

  route("POST", "/api/runs/:id/cancel", async ({ req, res, params }) => {
    const uid = await signedIn(req);
    const run = findRun(deps.runs, params.id!);
    if (run.owner && run.owner !== uid) throw new HttpError(403, "Only the person who started this migration can cancel it.");
    json(res, 200, { cancelled: deps.runs.cancel(run.id) });
  });

  route("GET", "/api/runs/:id/events", ({ req, res, params, query }) => {
    const run = findRun(deps.runs, params.id!);
    const after = Number(req.headers["last-event-id"] ?? query.get("after") ?? 0) || 0;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 2000\n\n");
    const send = (e: { seq: number }) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of run.events) if (e.seq > after) send(e);
    const unsubscribe = run.subscribe(send);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- recordings ------------------------------------------------------------------

  route("GET", "/api/recordings", ({ res }) => json(res, 200, { recordings: deps.runs.recordings() }));

  route("POST", "/api/recordings/:id/replay", async ({ req, res, params, body }) => {
    const uid = await signedIn(req);
    const b = await body();
    const run = deps.runs.replay(params.id!, typeof b.speed === "number" ? b.speed : 1, uid);
    json(res, 202, { id: run.id });
  });

  return (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = routes
      .filter((r) => r.method === req.method)
      .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
      .find((x) => x.m);
    if (!match) {
      json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      return;
    }
    const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m![i + 1]!)]));
    const ctx: Ctx = { req, res, params, query: url.searchParams, body: () => readJson(req) };
    Promise.resolve()
      .then(() => match.r.handler(ctx))
      .catch((err: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        const { status, message, details } = describe(err);
        if (status >= 500) console.error(err);
        json(res, status, { error: message, ...(details?.length ? { details } : {}) });
      });
  };
}

function describe(err: unknown): { status: number; message: string; details?: string[] } {
  if (err instanceof HttpError) return { status: err.status, message: err.message, ...(err.details ? { details: err.details } : {}) };
  if (err instanceof LinkError) return { status: 400, message: err.message };
  if (err instanceof SourceError) return { status: err.status, message: err.message, details: err.details };
  if (err instanceof RunError) return { status: err.status, message: err.message };
  if (err instanceof AccountsError) {
    if (err.code === "PGRST202") return { status: 500, message: "Supabase has no user_onshape_credentials function yet: apply migration 0006." };
    if (err.code === "42501") return { status: 500, message: "The studio server can't read Onshape keys: SUPABASE_SECRET_KEY in Slop-Backend/.dev.vars must be the secret key (sb_secret_…), not the publishable one." };
    return { status: 500, message: `Couldn't read your Onshape keys: ${err.message}` };
  }
  return explainOnshapeError(err);
}

function documentLink(b: Record<string, unknown>): string {
  const url = typeof b.documentUrl === "string" ? b.documentUrl.trim() : "";
  if (!url) throw new HttpError(400, "Paste the link of the Onshape document to build into.");
  return url;
}

function findRun(runs: Runs, id: string) {
  const run = runs.get(id);
  if (!run) throw new HttpError(404, "No such run. The server may have restarted.");
  return run;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, last-event-id");
  // Chrome asks before a public page talks to localhost (Private Network Access).
  if (req.headers["access-control-request-private-network"]) res.setHeader("access-control-allow-private-network", "true");
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Request too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!size) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return reject(new HttpError(400, "Body must be a JSON object."));
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "Body must be JSON."));
      }
    });
    req.on("error", reject);
  });
}
