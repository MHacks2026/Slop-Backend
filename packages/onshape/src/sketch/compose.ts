import type { Constraint, ConstraintType, Dimension, DimensionType, Mat4, Parameter, Rung, SketchArg, SketchEntity, Vec2 } from "@slop/ir";
import type { BTParameter, BTSketchConstraint, BTSketchEntity, BTMSketch } from "../client/types.ts";
import { applyDir, applyPoint, dot, normalize, planeDistance, planeY, toPlaneCoords, type PlaneFrame } from "../geometry.ts";
import { angleExpression, idQuery, lengthExpression, quantity, queryList } from "../expression.ts";

export class SketchComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SketchComposeError";
  }
}

export interface ComposeSketchInput {
  name: string;
  /** Deterministic ids of the Onshape plane or face. */
  planeIds: string[];
  /** Onshape's frame for that plane (queried, never assumed). */
  frame: PlaneFrame;
  /**
   * Sketch-to-model transform of the frame the 2D coordinates are in. When
   * absent, coordinates are already in Onshape's plane frame.
   */
  sourceTransform?: Mat4;
  entities: SketchEntity[];
  constraints: Constraint[];
  dimensions: Dimension[];
  /** Deterministic id of the origin vertex, needed when any arg is "ORIGIN". */
  originId?: string;
  parameters?: ReadonlyMap<string, Parameter>;
  /** Prefix for constraint entity ids. */
  idPrefix: string;
}

export interface ComposedSketch {
  feature: BTMSketch;
  rung: Rung;
  notes: string[];
  /** Args that referenced model geometry and could not be expressed (unresolved Ref objects). */
  skipped: Array<{ kind: "constraint" | "dimension"; id: string }>;
}

/**
 * Prefix of a sketch argument that names Onshape model geometry by
 * deterministic id: "ext:JHK" or "ext:JHK,JHL". The executor resolves IR
 * Refs to this form before composing, so a dimension to a model edge becomes
 * a live external reference in the sketch, exactly like the ORIGIN vertex.
 */
export const EXTERNAL_ARG_PREFIX = "ext:";

export const externalArg = (ids: string[]): string => `${EXTERNAL_ARG_PREFIX}${ids.join(",")}`;

/** Deterministic ids named by an "ext:" argument, or undefined for any other arg. */
export function parseExternalArg(arg: SketchArg): string[] | undefined {
  if (typeof arg !== "string" || !arg.startsWith(EXTERNAL_ARG_PREFIX)) return undefined;
  const ids = arg.slice(EXTERNAL_ARG_PREFIX.length).split(",").filter(Boolean);
  if (ids.length === 0) throw new SketchComposeError(`external argument "${arg}" names no entity`);
  return ids;
}

/**
 * Pure composition of an Onshape sketch.
 *
 * Coordinates: when `sourceTransform` is given, each 2D point is mapped
 *   source (u,v) -> model (x,y,z) -> Onshape (u',v') via `frame`,
 * so orientation is computed, not assumed (open question 2). A 90 degree
 * difference between the frames swaps horizontal and vertical constraints;
 * any other rotation is rejected.
 *
 * Model geometry: an arg of the form "ext:<id>" (see `externalArg`) becomes
 * an `external<Slot>` query, the same mechanism as ORIGIN, which built live.
 * A raw IR Ref object reaching this function means the caller did not
 * resolve it; it is skipped and the sketch is downgraded, never guessed.
 *
 * UNVERIFIED JSON (confirm with `cli readback` of a UI-built sketch): line
 * segments, sketch points, constraint type names and parameter ids,
 * dimension parameter ids. External references to the origin are verified
 * live; external references to model edges use the identical shape.
 */
