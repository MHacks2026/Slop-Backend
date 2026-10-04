/**
 * Direct-mapping proposers for the rest of the MVP feature set (architecture
 * doc §14): revolve, chamfer, shell, reference plane, mirror, linear and
 * circular pattern, and hole as a composite.
 *
 * Onshape parameter ids and enum values below come from the documented
 * feature types and from feature-list readbacks of UI-built features where
 * those existed (extrude, fillet). Everything else is marked UNVERIFIED and
 * must be confirmed with `cli readback` of a UI-built feature of that type
 * before it is trusted. The per-feature measurement loop catches a wrong
 * direction or enum; it cannot catch a wrong parameter id, which Onshape
 * reports as a regeneration error.
 */
import type {
  ChamferFeature,
  CircularPatternFeature,
  EndCondition,
  HoleFeature,
  LinearPatternFeature,
  MirrorFeature,
  Parameter,
  PlaneFeature,
  Quantity,
  Ref,
  RevolveFeature,
  ShellFeature,
  Vec3,
} from "@slop/ir";
import type { Constraint, Dimension, SketchEntity } from "@slop/ir";
import { angleExpression, countExpression, lengthExpression } from "../expression.ts";
import { cross, normalize, scale, sub } from "../geometry.ts";
import type { SketchEntityRef, StepContext } from "../plan/executor.ts";
import type { CreateFeatureOp, CreateSketchOp, Op, ParameterValue, Selection } from "../plan/types.ts";
import { ProposalError } from "./errors.ts";

type Params = ReadonlyMap<string, Parameter>;

const OPERATION = { new: "NEW", add: "ADD", remove: "REMOVE", intersect: "INTERSECT" } as const;
const FULL_TURN = 2 * Math.PI;

/** Selection for an IR Ref or sketch-entity ref that lives at `path` of `irFeature`. */
export function selectionFor(irFeature: string, path: string, ref: Ref | SketchEntityRef): Selection {
  if (ref.kind === "datum") {
    if (ref.name === "ORIGIN") return { kind: "origin" };
    return { kind: "datum", name: ref.name };
  }
  if (ref.kind === "sketch-entity") return { kind: "sketchEntity", sketch: ref.sketch, entity: ref.entity };
  if (ref.kind === "feature-output" && ref.role === "region") return { kind: "sketchRegion", sketch: ref.feature };
  return { kind: "irRef", irFeature, path };
}

// --- revolve -----------------------------------------------------------------

/** UNVERIFIED: RevolveType enum values and `axis` parameter id. */
export function proposeRevolve(f: RevolveFeature, _ctx: StepContext, parameters: Params): Op[] {
  if (f.profile.kind !== "feature-output" || f.profile.role !== "region") throw new ProposalError("revolve profile must be a sketch region");
  const full = Math.abs(f.angle.value - FULL_TURN) < 1e-9;
  const params: ParameterValue[] = [
    { id: "bodyType", enum: { name: "ExtendedToolBodyType", value: "SOLID" } },
    { id: "operationType", enum: { name: "NewBodyOperationType", value: OPERATION[f.mode] } },
    { id: "entities", selections: [{ kind: "sketchRegion", sketch: f.profile.feature }] },
    { id: "axis", selections: [selectionFor(f.id, "axis", f.axis)] },
    { id: "revolveType", enum: { name: "RevolveType", value: full ? "FULL" : "ONE_DIRECTION" } },
  ];
  if (!full) params.push({ id: "angle", quantity: angleExpression(f.angle, parameters) });
  params.push({ id: "oppositeDirection", boolean: f.flip });
  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `${f.mode === "remove" ? "Revolve-cut" : "Revolve"} the region of ${f.profile.feature} ${full ? "a full turn" : `through ${f.angle.expr}`} about ${describeAxis(f.axis)}`,
    rung: "exact",
    featureType: "revolve",
    parameters: params,
  };
  return [op];
}

// --- chamfer -----------------------------------------------------------------

