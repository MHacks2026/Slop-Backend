import { z } from "zod";
import { Ext, Id, Unit } from "./primitives";

export const ParameterScope = z.enum(["global", "part", "configuration"]).meta({ id: "ParameterScope" });

/**
 * A global variable or an equation. A global variable has no `target`
 * ("Width" = 50 mm). An equation sets `target` to the dimension it drives
 * ("D1@Sketch1" = "Width" / 2); the dimension carries the same expression in
 * its own `value.expr` so either side can be read alone.
 */
export const Parameter = z
  .object({
    id: Id,
    name: z.string().min(1),
    scope: ParameterScope,
    expr: z.string(),
    /** Evaluated SI value. */
    value: z.number(),
    unit: Unit,
    /** Dimension id this equation drives; absent for global variables. */
    target: Id.optional(),
    /** Source-side suppressed or disabled flag on the equation. */
    disabled: z.boolean().optional(),
    comment: z.string().optional(),
    ext: Ext.optional(),
  })
  .meta({ id: "Parameter", description: "Global variable or equation" });
export type Parameter = z.infer<typeof Parameter>;

export const ParameterOverride = z
  .object({ kind: z.literal("parameter"), parameter: Id, expr: z.string(), value: z.number() })
  .meta({ id: "ParameterOverride" });
export const DimensionOverride = z
  .object({ kind: z.literal("dimension"), dimension: Id, expr: z.string(), value: z.number() })
  .meta({ id: "DimensionOverride" });
export const SuppressionOverride = z
  .object({ kind: z.literal("suppression"), feature: Id, suppressed: z.boolean() })
  .meta({ id: "SuppressionOverride" });
/** Material, custom property, mate set... anything the core does not model yet. */
export const OtherOverride = z
  .object({ kind: z.literal("other"), target: z.string(), value: z.unknown() })
  .meta({ id: "OtherOverride" });

export const Override = z
  .discriminatedUnion("kind", [ParameterOverride, DimensionOverride, SuppressionOverride, OtherOverride])
  .meta({ id: "Override" });
export type Override = z.infer<typeof Override>;

/**
 * A configuration is an overlay on the base model: the base plus the overrides
 * of this configuration (after those of its parents) is the model in that
 * configuration. The tree is never duplicated.
 */
export const Configuration = z
  .object({
    id: Id,
    name: z.string().min(1),
    /** Parent (derived-from) configuration. */
    parent: Id.optional(),
    overrides: z.array(Override),
    ext: Ext.optional(),
  })
  .meta({ id: "Configuration" });
export type Configuration = z.infer<typeof Configuration>;
