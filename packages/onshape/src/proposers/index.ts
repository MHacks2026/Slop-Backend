import type { BooleanMode, EndCondition, ExtrudeFeature, Feature, FeatureOp, FilletFeature, Ref, SketchFeature } from "@slop/ir";
import { angleExpression, lengthExpression } from "../expression.ts";
import { applyDir, dot } from "../geometry.ts";
import type { StepContext } from "../plan/executor.ts";
import type { CreateFeatureOp, CreateSketchOp, Op, ParameterValue, Selection } from "../plan/types.ts";

/**
 * Direct-mapping proposers (architecture doc §6, "Mapping rules as data").
 *
 * These are the deterministic, pre-validated answers for common cases. They
 * are not the decision-maker: the rules planner uses them as its only move,
 * and the LLM planner sees them as a tool it may call, edit, or ignore. Each
 * returns plan ops with op ids equal to the IR feature id, so later refs
 * (`sketchRegion`, `createdBy`) line up with IR ids.
 */
export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

type Proposer<F extends Feature = Feature> = (f: F, ctx: StepContext, parameters: ReadonlyMap<string, import("@slop/ir").Parameter>) => Op[];

const PROPOSERS: { [K in FeatureOp]?: Proposer<Extract<Feature, { op: K }>> } = {
  sketch: proposeSketch,
  extrude: proposeExtrude,
  fillet: proposeFillet,
};

export const proposableOps = (): FeatureOp[] => Object.keys(PROPOSERS) as FeatureOp[];

export function proposeDirect(f: Feature, ctx: StepContext, parameters: ReadonlyMap<string, import("@slop/ir").Parameter>): Op[] {
  const p = PROPOSERS[f.op] as Proposer | undefined;
  if (!p) throw new ProposalError(`no direct-mapping proposer for op "${f.op}"`);
  return p(f, ctx, parameters);
}

// --- helpers -----------------------------------------------------------------

function selectionFor(irFeature: string, path: string, ref: Ref): Selection {
  if (ref.kind === "datum") {
    if (ref.name === "ORIGIN") return { kind: "origin" };
    return { kind: "datum", name: ref.name };
  }
  if (ref.kind === "feature-output" && ref.role === "region") return { kind: "sketchRegion", sketch: ref.feature };
  return { kind: "irRef", irFeature, path };
}

function proposeSketch(f: SketchFeature): Op[] {
  const external = [...f.constraints, ...f.dimensions].some((c) => c.args.some((a) => typeof a !== "string"));
  const op: CreateSketchOp = {
    op: "createSketch",
    id: f.id,
    name: f.src.name,
    intent: `Reproduce ${f.src.name}: ${f.entities.length} entities, ${f.constraints.length} relations, ${f.dimensions.length} dimensions, on ${describePlane(f.plane)}`,
    rung: external ? "approximated" : "exact",
    plane: selectionFor(f.id, "plane", f.plane),
    irSketch: f.id,
    entities: f.entities,
    constraints: f.constraints,
    dimensions: f.dimensions,
  };
  return [op];
}

const OPERATION: Record<BooleanMode, string> = { new: "NEW", add: "ADD", remove: "REMOVE", intersect: "INTERSECT" };

function proposeExtrude(f: ExtrudeFeature, ctx: StepContext, parameters: ReadonlyMap<string, import("@slop/ir").Parameter>): Op[] {
  if (f.profile.kind !== "feature-output" || f.profile.role !== "region") throw new ProposalError("extrude profile must be a sketch region");
  if ((f.profile.index ?? 0) !== 0) throw new ProposalError("sketch region by index > 0 is not supported by the direct proposer");

  const params: ParameterValue[] = [
    { id: "bodyType", enum: { name: "ToolBodyType", value: "SOLID" } },
    { id: "operationType", enum: { name: "NewBodyOperationType", value: OPERATION[f.mode] } },
    { id: "entities", selections: [{ kind: "sketchRegion", sketch: f.profile.feature }] },
    ...endParams(f.id, "end", f.end, "endBound", "depth", "endBoundEntityFace", "endBoundEntityVertex", parameters),
    { id: "oppositeDirection", boolean: f.flip !== normalFlipped(f, ctx) },
  ];
  if (f.end2) {
    params.push({ id: "hasSecondDirection", boolean: true });
    params.push(...endParams(f.id, "end2", f.end2, "secondDirectionBound", "secondDirectionDepth", "secondDirectionBoundEntityFace", "secondDirectionBoundEntityVertex", parameters));
  }
  if (f.draft) {
    params.push({ id: "hasDraft", boolean: true }, { id: "draftAngle", quantity: angleExpression(f.draft.angle, parameters) }, { id: "draftPullDirection", boolean: f.draft.outward });
  }

  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `${f.mode === "remove" ? "Cut" : "Extrude"} the region of ${f.profile.feature} ${describeEnd(f.end)}`,
    rung: "exact",
    featureType: "extrude",
    parameters: params,
  };
  return [op];
}

