/**
 * Runs: one migration each, from "open the user's document" to "finished".
 *
 * A run holds the Onshape keys only inside its client, for as long as the
 * build takes; snapshots, events and recordings never contain them. Progress
 * is an ordered event list that late viewers replay from the start, so a
 * second screen that opens halfway through still sees the whole build.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Document } from "@slop/ir";
import type { BuildReport, DocumentRef, OnshapeApi, OnshapeConfig, Planner } from "@slop/onshape";
import { runBuild, type RunEvent } from "@slop/runner";
import { faceIds, toMesh, type Mesh } from "./mesh.ts";
import { documentUrl, parseDocumentLink } from "./onshape-link.ts";
import { explainOnshapeError, type StudioOnshape } from "./onshape.ts";
import type { Source, SourceInfo } from "./sources.ts";

export type RunStatus = "preparing" | "building" | "testing" | "succeeded" | "failed" | "cancelled";

export interface StudioEvent {
  seq: number;
  /** Milliseconds since the run started. */
  t: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface Credentials {
  accessKey: string;
  secretKey: string;
  documentUrl: string;
}

export interface RunRequest {
  source: Source;
  /** Firebase uid of the signed-in user who started it; only they may cancel it. */
  owner?: string;
  /** The owner's own keys (read server-side from their account) and the document to build into. */
  onshape: Credentials;
  /** `newTab` adds a Part Studio to the document; `linked` builds into the tab the link names. */
  target: { mode: "newTab" | "linked"; clear?: boolean };
  planner: "claude" | "rules";
  behavior: boolean;
}

export interface RunStats {
  apiCalls: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RunDocument extends DocumentRef {
  url: string;
  name: string;
  elementName: string;
}

export interface RunSnapshot {
  id: string;
  status: RunStatus;
  planner: string;
  behavior: boolean;
  /** Set for replays of a recorded run. */
  replayOf?: string;
  source: SourceInfo;
  ir: Document;
  document?: RunDocument;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  stats: RunStats;
  meshVersion: number;
  events: StudioEvent[];
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  name: string;
  planner: string;
  startedAt: string;
  finishedAt?: string;
  replayOf?: string;
}

export interface RunDeps {
  connect(cfg: OnshapeConfig): StudioOnshape;
  planner(name: string, ir: Document): Planner;
  authScheme: OnshapeConfig["authScheme"];
  apiVersion: string;
  /** Finished runs are written here (events and meshes) and can be replayed. */
  recordDir?: string;
  log?: (line: string) => void;
}

export class RunError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "RunError";
  }
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** Ops that change the solid, so the viewer has something new to show. */
const SOLID_OPS = new Set(["extrude", "revolve", "fillet", "chamfer", "hole", "shell", "linearPattern", "circularPattern", "mirror"]);
const TERMINAL: RunStatus[] = ["succeeded", "failed", "cancelled"];

