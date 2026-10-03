import { z } from "zod";

/** Schema version carried by every Document. Bump on any breaking change. */
export const IR_VERSION = "0.1.0";

/** Stable identifier. Survives re-extraction of the same model. */
export const Id = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.:@#/-]+$/)
  .meta({ id: "Id", description: "Stable node identifier" });
export type Id = z.infer<typeof Id>;

export const Vec2 = z.tuple([z.number(), z.number()]).meta({ id: "Vec2", description: "2D point or vector in metres" });
export const Vec3 = z
  .tuple([z.number(), z.number(), z.number()])
  .meta({ id: "Vec3", description: "3D point or vector in metres" });
export type Vec2 = z.infer<typeof Vec2>;
export type Vec3 = z.infer<typeof Vec3>;

/** 4x4 homogeneous transform, row-major, translation in metres. */
export const Matrix4 = z.array(z.number()).length(16).meta({ id: "Matrix4" });
export type Matrix4 = z.infer<typeof Matrix4>;

/** Right-handed orthonormal frame. Used for sketch-to-model placement. */
export const Frame = z
  .object({
    origin: Vec3,
    xAxis: Vec3,
    yAxis: Vec3,
    zAxis: Vec3,
  })
  .meta({ id: "Frame", description: "Orthonormal frame: origin plus unit axes, in model space" });
export type Frame = z.infer<typeof Frame>;

export const BBox = z.object({ min: Vec3, max: Vec3 }).meta({ id: "BBox" });
export type BBox = z.infer<typeof BBox>;

export const LengthUnit = z.enum(["m", "mm", "cm", "in", "ft"]);
export const AngleUnit = z.enum(["rad", "deg"]);
export const MassUnit = z.enum(["kg", "g", "lb"]);

/** Display unit of a quantity expression. The stored value is always SI. */
export const Unit = z
  .enum(["m", "mm", "cm", "in", "ft", "rad", "deg", "m2", "m3", "kg", "g", "lb", "unitless"])
  .meta({ id: "Unit" });
export type Unit = z.infer<typeof Unit>;

/**
 * A dimensioned value that keeps its expression. `expr` is the source text
 * ("50 mm", "\"Width\" / 2"); `value` is the evaluated SI number (m, rad, m2, m3,
 * kg or unitless); `unit` is the unit the expression is written in.
 */
export const Quantity = z
  .object({
    expr: z.string(),
    value: z.number(),
    unit: Unit,
    /** Source dimension name, e.g. "D1@Boss-Extrude1", when the value is a named dimension. */
    name: Id.optional(),
    /** True when the source marks this as driven (reference) rather than driving. */
    driven: z.boolean().optional(),
  })
  .meta({ id: "Quantity", description: "Expression plus evaluated SI value" });
export type Quantity = z.infer<typeof Quantity>;

/** Raw source payload keyed by vendor ("sw", "onshape", ...). Never interpreted by the core. */
export const Ext = z.record(z.string(), z.unknown()).meta({ id: "Ext", description: "Lossless vendor payload" });
export type Ext = z.infer<typeof Ext>;

/** How a node was carried to the target. Set by the translator, absent on extraction. */
export const FidelityLevel = z
  .enum(["exact", "composite", "featurescript", "approximated", "geometry", "dropped"])
  .meta({ id: "FidelityLevel" });
export type FidelityLevel = z.infer<typeof FidelityLevel>;

/** Fallback-ladder rung for each fidelity level (architecture doc, section 6). */
export const FIDELITY_RUNG: Record<FidelityLevel, 1 | 2 | 3 | 4 | 5 | 6> = {
  exact: 1,
  composite: 2,
  featurescript: 3,
  approximated: 4,
  geometry: 5,
  dropped: 6,
};

export const Fidelity = z
  .object({
    level: FidelityLevel,
    reason: z.string().optional(),
    /** Target-side ids created for this node (e.g. Onshape feature ids). */
    targetIds: z.array(z.string()).optional(),
  })
  .meta({ id: "Fidelity" });
export type Fidelity = z.infer<typeof Fidelity>;