/** UNVERIFIED: ChamferType enum values and width/angle parameter ids. */
export function proposeChamfer(f: ChamferFeature, _ctx: StepContext, parameters: Params): Op[] {
  const params: ParameterValue[] = [{ id: "entities", selections: f.edges.map((_, i) => ({ kind: "irRef", irFeature: f.id, path: `edges[${i}]` }) as Selection) }];
  let describe: string;
  switch (f.spec.type) {
    case "equalDistance":
      params.push({ id: "chamferType", enum: { name: "ChamferType", value: "EQUAL_OFFSETS" } }, { id: "width", quantity: lengthExpression(f.spec.distance, parameters) });
      describe = f.spec.distance.expr;
      break;
    case "twoDistances":
      params.push(
        { id: "chamferType", enum: { name: "ChamferType", value: "TWO_OFFSETS" } },
        { id: "width1", quantity: lengthExpression(f.spec.distance1, parameters) },
        { id: "width2", quantity: lengthExpression(f.spec.distance2, parameters) },
        { id: "oppositeDirection", boolean: f.spec.flip },
      );
      describe = `${f.spec.distance1.expr} x ${f.spec.distance2.expr}`;
      break;
    case "distanceAngle":
      params.push(
        { id: "chamferType", enum: { name: "ChamferType", value: "OFFSET_ANGLE" } },
        { id: "width", quantity: lengthExpression(f.spec.distance, parameters) },
        { id: "angle", quantity: angleExpression(f.spec.angle, parameters) },
        { id: "oppositeDirection", boolean: f.spec.flip },
      );
      describe = `${f.spec.distance.expr} at ${f.spec.angle.expr}`;
      break;
  }
  params.push({ id: "tangentPropagation", boolean: f.tangentPropagation });
  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `Chamfer ${f.edges.length} edge(s), ${describe}`,
    rung: "exact",
    featureType: "chamfer",
    parameters: params,
  };
  return [op];
}

// --- shell -------------------------------------------------------------------

/** UNVERIFIED: `oppositeDirection` meaning outward for shell. */
export function proposeShell(f: ShellFeature, _ctx: StepContext, parameters: Params): Op[] {
  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `Shell to ${f.thickness.expr} ${f.outward ? "outward" : "inward"}, removing ${f.removeFaces.length} face(s)`,
    rung: "exact",
    featureType: "shell",
    parameters: [
      { id: "entities", selections: f.removeFaces.map((_, i) => ({ kind: "irRef", irFeature: f.id, path: `removeFaces[${i}]` }) as Selection) },
      { id: "thickness", quantity: lengthExpression(f.thickness, parameters) },
      { id: "oppositeDirection", boolean: f.outward },
    ],
  };
  return [op];
}

// --- reference plane -----------------------------------------------------------

/** UNVERIFIED: CPlaneType enum values and that `entities` takes [base] / [a, b] / [base, axis]. */
export function proposePlane(f: PlaneFeature, _ctx: StepContext, parameters: Params): Op[] {
  const d = f.definition;
  const params: ParameterValue[] = [];
  let intent: string;
  switch (d.type) {
    case "offset":
      params.push(
        { id: "cplaneType", enum: { name: "CPlaneType", value: "OFFSET" } },
        { id: "entities", selections: [selectionFor(f.id, "definition.base", d.base)] },
        { id: "offset", quantity: lengthExpression(d.distance, parameters) },
        { id: "oppositeDirection", boolean: d.flip },
      );
      intent = `Plane offset ${d.distance.expr} from ${describeRef(d.base)}`;
      break;
    case "midPlane":
      params.push(
        { id: "cplaneType", enum: { name: "CPlaneType", value: "MID_PLANE" } },
        { id: "entities", selections: [selectionFor(f.id, "definition.a", d.a), selectionFor(f.id, "definition.b", d.b)] },
      );
      intent = `Plane midway between ${describeRef(d.a)} and ${describeRef(d.b)}`;
      break;
    case "angle":
      params.push(
        { id: "cplaneType", enum: { name: "CPlaneType", value: "LINE_ANGLE" } },
        { id: "entities", selections: [selectionFor(f.id, "definition.base", d.base), selectionFor(f.id, "definition.axis", d.axis)] },
        { id: "angle", quantity: angleExpression(d.angle, parameters) },
        { id: "oppositeDirection", boolean: d.flip },
      );
      intent = `Plane at ${d.angle.expr} to ${describeRef(d.base)} about ${describeRef(d.axis)}`;
      break;
  }
  const op: CreateFeatureOp = { op: "createFeature", id: f.id, name: f.src.name, intent, rung: "exact", featureType: "cPlane", parameters: params };
  return [op];
}