export function composeSketch(input: ComposeSketchInput): ComposedSketch {
  const notes: string[] = [];
  const skipped: ComposedSketch["skipped"] = [];
  let rung: Rung = "exact";

  const toLocal = input.sourceTransform ? projector(input.sourceTransform, input.frame, input.name) : (p: Vec2) => p;
  const swapHV = input.sourceTransform ? axisSwap(input.sourceTransform, input.frame, input.name) : false;
  const mirrored = input.sourceTransform ? orientationReversed(input.sourceTransform, input.frame) : false;

  const entities: BTSketchEntity[] = [];
  const ids = new Set<string>();
  for (const e of input.entities) {
    if (ids.has(e.id)) throw new SketchComposeError(`duplicate sketch entity id "${e.id}"`);
    ids.add(e.id);
    entities.push(...mapEntity(e, toLocal, mirrored));
  }

  const constraints: BTSketchConstraint[] = [];
  input.constraints.forEach((c, i) => {
    const params = argParams(c.args, ids, input.originId);
    if (!params) {
      notes.push(`constraint ${c.type} #${i} references model geometry that was not resolved; skipped`);
      skipped.push({ kind: "constraint", id: `#${i}` });
      rung = lower(rung, "approximated");
      return;
    }
    constraints.push({
      btType: "BTMSketchConstraint-2",
      constraintType: swapType(CONSTRAINT_TYPES[c.type], swapHV),
      entityId: `${safeId(input.idPrefix)}.k${i}`,
      parameters: params,
    });
  });

  for (const d of input.dimensions) {
    const params = argParams(d.args, ids, input.originId);
    if (!params) {
      notes.push(`dimension ${d.id} references model geometry that was not resolved; placed at fixed coordinates instead`);
      skipped.push({ kind: "dimension", id: d.id });
      rung = lower(rung, "approximated");
      continue;
    }
    if (!d.driving) notes.push(`dimension ${d.id} is driven in the source; written as driving`);
    const type = dimensionType(d.type, d.args.length);
    const valueParam = type === "ANGLE" ? quantity("angle", angleExpression(d.value, input.parameters)) : quantity("length", lengthExpression(d.value, input.parameters));
    const extra: BTParameter[] = [];
    if (d.type === "horizontal" || d.type === "vertical") {
      const dir = swapHV === (d.type === "horizontal") ? "VERTICAL" : "HORIZONTAL";
      extra.push({ btType: "BTMParameterEnum-145", parameterId: "direction", enumName: "DimensionDirection", value: dir });
    }
    constraints.push({ btType: "BTMSketchConstraint-2", constraintType: type, entityId: safeId(`${input.idPrefix}.${d.id}`), parameters: [...params, valueParam, ...extra] });
  }

  const feature: BTMSketch = {
    btType: "BTMSketch-151",
    featureType: "newSketch",
    name: input.name,
    parameters: [queryList("sketchPlane", [idQuery(input.planeIds)])],
    entities,
    constraints,
  };
  return { feature, rung, notes, skipped };
}

// --- frames ------------------------------------------------------------------

function projector(transform: Mat4, frame: PlaneFrame, name: string): (p: Vec2) => Vec2 {
  return (p) => {
    const model = applyPoint(transform, [p[0], p[1], 0]);
    const off = Math.abs(planeDistance(frame, model));
    if (off > 1e-6) throw new SketchComposeError(`sketch ${name}: entities are ${off.toExponential(2)} m off the Onshape plane; frame mismatch`);
    return toPlaneCoords(frame, model);
  };
}

/**
 * True when mapping source (u, v) to Onshape (u', v') flips handedness, i.e.
 * the source sketch normal points against the Onshape plane normal. Arcs then
 * sweep the other way in local coordinates.
 */
function orientationReversed(transform: Mat4, frame: PlaneFrame): boolean {
  return dot(normalize(applyDir(transform, [0, 0, 1])), normalize(frame.normal)) < 0;
}

/** True when the source sketch x axis is the Onshape frame's y axis (90 degree rotation). */
function axisSwap(transform: Mat4, frame: PlaneFrame, name: string): boolean {
  const srcX = normalize(applyDir(transform, [1, 0, 0]));
  const alongX = Math.abs(dot(srcX, normalize(frame.x)));
  const alongY = Math.abs(dot(srcX, normalize(planeY(frame))));
  if (alongX > 1 - 1e-9) return false;
  if (alongY > 1 - 1e-9) return true;
  const deg = (Math.acos(Math.min(1, alongX)) * 180) / Math.PI;
  throw new SketchComposeError(`sketch ${name}: Onshape frame rotated ${deg.toFixed(2)} deg from source; horizontal/vertical would not map`);
}

// --- entities ----------------------------------------------------------------

