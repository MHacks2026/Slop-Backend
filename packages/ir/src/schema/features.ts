import { z } from "zod";
import { Ext, Fidelity, Frame, Id, Quantity } from "./primitives";
import { Ref } from "./ref";
import { Constraint, Dimension, ExternalRefs, SketchEntity, SolveStatus } from "./sketch";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const featureBase = {
  id: Id,
  /** Source feature name, e.g. "Boss-Extrude1". */
  name: z.string().min(1),
  /** Boolean, or an expression string when suppression is driven by an equation. */
  suppressed: z.union([z.boolean(), z.string()]),
  /** Features this one depends on, as reported by the source (parent links). */
  parents: z.array(Id).optional(),
  /** Raw source payload, keyed by vendor. */
  ext: Ext.optional(),
  /** Set by the translator after the feature is carried across. */
  fidelity: Fidelity.optional(),
};

export const BooleanMode = z.enum(["new", "add", "remove", "intersect"]).meta({ id: "BooleanMode" });
export type BooleanMode = z.infer<typeof BooleanMode>;

export const EndCondition = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("blind"), depth: Quantity }),
    z.object({ type: z.literal("throughAll") }),
    z.object({ type: z.literal("upToNext") }),
    z.object({ type: z.literal("upToVertex"), vertex: Ref }),
    z.object({ type: z.literal("upToSurface"), face: Ref }),
    z.object({
      type: z.literal("offsetFromSurface"),
      face: Ref,
      distance: Quantity,
      reverseOffset: z.boolean(),
      translateSurface: z.boolean().optional(),
    }),
    z.object({ type: z.literal("upToBody"), body: Ref }),
    z.object({ type: z.literal("midPlane"), depth: Quantity }),
  ])
  .meta({ id: "EndCondition", description: "How far a feature extends in one direction" });
export type EndCondition = z.infer<typeof EndCondition>;

export const Draft = z.object({ angle: Quantity, outward: z.boolean() }).meta({ id: "Draft" });

export const ThinOption = z
  .object({
    type: z.enum(["oneDirection", "midPlane", "twoDirection"]),
    thickness1: Quantity,
    thickness2: Quantity.optional(),
    reverse: z.boolean().optional(),
  })
  .meta({ id: "ThinOption" });

export const SelectionMode = z
  .enum(["single", "tangentChain", "feature", "face", "loop"])
  .meta({ id: "SelectionMode", description: "How the source selected edges; must be preserved, not just the result" });

// ---------------------------------------------------------------------------
// Feature operations (MVP scope, architecture doc section 14)
// ---------------------------------------------------------------------------

export const SketchFeature = z
  .object({
    ...featureBase,
    op: z.literal("sketch"),
    plane: Ref,
    /** Sketch-to-model transform. Sketch X/Y map to xAxis/yAxis; zAxis is the sketch normal. */
    frame: Frame,
    entities: z.array(SketchEntity),
    constraints: z.array(Constraint),
    dimensions: z.array(Dimension),
    externalRefs: ExternalRefs.optional(),
    /** Solver status in the source, for Level 2 validation. */
    solved: SolveStatus.optional(),
  })
  .meta({ id: "SketchFeature" });

export const ExtrudeFeature = z
  .object({
    ...featureBase,
    op: z.literal("extrude"),
    mode: BooleanMode,
    /** Sketch regions (feature-output refs with role "region"), or faces for face extrudes. */
    profile: z.array(Ref).min(1),
    /** True when the primary direction is reversed relative to the sketch normal. */
    flip: z.boolean(),
    end: EndCondition,
    secondEnd: EndCondition.optional(),
    draft: Draft.optional(),
    secondDraft: Draft.optional(),
    thin: ThinOption.optional(),
    /** Merge with existing bodies (multibody parts). */
    merge: z.boolean(),
    /** Bodies the operation is limited to (feature scope); absent means all. */
    scope: z.array(Ref).optional(),
  })
  .meta({ id: "ExtrudeFeature" });

