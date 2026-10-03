import { z } from "zod";
import { Ext, Id, Matrix4, Quantity } from "./primitives";
import { Ref } from "./ref";

export const ComponentRef = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("partStudio"), partStudio: Id }),
    z.object({ kind: z.literal("assembly"), assembly: Id }),
    /** A component whose document was not extracted (library or missing part). */
    z.object({ kind: z.literal("external"), path: z.string(), fileHash: z.string().optional() }),
  ])
  .meta({ id: "ComponentRef" });

export const Instance = z
  .object({
    id: Id,
    name: z.string().min(1),
    component: ComponentRef,
    /** Referenced configuration name of the component. */
    configuration: z.string().optional(),
    /** Absolute placement in the assembly, row-major 4x4, metres. */
    transform: Matrix4,
    fixed: z.boolean(),
    suppressed: z.boolean(),
    ext: Ext.optional(),
  })
  .meta({ id: "Instance" });
export type Instance = z.infer<typeof Instance>;

/** An entity on an instance. `instancePath` descends through subassemblies. */
export const MateRef = z.object({ instancePath: z.array(Id).min(1), ref: Ref }).meta({ id: "MateRef" });
export type MateRef = z.infer<typeof MateRef>;

export const MateType = z
  .enum([
    "coincident",
    "concentric",
    "parallel",
    "perpendicular",
    "tangent",
    "distance",
    "angle",
    "lock",
    "width",
    "symmetric",
    "hinge",
    "slot",
    "path",
    "gear",
    "rackPinion",
    "screw",
    "universalJoint",
    "cam",
    "profileCenter",
    "other",
  ])
  .meta({ id: "MateType" });

export const Mate = z
  .object({
    id: Id,
    name: z.string().min(1),
    type: MateType,
    entities: z.array(MateRef).min(1),
    alignment: z.enum(["aligned", "antiAligned", "closest"]).optional(),
    offset: Quantity.optional(),
    angle: Quantity.optional(),
    limits: z.object({ min: Quantity.optional(), max: Quantity.optional() }).optional(),
    flip: z.boolean().optional(),
    suppressed: z.boolean(),
    sourceType: z.string().optional(),
    ext: Ext.optional(),
  })
  .meta({ id: "Mate" });
export type Mate = z.infer<typeof Mate>;

export const Assembly = z
  .object({
    id: Id,
    name: z.string().min(1),
    instances: z.array(Instance),
    mates: z.array(Mate),
    ext: Ext.optional(),
  })
  .meta({ id: "Assembly" });
export type Assembly = z.infer<typeof Assembly>;
