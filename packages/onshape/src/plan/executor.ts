import type { Constraint, DatumName, Dimension, Document, EntityType, Feature, Parameter, Ref, Rung, SketchArg, TopoRef } from "@slop/ir";
import type { OnshapeApi } from "../client/api.ts";
import type { BTFeature, BTMFeature, BTParameter, BTQuery, DocumentRef } from "../client/types.ts";
import { boolParam, enumParam, featureQuery, idQuery, quantity, queryList, sketchRegionQuery, stringParam } from "../expression.ts";
import { frameOf, querySketchPlane, queryTopology, type Candidate } from "../fs/topology.ts";
import { applyPoint, dist, dot, normalize, sameFrame, type PlaneFrame } from "../geometry.ts";
import { rankCandidates, type RankedCandidate, type ResolveOptions } from "../resolver.ts";
import { composeSketch, externalArg, parseExternalArg, SketchComposeError } from "../sketch/compose.ts";
import type { CreateSketchOp, EntityPredicate, Op, ParameterValue, Selection } from "./types.ts";

/**
 * SolidWorks default planes -> Onshape default planes, chosen so the part
 * lands in the same model coordinates: SolidWorks Front is z = 0 (normal +Z),
 * which is Onshape Top; SolidWorks Top is y = 0, which is Onshape Front.
 * Onshape's own frame for each plane is queried, never assumed.
 * ASSUMPTION to verify in Phase 0 (open question 2).
 */
export const DATUM_REMAP: Record<Exclude<DatumName, "ORIGIN">, string> = { FRONT: "Top", TOP: "Front", RIGHT: "Right" };