export const RevolveFeature = z
  .object({
    ...featureBase,
    op: z.literal("revolve"),
    mode: BooleanMode,
    profile: z.array(Ref).min(1),
    /** Sketch line, model edge or axis feature. */
    axis: Ref,
    angle: Quantity,
    flip: z.boolean(),
    /** Second-direction angle; set for two-direction revolves. */
    secondAngle: Quantity.optional(),
    midPlane: z.boolean().optional(),
    thin: ThinOption.optional(),
    merge: z.boolean(),
    scope: z.array(Ref).optional(),
  })
  .meta({ id: "RevolveFeature" });

export const FilletFeature = z
  .object({
    ...featureBase,
    op: z.literal("fillet"),
    /** Only constant radius is in the core; variable and setback fillets use "other". */
    radius: Quantity,
    /** Edges or faces (face selection rounds every edge of the face). */
    edges: z.array(Ref).min(1),
    selectionMode: SelectionMode,
    tangentPropagation: z.boolean(),
    keepFeatures: z.boolean().optional(),
  })
  .meta({ id: "FilletFeature" });

export const ChamferFeature = z
  .object({
    ...featureBase,
    op: z.literal("chamfer"),
    type: z.enum(["equalDistance", "distanceDistance", "angleDistance", "vertex"]),
    edges: z.array(Ref).min(1),
    distance1: Quantity,
    distance2: Quantity.optional(),
    angle: Quantity.optional(),
    flip: z.boolean(),
    tangentPropagation: z.boolean(),
  })
  .meta({ id: "ChamferFeature" });

export const HoleFeature = z
  .object({
    ...featureBase,
    op: z.literal("hole"),
    holeType: z.enum(["simple", "counterbore", "countersink", "tapped"]),
    /** Face the holes start on. */
    face: Ref,
    /** Sketch feature holding the hole centre points. */
    positionSketch: Id,
    diameter: Quantity,
    end: EndCondition,
    counterbore: z.object({ diameter: Quantity, depth: Quantity }).optional(),
    countersink: z.object({ diameter: Quantity, angle: Quantity }).optional(),
    /** Standard/type/size strings from the hole wizard, carried verbatim. */
    standard: z.object({ standard: z.string(), type: z.string(), size: z.string() }).optional(),
    thread: z.object({ designation: z.string(), depth: Quantity.optional(), cosmetic: z.boolean().optional() }).optional(),
  })
  .meta({ id: "HoleFeature" });

export const ShellFeature = z
  .object({
    ...featureBase,
    op: z.literal("shell"),
    thickness: Quantity,
    outward: z.boolean(),
    /** Faces removed to open the shell; empty for a closed hollow. */
    removeFaces: z.array(Ref),
  })
  .meta({ id: "ShellFeature" });

const PatternDirection = z
  .object({
    /** Edge, sketch line, axis or planar face normal giving the direction. */
    direction: Ref,
    spacing: Quantity,
    /** Instance count including the seed; unitless quantity so it can be an expression. */
    count: Quantity,
    flip: z.boolean(),
  })
  .meta({ id: "PatternDirection" });

const patternBase = {
  /** Seed features (preferred: keeps the pattern parametric). */
  seedFeatures: z.array(Id),
  /** Seed bodies or faces when the source patterns geometry rather than features. */
  seedGeometry: z.array(Ref).optional(),
  /** Pattern only the geometry of the seed, not its full feature definition. */
  geometryPattern: z.boolean().optional(),
};

export const LinearPatternFeature = z
  .object({
    ...featureBase,
    ...patternBase,
    op: z.literal("linearPattern"),
    direction1: PatternDirection,
    direction2: PatternDirection.optional(),
    /** Only pattern the seed along direction 2, not the whole direction-1 row. */
    patternSeedOnly: z.boolean().optional(),
    /** Skipped instance indices as [i, j] (j = 0 for one direction). */
    skipped: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
  })
  .meta({ id: "LinearPatternFeature" });