// --- mirror and patterns ---------------------------------------------------------

/** UNVERIFIED: `instanceFunction` as the seed parameter and `mirrorPlane` id. */
export function proposeMirror(f: MirrorFeature): Op[] {
  if (f.seeds.length === 0) throw new ProposalError("mirror has no seed features");
  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `Mirror ${f.seeds.join(", ")} about ${describeRef(f.plane)}`,
    rung: "exact",
    featureType: "mirror",
    parameters: [
      { id: "patternType", enum: { name: "MirrorType", value: "FEATURE" } },
      { id: "instanceFunction", selections: [{ kind: "features", features: f.seeds }] },
      { id: "mirrorPlane", selections: [selectionFor(f.id, "plane", f.plane)] },
    ],
  };
  return [op];
}

/** UNVERIFIED: direction/distance/count parameter ids. Skipped instances have no direct mapping. */
export function proposeLinearPattern(f: LinearPatternFeature, _ctx: StepContext, parameters: Params): Op[] {
  if (f.seeds.length === 0) throw new ProposalError("linear pattern has no seed features");
  if (f.skipped?.length) throw new ProposalError("linear pattern with skipped instances has no direct proposer");
  const params: ParameterValue[] = [
    { id: "patternType", enum: { name: "PatternType", value: "FEATURE" } },
    { id: "instanceFunction", selections: [{ kind: "features", features: f.seeds }] },
    { id: "directionOne", selections: [selectionFor(f.id, "direction1.direction", f.direction1.direction)] },
    { id: "distance", quantity: lengthExpression(f.direction1.spacing, parameters) },
    { id: "instanceCount", quantity: countExpression(f.direction1.count, parameters) },
    { id: "oppositeDirectionOne", boolean: f.direction1.flip },
  ];
  if (f.direction2) {
    params.push(
      { id: "hasSecondDir", boolean: true },
      { id: "directionTwo", selections: [selectionFor(f.id, "direction2.direction", f.direction2.direction)] },
      { id: "distanceTwo", quantity: lengthExpression(f.direction2.spacing, parameters) },
      { id: "instanceCountTwo", quantity: countExpression(f.direction2.count, parameters) },
      { id: "oppositeDirectionTwo", boolean: f.direction2.flip },
    );
  }
  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `Pattern ${f.seeds.join(", ")}: ${f.direction1.count.expr} x ${f.direction1.spacing.expr}${f.direction2 ? ` by ${f.direction2.count.expr} x ${f.direction2.spacing.expr}` : ""}`,
    rung: "exact",
    featureType: "linearPattern",
    parameters: params,
  };
  return [op];
}

/** UNVERIFIED: `equalSpace` id. Skipped instances have no direct mapping. */
export function proposeCircularPattern(f: CircularPatternFeature, _ctx: StepContext, parameters: Params): Op[] {
  if (f.seeds.length === 0) throw new ProposalError("circular pattern has no seed features");
  if (f.skipped?.length) throw new ProposalError("circular pattern with skipped instances has no direct proposer");
  const op: CreateFeatureOp = {
    op: "createFeature",
    id: f.id,
    name: f.src.name,
    intent: `Pattern ${f.seeds.join(", ")} ${f.count.expr} times ${f.equalSpacing ? "equally over" : "every"} ${f.angle.expr} about ${describeRef(f.axis)}`,
    rung: "exact",
    featureType: "circularPattern",
    parameters: [
      { id: "patternType", enum: { name: "PatternType", value: "FEATURE" } },
      { id: "instanceFunction", selections: [{ kind: "features", features: f.seeds }] },
      { id: "axis", selections: [selectionFor(f.id, "axis", f.axis)] },
      { id: "angle", quantity: angleExpression(f.angle, parameters) },
      { id: "instanceCount", quantity: countExpression(f.count, parameters) },
      { id: "equalSpace", boolean: f.equalSpacing },
      { id: "oppositeDirection", boolean: f.flip },
    ],
  };
  return [op];
}

