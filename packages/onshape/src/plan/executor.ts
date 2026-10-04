import type { DatumName, Document, EntityType, Feature, Parameter, Ref, TopoRef } from "@slop/ir";
import type { OnshapeApi } from "../client/api.ts";
import type { BTFeature, BTMFeature, BTParameter, BTQuery, DocumentRef } from "../client/types.ts";
import { boolParam, enumParam, idQuery, quantity, queryList, sketchRegionQuery, stringParam } from "../expression.ts";
import { frameOf, querySketchPlane, queryTopology, type Candidate } from "../fs/topology.ts";
import { dist, dot, normalize, sameFrame, type PlaneFrame } from "../geometry.ts";
import { rankCandidates, type RankedCandidate, type ResolveOptions } from "../resolver.ts";
import { composeSketch, SketchComposeError } from "../sketch/compose.ts";
import type { EntityPredicate, Op, ParameterValue, Selection } from "./types.ts";

/**
 * SolidWorks default planes -> Onshape default planes, chosen so the part
 * lands in the same model coordinates: SolidWorks Front is z = 0 (normal +Z),
 * which is Onshape Top; SolidWorks Top is y = 0, which is Onshape Front.
 * Onshape's own frame for each plane is queried, never assumed.
 * ASSUMPTION to verify in Phase 0 (open question 2).
 */
export const DATUM_REMAP: Record<Exclude<DatumName, "ORIGIN">, string> = { FRONT: "Top", TOP: "Front", RIGHT: "Right" };

/** A selection that resolved to more than one plausible entity: the translator must choose. */
export class AmbiguousSelectionError extends Error {
  constructor(
    public readonly opId: string,
    public readonly selection: Selection,
    public readonly ranked: RankedCandidate[],
  ) {
    super(`op ${opId}: ${ranked.length} candidates tie for ${JSON.stringify(selection)}; pick with {kind:"entities", ids:[...]}`);
    this.name = "AmbiguousSelectionError";
  }
}

export class ExecutionError extends Error {
  constructor(
    public readonly opId: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`op ${opId}: ${message}`);
    this.name = "ExecutionError";
  }
}

export interface SelectionRecord {
  opId: string;
  parameterId: string;
  selection: Selection;
  deterministicIds: string[];
  resolver: "datum" | "origin" | "feature" | "semantic" | "signature" | "probe" | "explicit" | "query";
  confidence: number;
  runnerUp?: number;
  candidates?: number;
}

export interface OpResult {
  opId: string;
  onshapeFeatureId: string;
  featureStatus?: string;
  notes: string[];
  selections: SelectionRecord[];
}

export interface StepExecution {
  results: OpResult[];
  /** Set when execution stopped partway; results hold what succeeded before it. */
  error?: ExecutionError | AmbiguousSelectionError;
}

/** Read-only view of executor state for planners. */
export interface StepContext {
  readonly ir: Document;
  onshapeId(planOpId: string): string | undefined;
  sketchFrame(planOpId: string): PlaneFrame | undefined;
  datumFrame(name: Exclude<DatumName, "ORIGIN">): Promise<PlaneFrame>;
  listTopology(planOpId: string, entity: EntityType): Promise<Candidate[]>;
  /** Plan op ids that implemented an IR feature (set once its step is accepted). */
  opsFor(irFeatureId: string): string[];
}

/**
 * Executes plan ops against one Part Studio. Keeps the plan-id -> Onshape-id
 * map, the Onshape frame of every sketch it created, and a topology cache
 * that is invalidated whenever the model changes.
 */
export class Executor implements StepContext {
  private readonly parameters: ReadonlyMap<string, Parameter>;
  private readonly irById = new Map<string, Feature>();
  private readonly onshapeIds = new Map<string, string>();
  private readonly frames = new Map<string, PlaneFrame>();
  private readonly irToOps = new Map<string, string[]>();
  private readonly datums = new Map<string, { id: string; frame: PlaneFrame }>();
  private readonly topology = new Map<string, Promise<Candidate[]>>();
  private origin: Promise<string> | undefined;