/** The IR's reference to one entity of an earlier sketch (revolve axis, pattern direction). Not part of the IR `Ref` union. */
export interface SketchEntityRef {
  kind: "sketch-entity";
  sketch: string;
  entity: string;
}

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
  /**
   * Fidelity the executor could actually realise, when lower than the op
   * claimed (e.g. a sketch whose model-referencing dimensions were skipped).
   * The planner's own rung is a claim; this is the measurement.
   */
  achievedRung?: Rung;
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
    let achievedRung: Rung | undefined;
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
        // Model-geometry args (locating dimensions to edges, on-edge relations) are
        // resolved to deterministic ids here so the sketch references them live.
        const resolvedArgs = await this.resolveSketchArgs(op);
        selections.push(...resolvedArgs.records);
        const needsOrigin = [...resolvedArgs.constraints, ...resolvedArgs.dimensions].some((c) => c.args.includes("ORIGIN"));
        let composed;
        try {
          composed = composeSketch({
            name: op.name,
            planeIds: plane.record.deterministicIds,
            frame,
            ...(op.transform ? { sourceTransform: op.transform } : irSketch && irSketch.op === "sketch" ? { sourceTransform: irSketch.transform } : {}),
            entities: op.entities,
            constraints: resolvedArgs.constraints,
            dimensions: resolvedArgs.dimensions,
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
        if (composed.rung !== "exact") achievedRung = composed.rung;
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
      const result: OpResult = { opId: op.id, onshapeFeatureId, featureStatus: status, notes, selections, ...(achievedRung ? { achievedRung } : {}) };
      throw Object.assign(new ExecutionError(op.id, `Onshape regeneration status ${status}`), { partial: result });
    }
    if (status === "WARNING" && op.op === "createSketch") {
      // A sketch WARNING means Onshape could not apply some constraint (over-defined or
      // unsupported): geometry is there, intent may not be. Verified live: an unaccepted
      // MIDPOINT leaves the sketch in WARNING. Say so rather than report rung exact.
      notes.push("Onshape regenerated the sketch with a WARNING: at least one constraint or dimension was not applied; the sketch may be under-defined");
      achievedRung = "approximated";
    }
    return { opId: op.id, onshapeFeatureId, ...(status ? { featureStatus: status } : {}), notes, selections, ...(achievedRung ? { achievedRung } : {}) };
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
      queries.push(...(Array.isArray(r.query) ? r.query : [r.query]));
    }
    return { parameter: queryList(p.id, queries), selections };
  }

  // --- selections ------------------------------------------------------------

  /**
   * Replace every model-geometry argument of a sketch's constraints and
   * dimensions with an "ext:<id>" argument the composer can write as an
   * external query. IR Refs go through the resolver cascade (a tie surfaces
   * as AmbiguousSelectionError, so the planner can pick); explicit
   * "ext:<id>" picks from the planner are recorded as-is.
   */
  private async resolveSketchArgs(op: CreateSketchOp): Promise<{ constraints: Constraint[]; dimensions: Dimension[]; records: SelectionRecord[] }> {
    const records: SelectionRecord[] = [];
    const irFeature = op.irSketch ?? op.id;

    const resolveArgs = async (args: SketchArg[], label: string, pathOf: (j: number) => string): Promise<SketchArg[]> => {
      const out: SketchArg[] = [];
      for (let j = 0; j < args.length; j++) {
        const arg = args[j]!;
        const explicit = parseExternalArg(arg);
        if (explicit) {
          records.push({ opId: op.id, parameterId: label, selection: { kind: "entities", ids: explicit }, deterministicIds: explicit, resolver: "explicit", confidence: 1 });
          out.push(arg);
          continue;
        }
        if (typeof arg === "string") {
          out.push(arg);
          continue;
        }
        if (arg.kind === "feature-output" && arg.role === "region") throw new ExecutionError(op.id, `${label}: a sketch region cannot be a constraint or dimension argument`);
        const sel: Selection = { kind: "irRef", irFeature, path: pathOf(j) };
        const r = await this.resolveIrRef(op.id, label, sel, arg, arg.kind === "topo" ? arg.entity : undefined);
        records.push(r.record);
        out.push(externalArg(r.record.deterministicIds));
      }
      return out;
    };

    const constraints: Constraint[] = [];
    for (let i = 0; i < op.constraints.length; i++) {
      const c = op.constraints[i]!;
      constraints.push({ ...c, args: await resolveArgs(c.args, `constraint[${i}]`, (j) => `constraints[${i}].args[${j}]`) });
    }
    const dimensions: Dimension[] = [];
    for (let i = 0; i < op.dimensions.length; i++) {
      const d = op.dimensions[i]!;
      dimensions.push({ ...d, args: await resolveArgs(d.args, d.id, (j) => `dimensions[${i}].args[${j}]`) });
    }
    return { constraints, dimensions, records };
  }

  private async resolveSelection(
    opId: string,
    parameterId: string,
    sel: Selection,
    expectEntity?: EntityType,
  ): Promise<{ query: BTQuery | BTQuery[]; record: SelectionRecord; candidate?: Candidate; frame?: PlaneFrame }> {
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
        if (ref.kind === "sketch-entity") return this.resolveSketchEntity(opId, parameterId, sel, ref.sketch, ref.entity, expectEntity);
        return this.resolveIrRef(opId, parameterId, sel, ref, expectEntity);
      }
      case "features": {
        const ids = sel.features.map((f) => {
          const id = this.onshapeIds.get(f);
          if (!id) throw new ExecutionError(opId, `feature "${f}" has not been built in this plan`);
          return id;
        });
        return { query: ids.map(featureQuery), record: rec(ids, "feature") };
      }
      case "sketchEntity":
        return this.resolveSketchEntity(opId, parameterId, sel, sel.sketch, sel.entity, expectEntity);
    }
  }

  /**
   * A sketch entity as a model selection. Onshape gives sketch curves and
   * points deterministic ids like any edge or vertex; the one that corresponds
   * to the IR entity is found by projecting the IR geometry into model space
   * through the sketch transform and probing the entities the sketch created.
   * UNVERIFIED: that `qCreatedBy(sketch, VERTEX)` lists sketch points.
   */
  private async resolveSketchEntity(opId: string, parameterId: string, sel: Selection, sketchId: string, entityId: string, expectEntity?: EntityType) {
    // `sketchId` may be a plan op id or an IR feature id (the two coincide in the rules path).
    let sketchOpId = sketchId;
    let onshapeSketch = this.onshapeIds.get(sketchOpId);
    if (!onshapeSketch) {
      const ops = this.opsFor(sketchId);
      sketchOpId = ops.find((o) => this.frames.has(o)) ?? ops[0] ?? sketchId;
      onshapeSketch = this.onshapeIds.get(sketchOpId);
    }
    if (!onshapeSketch) throw new ExecutionError(opId, `sketch "${sketchId}" has not been built in this plan`);
    const irSketch = this.irById.get(sketchId) ?? this.ir.partStudio.features.find((f) => this.opsFor(f.id).includes(sketchOpId));
    if (!irSketch || irSketch.op !== "sketch") throw new ExecutionError(opId, `"${sketchId}" is not an IR sketch, so entity "${entityId}" has no geometry to match`);
    const entity = irSketch.entities.find((e) => e.id === entityId);
    if (!entity) throw new ExecutionError(opId, `sketch "${irSketch.id}" has no entity "${entityId}"`);

    const toModel = (p: readonly [number, number]) => applyPoint(irSketch.transform, [p[0], p[1], 0]);
    let probe;
    let entityType: EntityType;
    let wantType: string | undefined;
    switch (entity.type) {
      case "point":
        probe = toModel(entity.p);
        entityType = "vertex";
        break;
      case "line":
        probe = toModel([(entity.p0[0] + entity.p1[0]) / 2, (entity.p0[1] + entity.p1[1]) / 2]);
        entityType = "edge";
        wantType = "line";
        break;
      case "circle":
        probe = toModel(entity.center);
        entityType = "edge";
        wantType = "circle";
        break;
      case "arc": {
        // Arc midpoint: rotate p0 about the centre by half the sweep.
        const [cx, cy] = entity.center;
        const a0 = Math.atan2(entity.p0[1] - cy, entity.p0[0] - cx);
        let a1 = Math.atan2(entity.p1[1] - cy, entity.p1[0] - cx);
        if (entity.ccw && a1 <= a0) a1 += 2 * Math.PI;
        if (!entity.ccw && a1 >= a0) a1 -= 2 * Math.PI;
        const r = Math.hypot(entity.p0[0] - cx, entity.p0[1] - cy);
        const am = (a0 + a1) / 2;
        probe = toModel([cx + r * Math.cos(am), cy + r * Math.sin(am)]);
        entityType = "edge";
        wantType = "circle";
        break;
      }
      default:
        throw new ExecutionError(opId, `sketch entity type "${entity.type}" cannot be selected yet`);
    }
    if (expectEntity && expectEntity !== entityType) throw new ExecutionError(opId, `expected a ${expectEntity}, sketch entity "${entityId}" is a ${entityType}`);

    const candidates = (await this.query(onshapeSketch, entityType)).filter((c) => !wantType || c.type === wantType);
    const tol = (this.resolverOptions.tol ?? 1e-6) * 10;
    const scored = candidates
      .map((c) => {
        const p = entityType === "vertex" ? c.point : wantType === "circle" ? c.center : c.midpoint;
        return { candidate: c, d: p ? dist(p, probe) : Infinity };
      })
      .sort((a, b) => a.d - b.d);
    const best = scored[0];
    if (!best || best.d > tol) throw new ExecutionError(opId, `no ${entityType} of sketch ${irSketch.id} matches entity "${entityId}" (${candidates.length} candidates, nearest ${best ? best.d.toExponential(2) : "none"} m away)`);
    const second = scored[1];
    if (second && second.d <= tol) {
      throw new AmbiguousSelectionError(opId, sel, scored.filter((s) => s.d <= tol).map((s) => ({ candidate: s.candidate, score: 1 / (1 + (s.d / tol) ** 2), resolver: "probe" as const })));
    }
    return {
      query: idQuery([best.candidate.id]),
      record: { opId, parameterId, selection: sel, deterministicIds: [best.candidate.id], resolver: "probe" as const, confidence: 1 / (1 + (best.d / tol) ** 2), candidates: candidates.length },
      candidate: best.candidate,
    };
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

  private irRefAt(opId: string, irFeatureId: string, path: string): Ref | SketchEntityRef {
    const f = this.irById.get(irFeatureId);
    if (!f) throw new ExecutionError(opId, `unknown IR feature "${irFeatureId}"`);
    let node: unknown = f;
    for (const part of path.split(/\.|\[|\]/).filter(Boolean)) {
      if (node === null || typeof node !== "object") break;
      node = (node as Record<string, unknown>)[part];
    }
    if (!node || typeof node !== "object" || !("kind" in node)) throw new ExecutionError(opId, `"${irFeatureId}.${path}" is not an IR Ref`);
    return node as Ref | SketchEntityRef;
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
      p = queryTopology(this.api, this.ref, onshapeFeatureId, entity).then(dedupeCoincident);
      this.topology.set(key, p);
    }
    return p;
  }
}