// --- hole (composite) ------------------------------------------------------------

/**
 * Hole Wizard as a composite (rung 2): a sketch on the start face holding one
 * circle per position, dimensioned to the hole diameter, plus a cut extrude
 * with the hole's end condition; a counterbore adds a second sketch and a
 * blind cut. Onshape's native hole feature has a large, undocumented
 * parameter set tied to its hole tables; the composite keeps every dimension
 * parametric and is built from mechanisms already verified live.
 *
 * Each circle centre is placed at the position's recorded point and tied to
 * it with a coincident constraint, so the hole follows the vertex it was
 * placed on. Positions without recorded geometry cannot be placed.
 */
export function proposeHole(f: HoleFeature, _ctx: StepContext, parameters: Params): Op[] {
  if (f.style === "countersink") throw new ProposalError("countersink holes have no direct proposer yet");
  if (f.positions.length === 0) throw new ProposalError("hole has no positions");
  const face = planeOf(f.startFace);
  if (!face) throw new ProposalError("hole start face has no plane signature (normal + offset or centroid), so the helper sketch cannot be oriented");
  const frame = frameOn(face.normal, face.point);
  const toSketch = (p: Vec3): [number, number] => {
    const d = sub(p, frame.origin);
    return [dotv(d, frame.x), dotv(d, frame.y)];
  };

  const centres = f.positions.map((ref, i) => {
    const point = pointOf(ref);
    if (!point) throw new ProposalError(`hole position ${i} has no recorded point (signature.point or probe)`);
    return { ref, index: i, local: toSketch(point) };
  });

  const ops: Op[] = [];
  const holeSketch = `${f.id}.sketch`;
  ops.push(
    circlesSketch(holeSketch, `${f.src.name} positions`, f, frame.transform, centres, f.diameter, parameters, `${f.positions.length} hole centre(s) tied to their positions, dimensioned Ø${f.diameter.expr}`),
    cut(f.id, f.src.name, holeSketch, f.end, f, parameters, `Cut the Ø${f.diameter.expr} hole(s) ${describeEnd(f.end)}`),
  );
  if (f.style === "counterbore" && f.counterbore) {
    const cboreSketch = `${f.id}.cbore.sketch`;
    ops.push(
      circlesSketch(cboreSketch, `${f.src.name} counterbore`, f, frame.transform, centres, f.counterbore.diameter, parameters, `Counterbore circles Ø${f.counterbore.diameter.expr} on the same centres`),
      cut(`${f.id}.cbore`, `${f.src.name} counterbore`, cboreSketch, { type: "blind", depth: f.counterbore.depth }, f, parameters, `Counterbore ${f.counterbore.depth.expr} deep`),
    );
  }
  return ops;
}

function circlesSketch(
  id: string,
  name: string,
  f: HoleFeature,
  transform: number[],
  centres: Array<{ ref: Ref; index: number; local: [number, number] }>,
  diameter: Quantity,
  _parameters: Params,
  intent: string,
): CreateSketchOp {
  const entities: SketchEntity[] = [];
  const constraints: Constraint[] = [];
  const dimensions: Dimension[] = [];
  // Dimension ids must satisfy the IR id pattern (no spaces); the sketch's display name may not.
  const dimOwner = name.replace(/[^A-Za-z0-9_@.:-]/g, "_");
  centres.forEach((c, k) => {
    const cid = `c${k}`;
    entities.push({ id: cid, type: "circle", construction: false, center: c.local, r: diameter.value / 2 });
    // Live tie to the position vertex; the executor resolves the Ref (step 1 mechanism).
    constraints.push({ type: "coincident", args: [`${cid}.center`, c.ref] });
    if (k === 0) dimensions.push({ id: `D1@${dimOwner}`, type: "diameter", args: [cid], value: diameter, driving: true });
    else constraints.push({ type: "equal", args: [cid, "c0"] });
  });
  return {
    op: "createSketch",
    id,
    name,
    intent,
    rung: "composite",
    plane: { kind: "irRef", irFeature: f.id, path: "startFace" },
    transform,
    entities,
    constraints,
    dimensions,
  };
}