function mapEntity(e: SketchEntity, toLocal: (p: Vec2) => Vec2, mirrored: boolean): BTSketchEntity[] {
  const common = { entityId: e.id, ...(e.construction ? { isConstruction: true } : {}) };
  switch (e.type) {
    case "arc": {
      // Written as a counter-clockwise circle segment from startParam to endParam
      // (radians). A clockwise source arc is emitted from p1 to p0 instead, with
      // the point ids swapped so "a.start" still names the source's start point.
      // UNVERIFIED JSON: BTMSketchCurveSegment-155 over BTCurveGeometryCircle-115 with angular params.
      const [cx, cy] = toLocal(e.center);
      const [x0, y0] = toLocal(e.p0);
      const [x1, y1] = toLocal(e.p1);
      const r0 = Math.hypot(x0 - cx, y0 - cy);
      const r1 = Math.hypot(x1 - cx, y1 - cy);
      if (r0 === 0 || Math.abs(r0 - r1) > 1e-9) throw new SketchComposeError(`arc ${e.id}: end points are not equidistant from the centre`);
      const ccw = e.ccw !== mirrored;
      const [sx, sy, ex, ey] = ccw ? [x0, y0, x1, y1] : [x1, y1, x0, y0];
      const start = Math.atan2(sy - cy, sx - cx);
      let end = Math.atan2(ey - cy, ex - cx);
      if (end <= start) end += 2 * Math.PI;
      return [
        {
          btType: "BTMSketchCurveSegment-155",
          ...common,
          geometry: { btType: "BTCurveGeometryCircle-115", radius: r0, xCenter: cx, yCenter: cy, xDir: 1, yDir: 0, clockwise: false },
          startParam: start,
          endParam: end,
          startPointId: ccw ? `${e.id}.start` : `${e.id}.end`,
          endPointId: ccw ? `${e.id}.end` : `${e.id}.start`,
          centerId: `${e.id}.center`,
        },
      ];
    }
    case "point": {
      const [x, y] = toLocal(e.p);
      return [{ btType: "BTMSketchPoint-158", ...common, x, y }];
    }
    case "line": {
      const [x0, y0] = toLocal(e.p0);
      const [x1, y1] = toLocal(e.p1);
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len === 0) throw new SketchComposeError(`line ${e.id} has zero length`);
      return [
        {
          btType: "BTMSketchCurveSegment-155",
          ...common,
          geometry: { btType: "BTCurveGeometryLine-117", pntX: x0, pntY: y0, dirX: (x1 - x0) / len, dirY: (y1 - y0) / len },
          startParam: 0,
          endParam: len,
          startPointId: `${e.id}.start`,
          endPointId: `${e.id}.end`,
        },
      ];
    }
    case "circle": {
      const [xc, yc] = toLocal(e.center);
      return [
        {
          btType: "BTMSketchCurve-4",
          ...common,
          geometry: { btType: "BTCurveGeometryCircle-115", radius: e.r, xCenter: xc, yCenter: yc, xDir: 1, yDir: 0, clockwise: false },
          centerId: `${e.id}.center`,
        },
      ];
    }
    case "ellipse":
    case "spline":
      throw new SketchComposeError(`sketch entity type "${e.type}" (${e.id}) is not mapped yet`);
  }
}

// --- constraints -------------------------------------------------------------

const CONSTRAINT_TYPES: Record<ConstraintType, string> = {
  coincident: "COINCIDENT",
  horizontal: "HORIZONTAL",
  vertical: "VERTICAL",
  parallel: "PARALLEL",
  perpendicular: "PERPENDICULAR",
  tangent: "TANGENT",
  concentric: "CONCENTRIC",
  equal: "EQUAL",
  midpoint: "MIDPOINT",
  symmetric: "SYMMETRIC",
  fix: "FIX",
  collinear: "COLLINEAR",
  pierce: "PIERCE",
  onEntity: "COINCIDENT",
};

const SLOTS = ["First", "Second", "Third"] as const;

/** Constraint parameters, or undefined if an arg is an unresolved model-geometry Ref. */
function argParams(args: SketchArg[], entityIds: Set<string>, originId: string | undefined): BTParameter[] | undefined {
  const params: BTParameter[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const slot = SLOTS[i];
    if (!slot) return undefined;
    if (typeof arg !== "string") return undefined;
    const external = parseExternalArg(arg);
    if (external) {
      params.push(queryList(`external${slot}`, [idQuery(external)]));
    } else if (arg === "ORIGIN") {
      if (!originId) throw new SketchComposeError("constraint references ORIGIN but no origin id was supplied");
      params.push(queryList(`external${slot}`, [idQuery([originId])]));
    } else {
      const entity = arg.split(".")[0]!;
      if (!entityIds.has(entity)) throw new SketchComposeError(`constraint references unknown sketch entity "${entity}"`);
      params.push({ btType: "BTMParameterString-149", parameterId: `local${slot}`, value: arg });
    }
  }
  return params;
}

function swapType(type: string, swapHV: boolean): string {
  if (!swapHV) return type;
  return type === "HORIZONTAL" ? "VERTICAL" : type === "VERTICAL" ? "HORIZONTAL" : type;
}

function dimensionType(t: DimensionType, argCount: number): string {
  switch (t) {
    case "distance":
      return argCount === 1 ? "LENGTH" : "DISTANCE";
    case "horizontal":
    case "vertical":
      return "DISTANCE";
    case "angle":
      return "ANGLE";
    case "radius":
      return "RADIUS";
    case "diameter":
      return "DIAMETER";
  }
}

/** Onshape entity ids: letters, digits, dot, underscore. "D1@Sketch1" -> "D1_Sketch1". */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.]/g, "_");
}

const ORDER: Rung[] = ["pending", "exact", "composite", "featurescript", "approximated", "geometry", "dropped"];
export function lower(a: Rung, b: Rung): Rung {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}