export class Run {
  readonly id = randomUUID();
  readonly started = Date.now();
  readonly events: StudioEvent[] = [];
  readonly meshes: Mesh[] = [];
  readonly abort = new AbortController();
  status: RunStatus = "preparing";
  document?: RunDocument;
  error?: string;
  finishedAt?: number;
  stats: RunStats = { apiCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  private readonly listeners = new Set<(e: StudioEvent) => void>();

  constructor(
    readonly source: SourceInfo,
    readonly ir: Document,
    readonly planner: string,
    readonly behavior: boolean,
    readonly replayOf?: string,
    readonly owner?: string,
  ) {}

  get done(): boolean {
    return TERMINAL.includes(this.status);
  }

  emit(kind: string, payload: Record<string, unknown>, t = Date.now() - this.started): StudioEvent {
    const event = { seq: this.events.length + 1, t, kind, payload };
    this.events.push(event);
    for (const l of this.listeners) l(event);
    return event;
  }

  setStatus(status: RunStatus, message?: string): void {
    this.status = status;
    this.emit("status", { status, ...(message ? { message } : {}) });
  }

  subscribe(listener: (e: StudioEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary(): RunSummary {
    return {
      id: this.id,
      status: this.status,
      name: this.source.name,
      planner: this.planner,
      startedAt: new Date(this.started).toISOString(),
      ...(this.finishedAt ? { finishedAt: new Date(this.finishedAt).toISOString() } : {}),
      ...(this.replayOf ? { replayOf: this.replayOf } : {}),
    };
  }

  snapshot(): RunSnapshot {
    return {
      id: this.id,
      status: this.status,
      planner: this.planner,
      behavior: this.behavior,
      ...(this.replayOf ? { replayOf: this.replayOf } : {}),
      source: this.source,
      ir: this.ir,
      ...(this.document ? { document: this.document } : {}),
      startedAt: new Date(this.started).toISOString(),
      ...(this.finishedAt ? { finishedAt: new Date(this.finishedAt).toISOString() } : {}),
      ...(this.error ? { error: this.error } : {}),
      stats: this.stats,
      meshVersion: this.meshes.length,
      events: this.events,
    };
  }
}

/**
 * The builder's Onshape calls wait here while the viewer fetches the model,
 * so each mesh shows exactly the feature that was just accepted. A cancelled
 * run fails its next call.
 */
class GatedApi implements OnshapeApi {
  private gate: Promise<void> = Promise.resolve();
  featureSpecs?: OnshapeApi["featureSpecs"];
  shadedView?: OnshapeApi["shadedView"];

  constructor(
    private readonly inner: OnshapeApi,
    private readonly signal: AbortSignal,
  ) {
    if (inner.featureSpecs) this.featureSpecs = async (ref) => (await this.ready(), inner.featureSpecs!(ref));
    if (inner.shadedView) this.shadedView = async (ref) => (await this.ready(), inner.shadedView!(ref));
  }

  hold(work: Promise<unknown>): void {
    this.gate = Promise.all([this.gate, work]).then(
      () => undefined,
      () => undefined,
    );
  }

  settle(): Promise<void> {
    return this.gate;
  }

  private async ready(): Promise<void> {
    await this.gate;
    if (this.signal.aborted) throw new CancelledError();
  }

  callCount(): number {
    return this.inner.callCount();
  }
  async createDocument(name: string) {
    await this.ready();
    return this.inner.createDocument(name);
  }
  async getFeatures(ref: DocumentRef) {
    await this.ready();
    return this.inner.getFeatures(ref);
  }
  async addFeature(ref: DocumentRef, feature: Parameters<OnshapeApi["addFeature"]>[1]) {
    await this.ready();
    return this.inner.addFeature(ref, feature);
  }
  async evaluateFeatureScript(ref: DocumentRef, script: string) {
    await this.ready();
    return this.inner.evaluateFeatureScript(ref, script);
  }
  async massProperties(ref: DocumentRef) {
    await this.ready();
    return this.inner.massProperties(ref);
  }
  async deleteFeature(ref: DocumentRef, featureId: string) {
    await this.ready();
    return this.inner.deleteFeature(ref, featureId);
  }
  async updateFeature(ref: DocumentRef, featureId: string, feature: Parameters<OnshapeApi["updateFeature"]>[2]) {
    await this.ready();
    return this.inner.updateFeature(ref, featureId, feature);
  }
}

function cancellable(planner: Planner, signal: AbortSignal): Planner {
  const check = () => {
    if (signal.aborted) throw new CancelledError();
  };
  return {
    provenance: planner.provenance,
    proposeStep: async (req) => (check(), planner.proposeStep(req)),
    reviseStep: async (req, previous, feedback) => (check(), planner.reviseStep(req, previous, feedback)),
    proposeBehaviorTests: async (ir, steps) => (check(), planner.proposeBehaviorTests(ir, steps)),
    usage: () => planner.usage(),
  };
}

export class Runs {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly deps: RunDeps) {}

  list(limit = 20): RunSummary[] {
    return [...this.runs.values()].reverse().slice(0, limit).map((r) => r.summary());
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  active(): Run | undefined {
    return [...this.runs.values()].find((r) => !r.done);
  }

  start(req: RunRequest): Run {
    const busy = this.active();
    if (busy) throw new RunError(`A migration of ${busy.source.name} is still running.`, 409);
    parseDocumentLink(req.onshape.documentUrl); // fail fast on a bad link
    const run = this.track(new Run(req.source.info, req.source.ir, req.planner, req.behavior, undefined, req.owner));
    void this.execute(run, req);
    return run;
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.done) return false;
    run.abort.abort();
    run.emit("log", { line: "Cancelling after the current Onshape call…" });
    return true;
  }

  // --- recordings ------------------------------------------------------------

  recordings(): Array<{ id: string; name: string; planner: string; status: RunStatus; startedAt: string; features: number }> {
    const dir = this.deps.recordDir;
    if (!dir) return [];
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { snapshot: RunSnapshot };
        out.push({ id: f.replace(/\.json$/, ""), name: rec.snapshot.source.name, planner: rec.snapshot.planner, status: rec.snapshot.status, startedAt: rec.snapshot.startedAt, features: rec.snapshot.ir.partStudio.features.length });
      } catch {
        /* not a recording */
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Plays a recorded run back with its original timing (divided by `speed`). Costs no API calls. */
  replay(recordingId: string, speed = 1, owner?: string): Run {
    const dir = this.deps.recordDir;
    if (!dir || !/^[\w-]+$/.test(recordingId)) throw new RunError("No such recording.", 404);
    let rec: { snapshot: RunSnapshot; meshes: Mesh[] };
    try {
      rec = JSON.parse(readFileSync(join(dir, `${recordingId}.json`), "utf8"));
    } catch {
      throw new RunError("No such recording.", 404);
    }
    const busy = this.active();
    if (busy) throw new RunError(`A migration of ${busy.source.name} is still running.`, 409);

    const s = rec.snapshot;
    const run = this.track(new Run(s.source, s.ir, s.planner, s.behavior, recordingId, owner));
    const pace = Math.max(0.1, Math.min(speed, 20));
    const timers: NodeJS.Timeout[] = [];
    run.abort.signal.addEventListener("abort", () => {
      timers.forEach(clearTimeout);
      run.status = "cancelled";
      run.finishedAt = Date.now();
      run.emit("finished", { status: "cancelled", stats: run.stats, durationMs: run.finishedAt - run.started });
    });
    for (const e of s.events) {
      timers.push(
        setTimeout(() => {
          if (e.kind === "status") run.status = e.payload.status as RunStatus;
          if (e.kind === "document") run.document = { ...(e.payload as unknown as RunDocument) };
          if (e.kind === "mesh") run.meshes.push(rec.meshes[(e.payload.version as number) - 1]!);
          if (e.kind === "stats" || e.kind === "finished") run.stats = (e.payload.stats as RunStats | undefined) ?? (e.payload as unknown as RunStats);
          if (e.kind === "finished") {
            run.status = e.payload.status as RunStatus;
            run.error = e.payload.error as string | undefined;
            run.finishedAt = Date.now();
          }
          run.emit(e.kind, e.payload, Math.round(e.t / pace));
        }, e.t / pace),
      );
    }
    return run;
  }

  // --- the build ---------------------------------------------------------------

  private track(run: Run): Run {
    this.runs.set(run.id, run);
    if (this.runs.size > 25) this.runs.delete(this.runs.keys().next().value!);
    return run;
  }

  private async execute(run: Run, req: RunRequest): Promise<void> {
    const log = this.deps.log ?? (() => {});
    const link = parseDocumentLink(req.onshape.documentUrl);
    const client = this.deps.connect({
      baseUrl: link.baseUrl,
      accessKey: req.onshape.accessKey,
      secretKey: req.onshape.secretKey,
      authScheme: this.deps.authScheme,
      apiVersion: this.deps.apiVersion,
    });
    const api = new GatedApi(client, run.abort.signal);
    let planner: Planner | undefined;
    const refreshStats = () => {
      const usage = planner?.usage();
      run.stats = { apiCalls: client.callCount(), llmCalls: usage?.calls ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
      run.emit("stats", { ...run.stats });
    };
    log(`→ run ${run.id.slice(0, 8)} ${req.source.info.name} planner=${req.planner} target=${req.target.mode}`);

    let outcome: { status: "succeeded" | "failed"; error?: string; report?: BuildReport } | undefined;
    try {
      run.setStatus("preparing", "Opening your Onshape document");
      const target = await this.prepareTarget(run, req, client, link);
      if (run.abort.signal.aborted) throw new CancelledError();

      run.setStatus("building", `Rebuilding ${req.source.info.name} feature by feature`);
      const total = req.source.ir.partStudio.features.length;
      outcome = await runBuild(
        { id: run.id, name: req.source.info.name, planner: req.planner, ir: req.source.ir },
        {
          api,
          target,
          baseUrl: link.baseUrl,
          behavior: req.behavior,
          planner: (name, ir) => (planner = cancellable(this.deps.planner(name, ir), run.abort.signal)),
          emit: (e: RunEvent) => {
            if (e.kind === "finished") return; // ours goes out once the last mesh has arrived
            if (e.kind === "document") {
              run.emit("document", { ...run.document! });
              return;
            }
            run.emit(e.kind, e.payload as Record<string, unknown>);
            if (e.kind === "feature") {
              const p = e.payload as unknown as { index: number; irId: string; op: string; status: string; name: string; rung: string };
              log(`  ${p.index + 1}/${total}: ${p.name} ${p.status} (${p.rung})`);
              if (p.status === "built" && SOLID_OPS.has(p.op)) api.hold(this.captureMesh(run, client, target, p.index, p.irId));
              refreshStats();
              if (p.index === total - 1 && p.status !== "failed" && req.behavior) run.setStatus("testing", "Changing driving dimensions in Onshape and comparing with SolidWorks");
            } else if (e.kind === "behavior") {
              refreshStats();
            }
          },
        },
      );
    } catch (err) {
      if (!(err instanceof CancelledError)) {
        const { message } = explainOnshapeError(err);
        outcome = { status: "failed", error: message };
      }
    }

    await api.settle();
    refreshStats();
    const status: RunStatus = run.abort.signal.aborted ? "cancelled" : (outcome?.status ?? "failed");
    run.status = status;
    run.finishedAt = Date.now();
    if (status === "failed") run.error = outcome?.error ?? "build failed";
    run.emit("finished", {
      status,
      ...(status === "failed" && run.error ? { error: run.error } : {}),
      ...(outcome?.report ? { summary: outcome.report.summary, stoppedEarly: outcome.report.stoppedEarly } : {}),
      stats: run.stats,
      durationMs: run.finishedAt - run.started,
    });
    log(`  ${status === "succeeded" ? "✓" : "✗"} ${status} in ${((run.finishedAt - run.started) / 1000).toFixed(1)} s, ${run.stats.apiCalls} Onshape calls${run.error ? `: ${run.error.split("\n")[0]}` : ""}`);
    this.record(run);
  }

  private async prepareTarget(run: Run, req: RunRequest, client: StudioOnshape, link: ReturnType<typeof parseDocumentLink>): Promise<DocumentRef> {
    const doc = await client.getDocument(link.did);
    const wid = link.wid ?? doc.defaultWorkspace?.id;
    if (!wid) throw new RunError("Couldn't find the document's workspace. Copy the link while the document is open.");

    let eid: string;
    let elementName: string;
    if (req.target.mode === "linked") {
      if (!link.eid) throw new RunError("The link names no tab. Open the Part Studio you want to build into and copy the link again.");
      const el = (await client.getElements(link.did, wid)).find((e) => e.id === link.eid);
      if (!el) throw new RunError("The tab in the link isn't in this document's workspace.", 404);
      if (el.elementType !== "PARTSTUDIO") throw new RunError(`"${el.name}" is not a Part Studio.`);
      eid = el.id;
      elementName = el.name;
      const ref = { did: link.did, wid, eid };
      const existing = (await client.getFeatures(ref)).features.filter((f) => f.featureId);
      if (existing.length) {
        if (!req.target.clear) throw new RunError(`"${el.name}" already has ${existing.length} feature(s). Choose a new tab, or allow clearing it.`, 409);
        run.setStatus("preparing", `Clearing ${existing.length} feature(s) from "${el.name}"`);
        for (const f of [...existing].reverse()) {
          if (run.abort.signal.aborted) throw new CancelledError();
          await client.deleteFeature(ref, f.featureId!);
        }
      }
    } else {
      const el = await client.createPartStudio(link.did, wid, `${req.source.info.name} (from SolidWorks)`);
      eid = el.id;
      elementName = el.name;
    }
    run.document = { did: link.did, wid, eid, url: documentUrl({ baseUrl: link.baseUrl, did: link.did, wid, eid }), name: doc.name, elementName };
    return { did: link.did, wid, eid };
  }

  private async captureMesh(run: Run, client: StudioOnshape, ref: DocumentRef, index: number, irId: string): Promise<void> {
    try {
      const mesh = toMesh(await client.tessellatedFaces(ref));
      const before = new Set(run.meshes.length ? faceIds(run.meshes.at(-1)!) : []);
      const ids = faceIds(mesh);
      run.meshes.push(mesh);
      run.emit("mesh", {
        version: run.meshes.length,
        index,
        irId,
        triangles: mesh.triangles,
        faces: ids.length,
        added: ids.filter((id) => !before.has(id)),
        ...(mesh.bbox ? { bbox: mesh.bbox } : {}),
      });
    } catch (err) {
      run.emit("log", { line: `viewer: couldn't fetch the model after ${irId}: ${explainOnshapeError(err).message}` });
    }
  }

  private record(run: Run): void {
    const dir = this.deps.recordDir;
    if (!dir || run.replayOf || run.status === "cancelled" || !run.meshes.length) return;
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date(run.started).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `${stamp}-${run.source.name.replace(/[^\w-]+/g, "_").slice(0, 40)}`;
      writeFileSync(join(dir, `${name}.json`), JSON.stringify({ snapshot: run.snapshot(), meshes: run.meshes }));
    } catch (err) {
      this.deps.log?.(`  ! couldn't record run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