function cut(id: string, name: string, sketch: string, end: EndCondition, f: HoleFeature, parameters: Params, intent: string): CreateFeatureOp {
  const params: ParameterValue[] = [
    { id: "bodyType", enum: { name: "ExtendedToolBodyType", value: "SOLID" } },
    { id: "operationType", enum: { name: "NewBodyOperationType", value: "REMOVE" } },
    { id: "entities", selections: [{ kind: "sketchRegion", sketch }] },
  ];
  switch (end.type) {
    case "blind":
      params.push({ id: "endBound", enum: { name: "BoundingType", value: "BLIND" } }, { id: "depth", quantity: lengthExpression(end.depth, parameters) });
      break;
    case "throughAll":
      params.push({ id: "endBound", enum: { name: "BoundingType", value: "THROUGH_ALL" } });
      break;
    case "upToNext":
      params.push({ id: "endBound", enum: { name: "BoundingType", value: "UP_TO_NEXT" } });
      break;
    case "upToSurface":
      params.push({ id: "endBound", enum: { name: "BoundingType", value: "UP_TO_SURFACE" } }, { id: "endBoundEntityFace", selections: [{ kind: "irRef", irFeature: f.id, path: "end.face" }] });
      break;
    case "upToVertex":
      params.push({ id: "endBound", enum: { name: "BoundingType", value: "UP_TO_VERTEX" } }, { id: "endBoundEntityVertex", selections: [{ kind: "irRef", irFeature: f.id, path: "end.vertex" }] });
      break;
    default:
      throw new ProposalError(`hole end condition "${end.type}" has no direct proposer`);
  }
  // A hole starts on its face and goes into the material, i.e. against the face normal the sketch sits on.
  params.push({ id: "oppositeDirection", boolean: true });
  return { op: "createFeature", id, name, intent, rung: "composite", featureType: "extrude", parameters: params };
}

/** Plane of a start face from its IR signature: unit normal plus a point on the plane. */
function planeOf(ref: Ref): { normal: Vec3; point: Vec3 } | undefined {
  if (ref.kind !== "topo" || ref.entity !== "face" || !ref.signature || !("surface" in ref.signature)) return undefined;
  const s = ref.signature;
  if (s.surface !== "plane" || !s.normal) return undefined;
  const n = normalize(s.normal);
  if (s.centroid) return { normal: n, point: s.centroid };
  if (s.offset !== undefined) return { normal: n, point: scale(n, s.offset) };
  if (ref.probe) return { normal: n, point: ref.probe };
  return undefined;
}

function pointOf(ref: Ref): Vec3 | undefined {
  if (ref.kind === "topo") {
    if (ref.signature && "point" in ref.signature) return ref.signature.point;
    return ref.probe;
  }
  return undefined;
}

/**
 * A sketch frame on a plane: origin at the world origin projected onto the
 * plane (Onshape's convention), x along the least-aligned world axis. The
 * composer re-projects through Onshape's real frame, so only the plane
 * itself has to be right.
 */
function frameOn(normal: Vec3, point: Vec3): { origin: Vec3; x: Vec3; y: Vec3; transform: number[] } {
  const n = normalize(normal);
  const origin = scale(n, dotv(point, n));
  const seed: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize(sub(seed, scale(n, dotv(seed, n))));
  const y = cross(n, x);
  const transform = [x[0], y[0], n[0], origin[0], x[1], y[1], n[1], origin[1], x[2], y[2], n[2], origin[2], 0, 0, 0, 1];
  return { origin, x, y, transform };
}

const dotv = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// --- descriptions ----------------------------------------------------------------

function describeRef(ref: Ref | SketchEntityRef): string {
  if (ref.kind === "datum") return `the ${ref.name} plane`;
  if (ref.kind === "sketch-entity") return `${ref.entity} of ${ref.sketch}`;
  if (ref.kind === "feature-output") return `the ${ref.role} of ${ref.feature}`;
  return `a ${ref.entity} created by ${ref.createdBy ?? "?"}${ref.role ? ` (${ref.role})` : ""}`;
}

function describeAxis(axis: Ref | SketchEntityRef): string {
  return describeRef(axis);
}

function describeEnd(end: EndCondition): string {
  switch (end.type) {
    case "blind":
      return `${end.depth.expr} deep`;
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