  constructor(
    readonly ir: Document,
    private readonly api: OnshapeApi,
    readonly ref: DocumentRef,
    private readonly resolverOptions: ResolveOptions = {},
  ) {
    this.parameters = new Map(ir.parameters.map((p) => [p.id, p]));
    for (const f of ir.partStudio.features) this.irById.set(f.id, f);
  }

  // --- StepContext -----------------------------------------------------------

  onshapeId(planOpId: string): string | undefined {
    return this.onshapeIds.get(planOpId);
  }
  sketchFrame(planOpId: string): PlaneFrame | undefined {
    return this.frames.get(planOpId);
  }
  async datumFrame(name: Exclude<DatumName, "ORIGIN">): Promise<PlaneFrame> {
    return (await this.datumPlane(name)).frame;
  }
  listTopology(planOpId: string, entity: EntityType): Promise<Candidate[]> {
    const id = this.onshapeIds.get(planOpId);
    if (!id) return Promise.reject(new Error(`plan op ${planOpId} has not been built`));
    return this.query(id, entity);
  }
  opsFor(irFeatureId: string): string[] {
    return this.irToOps.get(irFeatureId) ?? [];
  }

  /** Record that a step's ops implement an IR feature (called by the builder on acceptance). */
  accept(irFeatureId: string, opIds: string[]): void {
    this.irToOps.set(irFeatureId, opIds);
  }

  // --- execution -------------------------------------------------------------

  async run(ops: Op[]): Promise<StepExecution> {
    const results: OpResult[] = [];
    for (const op of ops) {
      try {
        results.push(await this.runOp(op));
      } catch (err) {
        // A feature that was created but failed to regenerate is still in the
        // document; keep its result so undo() deletes it.
        const partial = (err as { partial?: OpResult }).partial;
        if (partial) results.push(partial);
        const error = err instanceof ExecutionError || err instanceof AmbiguousSelectionError ? err : new ExecutionError(op.id, err instanceof Error ? err.message : String(err), err);
        return { results, error };
      }
    }
    return { results };
  }

  /** Delete what a failed attempt created, newest first, and forget its ids. */
  async undo(execution: StepExecution): Promise<void> {
    for (const r of [...execution.results].reverse()) {
      await this.api.deleteFeature(this.ref, r.onshapeFeatureId);
      this.onshapeIds.delete(r.opId);
      this.frames.delete(r.opId);
    }
    this.topology.clear();
  }