/**
 * Onshape lists each sketch curve twice under qCreatedBy(sketch, EDGE): the
 * wire edge and the boundary edge of the region it closes, with identical
 * geometry (verified live). Two entities that coincide in type, position and
 * size are one selection as far as a reference is concerned; keep the first.
 */
export function dedupeCoincident(candidates: Candidate[], tol = 1e-9): Candidate[] {
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const anchor = c.midpoint ?? c.center ?? c.point ?? c.centroid ?? c.origin;
    const twin = kept.find((k) => {
      if (k.type !== c.type) return false;
      const ka = k.midpoint ?? k.center ?? k.point ?? k.centroid ?? k.origin;
      if (!anchor || !ka || dist(anchor, ka) > tol) return false;
      if ((k.length ?? 0) !== (c.length ?? 0) && Math.abs((k.length ?? 0) - (c.length ?? 0)) > tol) return false;
      if ((k.radius ?? 0) !== (c.radius ?? 0) && Math.abs((k.radius ?? 0) - (c.radius ?? 0)) > tol) return false;
      return true;
    });
    if (!twin) kept.push(c);
  }
  return kept;
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
    // A circle's "midpoint" is a point on its circumference (verified live), so a rim is
    // located by its centre; everything else by the point nearest its middle.
    const p = c.type === "circle" || c.type === "ellipse" ? (c.center ?? c.midpoint) : (c.midpoint ?? c.centroid ?? c.center ?? c.point ?? c.origin);
    if (!p || dist(p, w.near) > Math.max(tol * 1000, 1e-3)) return false;
  }
  return true;
}

const fmt = (v: readonly number[]): string => `(${v.map((x) => +x.toFixed(6)).join(", ")})`;