export const CircularPatternFeature = z
  .object({
    ...featureBase,
    ...patternBase,
    op: z.literal("circularPattern"),
    axis: Ref,
    count: Quantity,
    /** Total angle when `equalSpacing`, otherwise the angle between instances. */
    angle: Quantity,
    equalSpacing: z.boolean(),
    flip: z.boolean(),
    skipped: z.array(z.number().int()).optional(),
  })
  .meta({ id: "CircularPatternFeature" });

export const MirrorFeature = z
  .object({
    ...featureBase,
    ...patternBase,
    op: z.literal("mirror"),
    /** Datum plane or planar face. */
    plane: Ref,
    merge: z.boolean().optional(),
  })
  .meta({ id: "MirrorFeature" });

export const PlaneDefinition = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("offset"), reference: Ref, distance: Quantity, flip: z.boolean() }),
    z.object({ type: z.literal("angle"), reference: Ref, axis: Ref, angle: Quantity, flip: z.boolean() }),
    z.object({ type: z.literal("midPlane"), first: Ref, second: Ref }),
    z.object({ type: z.literal("threePoints"), points: z.array(Ref).length(3) }),
    z.object({ type: z.literal("parallelThroughPoint"), reference: Ref, point: Ref }),
    z.object({ type: z.literal("normalToCurve"), curve: Ref, point: Ref }),
    z.object({ type: z.literal("other"), references: z.array(Ref) }),
  ])
  .meta({ id: "PlaneDefinition" });

export const PlaneFeature = z
  .object({ ...featureBase, op: z.literal("plane"), definition: PlaneDefinition })
  .meta({ id: "PlaneFeature" });

export const AxisFeature = z
  .object({
    ...featureBase,
    op: z.literal("axis"),
    method: z.enum(["line", "twoPlanes", "twoPoints", "cylindrical", "pointAndFace", "other"]),
    references: z.array(Ref).min(1),
  })
  .meta({ id: "AxisFeature" });

/**
 * Any feature outside the core vocabulary. Nothing is dropped: the full source
 * definition lives in `ext`, and `inputs` keeps the dependency graph intact so
 * the translator can still place it (and fall back to a geometry patch).
 */
export const OtherFeature = z
  .object({
    ...featureBase,
    op: z.literal("other"),
    /** Source type name, e.g. SolidWorks GetTypeName2(). */
    sourceType: z.string().min(1),
    inputs: z.array(Ref).optional(),
    /** Named quantities the extractor could read, even without a mapping. */
    quantities: z.record(z.string(), Quantity).optional(),
  })
  .meta({ id: "OtherFeature" });

export const Feature = z
  .discriminatedUnion("op", [
    SketchFeature,
    ExtrudeFeature,
    RevolveFeature,
    FilletFeature,
    ChamferFeature,
    HoleFeature,
    ShellFeature,
    LinearPatternFeature,
    CircularPatternFeature,
    MirrorFeature,
    PlaneFeature,
    AxisFeature,
    OtherFeature,
  ])
  .meta({ id: "Feature", description: "One node of the feature tree, in rollback order" });
export type Feature = z.infer<typeof Feature>;
export type FeatureOp = Feature["op"];
export type SketchFeature = z.infer<typeof SketchFeature>;
export type ExtrudeFeature = z.infer<typeof ExtrudeFeature>;
export type RevolveFeature = z.infer<typeof RevolveFeature>;
export type FilletFeature = z.infer<typeof FilletFeature>;
export type ChamferFeature = z.infer<typeof ChamferFeature>;
export type HoleFeature = z.infer<typeof HoleFeature>;
export type ShellFeature = z.infer<typeof ShellFeature>;
export type LinearPatternFeature = z.infer<typeof LinearPatternFeature>;
export type CircularPatternFeature = z.infer<typeof CircularPatternFeature>;
export type MirrorFeature = z.infer<typeof MirrorFeature>;
export type PlaneFeature = z.infer<typeof PlaneFeature>;
export type AxisFeature = z.infer<typeof AxisFeature>;
export type OtherFeature = z.infer<typeof OtherFeature>;