  private async runOp(op: Op): Promise<OpResult> {
    if (this.onshapeIds.has(op.id)) throw new ExecutionError(op.id, `plan op id "${op.id}" already used`);
    const selections: SelectionRecord[] = [];
    const notes: string[] = [];
    let feature: BTFeature;

    switch (op.op) {
      case "createVariable":
        // UNVERIFIED: Onshape's Variable feature is featureType "assignVariable" with "name" and "value" parameters.
        feature = { btType: "BTMFeature-134", featureType: "assignVariable", name: op.name, parameters: [stringParam("name", op.name), quantity("value", op.expression)] };
        notes.push("variable feature JSON is unverified");
        break;

      case "createSketch": {
        const plane = await this.resolveSelection(op.id, "sketchPlane", op.plane, "face");
        selections.push(plane.record);
        const frame = plane.candidate ? frameOf(plane.candidate) : plane.frame;
        if (!frame) throw new ExecutionError(op.id, "sketch plane resolved without a frame");
        const irSketch = op.irSketch ? this.irById.get(op.irSketch) : undefined;
        if (op.irSketch && (!irSketch || irSketch.op !== "sketch")) throw new ExecutionError(op.id, `irSketch "${op.irSketch}" is not an IR sketch`);
        const needsOrigin = [...op.constraints, ...op.dimensions].some((c) => c.args.includes("ORIGIN"));
        let composed;
        try {
          composed = composeSketch({
            name: op.name,
            planeIds: plane.record.deterministicIds,
            frame,
            ...(irSketch && irSketch.op === "sketch" ? { sourceTransform: irSketch.transform } : {}),
            entities: op.entities,
            constraints: op.constraints,
            dimensions: op.dimensions,
            ...(needsOrigin ? { originId: await this.originId() } : {}),
            parameters: this.parameters,
            idPrefix: op.id,
          });
        } catch (err) {
          if (err instanceof SketchComposeError) throw new ExecutionError(op.id, err.message, err);
          throw err;
        }
        notes.push(...composed.notes);
        feature = composed.feature;
        this.frames.set(op.id, frame);
        break;
      }

      case "createFeature":
      case "insertCustomFeature": {
        const params: BTParameter[] = [];
        for (const p of op.parameters) {
          const built = await this.buildParameter(op.id, p);
          params.push(built.parameter);
          selections.push(...built.selections);
        }
        const f: BTMFeature = { btType: "BTMFeature-134", featureType: op.featureType, name: op.name, parameters: params };
        if (op.op === "insertCustomFeature") f.namespace = op.namespace;
        feature = f;
        break;
      }

      case "geometryPatch":
        throw new ExecutionError(op.id, "geometry patch (rung 5) is not implemented: needs Parasolid import via blobelements + translations");
    }

    const res = await this.api.addFeature(this.ref, feature);
    const onshapeFeatureId = res.feature.featureId;
    if (!onshapeFeatureId) throw new ExecutionError(op.id, "Onshape returned a feature without featureId");
    this.onshapeIds.set(op.id, onshapeFeatureId);
    this.topology.clear();

    const status = res.featureState?.featureStatus;
    if (op.op === "createSketch" && (!status || status === "OK" || status === "WARNING")) {
      // Open question 2 (doc §17): confirm Onshape's sketch frame is the one the coordinates were written in.
      const assumed = this.frames.get(op.id)!;
      const actual = await querySketchPlane(this.api, this.ref, onshapeFeatureId);
      if (actual && !sameFrame(assumed, actual)) {
        const result: OpResult = { opId: op.id, onshapeFeatureId, featureStatus: status ?? "OK", notes, selections };
        throw Object.assign(
          new ExecutionError(op.id, `sketch frame mismatch: coordinates were written for origin ${fmt(assumed.origin)} x ${fmt(assumed.x)}, Onshape used origin ${fmt(actual.origin)} x ${fmt(actual.x)}`),
          { partial: result },
        );
      }
    }
    if (status && status !== "OK" && status !== "WARNING") {
      // Leave the id registered so undo() can delete it.
      const result: OpResult = { opId: op.id, onshapeFeatureId, featureStatus: status, notes, selections };
      throw Object.assign(new ExecutionError(op.id, `Onshape regeneration status ${status}`), { partial: result });
    }
    return { opId: op.id, onshapeFeatureId, ...(status ? { featureStatus: status } : {}), notes, selections };
  }

  private async buildParameter(opId: string, p: ParameterValue): Promise<{ parameter: BTParameter; selections: SelectionRecord[] }> {
    if ("quantity" in p) return { parameter: quantity(p.id, p.quantity), selections: [] };
    if ("enum" in p) return { parameter: enumParam(p.id, p.enum.name, p.enum.value), selections: [] };
    if ("boolean" in p) return { parameter: boolParam(p.id, p.boolean), selections: [] };
    if ("string" in p) return { parameter: stringParam(p.id, p.string), selections: [] };

    const queries: BTQuery[] = [];
    const selections: SelectionRecord[] = [];
    for (const sel of p.selections) {
      const r = await this.resolveSelection(opId, p.id, sel);
      selections.push(r.record);
      queries.push(r.query);
    }
    return { parameter: queryList(p.id, queries), selections };
  }

  // --- selections ------------------------------------------------------------

