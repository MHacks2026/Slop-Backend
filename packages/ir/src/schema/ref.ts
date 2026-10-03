import { z } from "zod";
import { Ext, Id, Vec3 } from "./primitives";

/** Default datum names shared by every history-based CAD system. */
export const StandardDatum = z.enum(["FRONT", "TOP", "RIGHT", "ORIGIN"]);
export type StandardDatum = z.infer<typeof StandardDatum>;

/**
 * A datum: one of the three default planes or the origin, or a datum feature
 * (reference plane, axis, point) identified by `feature`.
 */
export const DatumRef = z
  .object({
    kind: z.literal("datum"),
    /** "FRONT" | "TOP" | "RIGHT" | "ORIGIN", or the source name of a datum feature. */
    name: z.string().min(1),
    /** Set when the datum is a feature in the tree. */
    feature: Id.optional(),
  })
  .meta({ id: "DatumRef" });
export type DatumRef = z.infer<typeof DatumRef>;

export const FeatureOutputRole = z
  .enum(["region", "body", "curve", "plane", "axis", "point", "sketchEntity"])
  .meta({ id: "FeatureOutputRole" });

/** Something a feature produces by definition: a sketch region, a body, a datum plane. */
export const FeatureOutputRef = z
  .object({
    kind: z.literal("feature-output"),
    feature: Id,
    role: FeatureOutputRole,
    /** Which region/body when the feature produces several. */
    index: z.number().int().nonnegative().optional(),
    /** Sketch entity id when role is "sketchEntity". */
    entity: Id.optional(),
  })
  .meta({ id: "FeatureOutputRef" });
export type FeatureOutputRef = z.infer<typeof FeatureOutputRef>;

export const TopoEntityType = z.enum(["face", "edge", "vertex", "body"]).meta({ id: "TopoEntityType" });
export type TopoEntityType = z.infer<typeof TopoEntityType>;

export const SurfaceKind = z
  .enum(["plane", "cylinder", "cone", "sphere", "torus", "bspline", "other"])
  .meta({ id: "SurfaceKind" });
export type SurfaceKind = z.infer<typeof SurfaceKind>;

export const CurveKind = z.enum(["line", "circle", "ellipse", "bspline", "other"]).meta({ id: "CurveKind" });
export type CurveKind = z.infer<typeof CurveKind>;

export const FaceSignature = z
  .object({
    type: z.literal("face"),
    surface: SurfaceKind,
    /** Unit normal for planes; axis direction for cylinders, cones and tori. */
    normal: Vec3.optional(),
    /** A point on the plane, or a point on the axis. */
    origin: Vec3.optional(),
    radius: z.number().optional(),
    /** Minor radius for tori, half-angle (rad) for cones. */
    radius2: z.number().optional(),
    area: z.number().optional(),
    centroid: Vec3.optional(),
  })
  .meta({ id: "FaceSignature" });
export type FaceSignature = z.infer<typeof FaceSignature>;

export const EdgeSignature = z
  .object({
    type: z.literal("edge"),
    curve: CurveKind,
    start: Vec3.optional(),
    end: Vec3.optional(),
    midpoint: Vec3.optional(),
    center: Vec3.optional(),
    axis: Vec3.optional(),
    radius: z.number().optional(),
    length: z.number().optional(),
    /** Surface kinds of the two adjacent faces. */
    adjacentSurfaces: z.array(SurfaceKind).optional(),
  })
  .meta({ id: "EdgeSignature" });
export type EdgeSignature = z.infer<typeof EdgeSignature>;

export const VertexSignature = z
  .object({
    type: z.literal("vertex"),
    point: Vec3,
  })
  .meta({ id: "VertexSignature" });
export type VertexSignature = z.infer<typeof VertexSignature>;

export const GeomSignature = z
  .discriminatedUnion("type", [FaceSignature, EdgeSignature, VertexSignature])
  .meta({ id: "GeomSignature", description: "Geometric fingerprint used by the reference resolver" });
export type GeomSignature = z.infer<typeof GeomSignature>;

/** Local topology around an entity, for breaking symmetry ties. */
export const AdjacencyContext = z
  .object({
    /** Hash of the neighbourhood graph, computed by the extractor. */
    hash: z.string().optional(),
    /** Surface kinds of neighbouring faces, in a canonical order. */
    neighbours: z.array(SurfaceKind).optional(),
  })
  .meta({ id: "AdjacencyContext" });

/**
 * A face, edge, vertex or body selected from regenerated geometry.
 * Carries every resolver the matcher may use (architecture doc, section 8).
 * Role conventions: "cap:start", "cap:end", "side:<sketchEntityId>", "created",
 * "between(<featureId>.<role>, <featureId>.<role>)".
 */
export const TopoRef = z
  .object({
    kind: z.literal("topo"),
    entity: TopoEntityType,
    /** Feature whose operation created this entity. */
    createdBy: Id.optional(),
    /** Semantic role relative to `createdBy`; see conventions above. */
    role: z.string().optional(),
    /** Source-system persistent reference (opaque; valid only in the source). */
    sourceId: z.string().optional(),
    signature: GeomSignature.optional(),
    adjacency: AdjacencyContext.optional(),
    /** A point on the entity, for the spatial-probe resolver. */
    probe: Vec3.optional(),
    ext: Ext.optional(),
  })
  .meta({ id: "TopoRef" });
export type TopoRef = z.infer<typeof TopoRef>;

export const Ref = z
  .discriminatedUnion("kind", [DatumRef, FeatureOutputRef, TopoRef])
  .meta({ id: "Ref", description: "First-class reference to a datum, a feature output or regenerated topology" });
export type Ref = z.infer<typeof Ref>;
