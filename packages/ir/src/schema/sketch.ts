import { z } from "zod";
import { Ext, Id, Quantity, Vec2 } from "./primitives";
import { Ref } from "./ref";

/** Sketch entity ids may not contain "." so that "<id>.<point>" arguments stay unambiguous. */
export const EntityId = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .meta({ id: "EntityId" });
export type EntityId = z.infer<typeof EntityId>;

/**
 * Argument of a constraint or dimension:
 *   "l1"           the whole entity
 *   "l1.start"     a sub-point: start | end | center | mid
 *   "ORIGIN"       the sketch origin
 *   "ext:<key>"    an entry of the sketch `externalRefs` map (model edge, face, vertex)
 */
export const SketchArg = z
  .string()
  .regex(/^(ORIGIN|ext:[A-Za-z0-9_-]+|[A-Za-z0-9_-]+(\.(start|end|center|mid))?)$/)
  .meta({ id: "SketchArg" });
export type SketchArg = z.infer<typeof SketchArg>;

const entityBase = {
  id: EntityId,
  construction: z.boolean(),
  /** Source-system id of the segment. */
  sourceId: z.string().optional(),
};

export const SketchPoint = z.object({ ...entityBase, type: z.literal("point"), at: Vec2 }).meta({ id: "SketchPoint" });
export const SketchLine = z.object({ ...entityBase, type: z.literal("line"), p0: Vec2, p1: Vec2 }).meta({ id: "SketchLine" });
export const SketchArc = z
  .object({
    ...entityBase,
    type: z.literal("arc"),
    center: Vec2,
    start: Vec2,
    end: Vec2,
    direction: z.enum(["ccw", "cw"]),
  })
  .meta({ id: "SketchArc" });
export const SketchCircle = z
  .object({ ...entityBase, type: z.literal("circle"), center: Vec2, r: z.number().positive() })
  .meta({ id: "SketchCircle" });
export const SketchEllipse = z
  .object({
    ...entityBase,
    type: z.literal("ellipse"),
    center: Vec2,
    majorRadius: z.number().positive(),
    minorRadius: z.number().positive(),
    /** Rotation of the major axis from sketch X, radians. */
    rotation: z.number(),
    /** Start/end parameter angles (rad) for a partial ellipse; omitted for a full ellipse. */
    start: z.number().optional(),
    end: z.number().optional(),
  })
  .meta({ id: "SketchEllipse" });
export const SketchSpline = z
  .object({
    ...entityBase,
    type: z.literal("spline"),
    degree: z.number().int().min(1),
    controlPoints: z.array(Vec2).min(2),
    knots: z.array(z.number()).optional(),
    weights: z.array(z.number()).optional(),
    /** Interpolation points when the source defines the spline by fit points. */
    fitPoints: z.array(Vec2).optional(),
    periodic: z.boolean().optional(),
  })
  .meta({ id: "SketchSpline" });
/** Anything the core vocabulary lacks (text, sketch blocks, ...). Kept losslessly in `ext`. */
export const SketchOther = z
  .object({ ...entityBase, type: z.literal("other"), sourceType: z.string(), ext: Ext.optional() })
  .meta({ id: "SketchOther" });

export const SketchEntity = z
  .discriminatedUnion("type", [SketchPoint, SketchLine, SketchArc, SketchCircle, SketchEllipse, SketchSpline, SketchOther])
  .meta({ id: "SketchEntity", description: "2D geometry in sketch coordinates (metres)" });
export type SketchEntity = z.infer<typeof SketchEntity>;

export const ConstraintType = z
  .enum([
    "coincident",
    "horizontal",
    "vertical",
    "parallel",
    "perpendicular",
    "tangent",
    "concentric",
    "equal",
    "midpoint",
    "symmetric",
    "fix",
    "collinear",
    "coradial",
    "pierce",
    "merge",
    "intersection",
    "onEdge",
    "other",
  ])
  .meta({ id: "ConstraintType" });
export type ConstraintType = z.infer<typeof ConstraintType>;

/**
 * A sketch relation. `args` are ordered: for "symmetric" the last argument is the
 * symmetry line; for "midpoint" the first is the point and the second the line.
 */
export const Constraint = z
  .object({
    id: EntityId.optional(),
    type: ConstraintType,
    args: z.array(SketchArg).min(1),
    /** Source relation type name when `type` is "other" or the mapping is lossy. */
    sourceType: z.string().optional(),
    ext: Ext.optional(),
  })
  .meta({ id: "Constraint" });
export type Constraint = z.infer<typeof Constraint>;

export const DimensionType = z
  .enum(["distance", "horizontal", "vertical", "angle", "radius", "diameter", "arcLength"])
  .meta({ id: "DimensionType" });
export type DimensionType = z.infer<typeof DimensionType>;

export const Dimension = z
  .object({
    /** Full source name, e.g. "D1@Sketch1". Unique within the document. */
    id: Id,
    type: DimensionType,
    args: z.array(SketchArg).min(1).max(2),
    value: Quantity,
    /** False for reference (driven) dimensions. */
    driving: z.boolean(),
    /** Parameter that drives this dimension through an equation, if any. */
    parameter: Id.optional(),
    /** Text placement in sketch coordinates; display only. */
    placement: Vec2.optional(),
    ext: Ext.optional(),
  })
  .meta({ id: "Dimension" });
export type Dimension = z.infer<typeof Dimension>;

export const SolveStatus = z.enum(["fullyDefined", "underDefined", "overDefined", "unsolved"]).meta({ id: "SolveStatus" });
export type SolveStatus = z.infer<typeof SolveStatus>;

/** Model entities a sketch references, addressable from args as "ext:<key>". */
export const ExternalRefs = z.record(EntityId, Ref).meta({ id: "ExternalRefs" });
export type ExternalRefs = z.infer<typeof ExternalRefs>;