  private async resolveSelection(
    opId: string,
    parameterId: string,
    sel: Selection,
    expectEntity?: EntityType,
  ): Promise<{ query: BTQuery; record: SelectionRecord; candidate?: Candidate; frame?: PlaneFrame }> {
    const rec = (ids: string[], resolver: SelectionRecord["resolver"], extra: Partial<SelectionRecord> = {}): SelectionRecord => ({
      opId,
      parameterId,
      selection: sel,
      deterministicIds: ids,
      resolver,
      confidence: 1,
      ...extra,
    });

    switch (sel.kind) {
      case "datum": {
        const d = await this.datumPlane(sel.name);
        return { query: idQuery([d.id]), record: rec([d.id], "datum"), frame: d.frame };
      }
      case "origin": {
        const id = await this.originId();
        return { query: idQuery([id]), record: rec([id], "origin") };
      }
      case "sketchRegion": {
        const id = this.onshapeIds.get(sel.sketch);
        if (!id) throw new ExecutionError(opId, `sketch "${sel.sketch}" has not been built in this plan`);
        return { query: sketchRegionQuery(id), record: rec([id], "feature") };
      }
      case "entities":
        return { query: idQuery(sel.ids), record: rec(sel.ids, "explicit") };
      case "createdBy": {
        const id = this.onshapeIds.get(sel.feature);
        if (!id) throw new ExecutionError(opId, `feature "${sel.feature}" has not been built in this plan`);
        const all = await this.query(id, sel.entity);
        const matched = sel.where ? all.filter((c) => matchesPredicate(c, sel.where!, this.resolverOptions)) : all;
        if (matched.length === 0) throw new ExecutionError(opId, `no ${sel.entity} created by ${sel.feature} matches ${JSON.stringify(sel.where ?? {})}; ${all.length} candidates`);
        if (expectEntity && matched.length !== 1) throw new AmbiguousSelectionError(opId, sel, matched.map((c) => ({ candidate: c, score: 1, resolver: "semantic" })));
        const ids = matched.map((c) => c.id);
        return { query: idQuery(ids), record: rec(ids, "query", { candidates: all.length }), ...(matched.length === 1 ? { candidate: matched[0]! } : {}) };
      }
      case "irRef": {
        const ref = this.irRefAt(opId, sel.irFeature, sel.path);
        return this.resolveIrRef(opId, parameterId, sel, ref, expectEntity);
      }
    }
  }

  private async resolveIrRef(opId: string, parameterId: string, sel: Selection, ref: Ref, expectEntity?: EntityType) {
    const base = { opId, parameterId, selection: sel };
    switch (ref.kind) {
      case "datum": {
        if (ref.name === "ORIGIN") {
          const id = await this.originId();
          return { query: idQuery([id]), record: { ...base, deterministicIds: [id], resolver: "origin" as const, confidence: 1 } };
        }
        const d = await this.datumPlane(ref.name);
        return { query: idQuery([d.id]), record: { ...base, deterministicIds: [d.id], resolver: "datum" as const, confidence: 1 }, frame: d.frame };
      }
      case "feature-output": {
        const opIds = this.opsFor(ref.feature);
        if (opIds.length === 0) throw new ExecutionError(opId, `IR feature ${ref.feature} has no accepted plan ops yet`);
        if (ref.role === "region") {
          const sketchOp = opIds.find((o) => this.frames.has(o)) ?? opIds[0]!;
          const id = this.onshapeIds.get(sketchOp)!;
          return { query: sketchRegionQuery(id), record: { ...base, deterministicIds: [id], resolver: "feature" as const, confidence: 1 } };
        }
        if (ref.role === "plane") {
          const faces = (await Promise.all(opIds.map((o) => this.query(this.onshapeIds.get(o)!, "face")))).flat();
          if (faces.length !== 1) throw new ExecutionError(opId, `plane feature ${ref.feature} produced ${faces.length} faces`);
          return { query: idQuery([faces[0]!.id]), record: { ...base, deterministicIds: [faces[0]!.id], resolver: "feature" as const, confidence: 1 }, candidate: faces[0]! };
        }
        throw new ExecutionError(opId, `feature-output role "${ref.role}" cannot be used as a selection`);
      }
      case "topo": {
        if (expectEntity && ref.entity !== expectEntity) throw new ExecutionError(opId, `expected a ${expectEntity}, IR ref is a ${ref.entity}`);
        const candidates = await this.candidatesFor(opId, ref);
        const decision = rankCandidates(ref, candidates, this.resolverOptions);
        if (decision.kind === "tie") throw new AmbiguousSelectionError(opId, sel, decision.ranked);
        if (decision.kind === "none") throw new ExecutionError(opId, decision.reason);
        const r = decision.resolution;
        return {
          query: idQuery([r.id]),
          record: { ...base, deterministicIds: [r.id], resolver: r.resolver, confidence: r.confidence, ...(r.runnerUp !== undefined ? { runnerUp: r.runnerUp } : {}), candidates: r.candidates },
          candidate: r.candidate,
        };
      }
    }
  }