/**
 * IR `flip` is relative to the IR sketch normal; Onshape extrudes along its
 * own plane normal, which may point the other way for the same plane. The
 * proposer uses IR ids as op ids, so the sketch's Onshape frame is looked up
 * directly. If the frame is unknown the flag is left as-is and the
 * measurement loop will catch a wrong direction.
 */
function normalFlipped(f: ExtrudeFeature, ctx: StepContext): boolean {
  if (f.profile.kind !== "feature-output") return false;
  const sketchId = f.profile.feature;
  const frame = ctx.sketchFrame(sketchId);
  const sketch = ctx.ir.partStudio.features.find((x) => x.id === sketchId);
  if (!frame || !sketch || sketch.op !== "sketch") return false;
  return dot(applyDir(sketch.transform, [0, 0, 1]), frame.normal) < 0;
}

function endParams(
  irFeature: string,
  path: string,
  end: EndCondition,
  boundId: string,
  depthId: string,
  faceId: string,
  vertexId: string,
  parameters: ReadonlyMap<string, import("@slop/ir").Parameter>,
): ParameterValue[] {
  switch (end.type) {
    case "blind":
      return [{ id: boundId, enum: { name: "BoundingType", value: "BLIND" } }, { id: depthId, quantity: lengthExpression(end.depth, parameters) }];
    case "throughAll":
      return [{ id: boundId, enum: { name: "BoundingType", value: "THROUGH_ALL" } }];
    case "upToNext":
      return [{ id: boundId, enum: { name: "BoundingType", value: "UP_TO_NEXT" } }];
    case "midPlane":
      return [{ id: boundId, enum: { name: "BoundingType", value: "SYMMETRIC" } }, { id: depthId, quantity: lengthExpression(end.depth, parameters) }];
    case "upToSurface":
      return [{ id: boundId, enum: { name: "BoundingType", value: "UP_TO_SURFACE" } }, { id: faceId, selections: [{ kind: "irRef", irFeature, path: `${path}.face` }] }];
    case "upToVertex":
      return [{ id: boundId, enum: { name: "BoundingType", value: "UP_TO_VERTEX" } }, { id: vertexId, selections: [{ kind: "irRef", irFeature, path: `${path}.vertex` }] }];
    case "offsetFromSurface":
      throw new ProposalError("offset-from-surface end condition has no direct proposer");
  }
}

function proposeFillet(f: FilletFeature, _ctx: StepContext, parameters: ReadonlyMap<string, import("@slop/ir").Parameter>): Op[] {
  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `Fillet ${f.edges.length} edge(s) at ${f.radius.expr}${f.edges[0]?.kind === "topo" && f.edges[0].role ? ` (${f.edges[0].role})` : ""}`,
    rung: "exact",
    featureType: "fillet",
    parameters: [
      { id: "entities", selections: f.edges.map((_, i) => ({ kind: "irRef", irFeature: f.id, path: `edges[${i}]` }) as Selection) },
      { id: "radius", quantity: lengthExpression(f.radius, parameters) },
      { id: "tangentPropagation", boolean: f.tangentPropagation },
    ],
  };
  return [op];
}

function describePlane(ref: Ref): string {
  if (ref.kind === "datum") return `the ${ref.name} plane`;
  if (ref.kind === "feature-output") return `the ${ref.role} of ${ref.feature}`;
  return `a ${ref.entity} created by ${ref.createdBy ?? "?"}${ref.role ? ` (${ref.role})` : ""}`;
}

function describeEnd(end: EndCondition): string {
  switch (end.type) {
    case "blind":
      return `${end.depth.expr} blind`;
    case "throughAll":
      return "through all";
    case "upToNext":
      return "up to next";
    case "midPlane":
      return `${end.depth.expr} mid-plane`;
    case "upToSurface":
      return "up to a face";
    case "upToVertex":
      return "up to a vertex";
    case "offsetFromSurface":
      return `offset ${end.offset.expr} from a face`;
  }
}