  /** Entities created by the plan ops that implemented `ref.createdBy`. */
  private async candidatesFor(opId: string, ref: TopoRef): Promise<Candidate[]> {
    if (!ref.createdBy) throw new ExecutionError(opId, "topological reference without createdBy cannot be scoped yet (needs whole-body search)");
    const opIds = this.opsFor(ref.createdBy);
    if (opIds.length === 0) throw new ExecutionError(opId, `IR feature ${ref.createdBy} has no accepted plan ops yet`);
    const lists = await Promise.all(opIds.map((o) => this.query(this.onshapeIds.get(o)!, ref.entity)));
    return lists.flat();
  }

  private irRefAt(opId: string, irFeatureId: string, path: string): Ref {
    const f = this.irById.get(irFeatureId);
    if (!f) throw new ExecutionError(opId, `unknown IR feature "${irFeatureId}"`);
    let node: unknown = f;
    for (const part of path.split(/\.|\[|\]/).filter(Boolean)) {
      if (node === null || typeof node !== "object") break;
      node = (node as Record<string, unknown>)[part];
    }
    if (!node || typeof node !== "object" || !("kind" in node)) throw new ExecutionError(opId, `"${irFeatureId}.${path}" is not an IR Ref`);
    return node as Ref;
  }

  // --- datums and topology ---------------------------------------------------

  private async datumPlane(name: Exclude<DatumName, "ORIGIN">): Promise<{ id: string; frame: PlaneFrame }> {
    const cached = this.datums.get(name);
    if (cached) return cached;
    const faces = await this.query(DATUM_REMAP[name], "face");
    if (faces.length !== 1) throw new Error(`Onshape datum ${DATUM_REMAP[name]} returned ${faces.length} faces`);
    const result = { id: faces[0]!.id, frame: frameOf(faces[0]!) };
    this.datums.set(name, result);
    return result;
  }

  private originId(): Promise<string> {
    this.origin ??= this.query("Origin", "vertex").then((v) => {
      if (v.length !== 1) throw new Error(`Onshape origin query returned ${v.length} vertices`);
      return v[0]!.id;
    });
    return this.origin;
  }

  private query(onshapeFeatureId: string, entity: EntityType): Promise<Candidate[]> {
    const key = `${onshapeFeatureId}/${entity}`;
    let p = this.topology.get(key);
    if (!p) {
      p = queryTopology(this.api, this.ref, onshapeFeatureId, entity);
      this.topology.set(key, p);
    }
    return p;
  }
}

function matchesPredicate(c: Candidate, w: EntityPredicate, o: ResolveOptions): boolean {
  const tol = o.tol ?? 1e-6;
  if (w.type && c.type !== w.type) return false;
  if (w.normal) {
    const n = c.normal ?? c.axis;
    if (!n || Math.abs(dot(normalize(n), normalize(w.normal))) < 1 - 1e-6) return false;
  }
  if (w.offset !== undefined) {
    if (!c.normal || !c.origin || Math.abs(dot(c.origin, normalize(c.normal)) - w.offset) > tol) return false;
  }
  if (w.radius !== undefined && (c.radius === undefined || Math.abs(c.radius - w.radius) > tol)) return false;
  if (w.near) {
    const p = c.midpoint ?? c.centroid ?? c.center ?? c.point ?? c.origin;
    if (!p || dist(p, w.near) > Math.max(tol * 1000, 1e-3)) return false;
  }
  return true;
}

const fmt = (v: readonly number[]): string => `(${v.map((x) => +x.toFixed(6)).join(", ")})`;
