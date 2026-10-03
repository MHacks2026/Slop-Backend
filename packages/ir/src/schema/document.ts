import { z } from "zod";
import { Assembly } from "./assembly";
import { FeatureEvidence } from "./evidence";
import { Feature } from "./features";
import { Configuration, Parameter } from "./parameters";
import { AngleUnit, Ext, IR_VERSION, Id, LengthUnit, MassUnit } from "./primitives";

export const SourceCad = z
  .enum(["solidworks", "onshape", "fusion", "inventor", "creo", "nx", "catia", "freecad", "other"])
  .meta({ id: "SourceCad" });

export const SourceInfo = z
  .object({
    cad: SourceCad,
    /** CAD application version, e.g. "SOLIDWORKS 2025 SP2". */
    version: z.string().optional(),
    fileName: z.string().optional(),
    /** sha256 hex of the source file. */
    fileHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    extractor: z.object({ name: z.string(), version: z.string() }).optional(),
    extractedAt: z.iso.datetime().optional(),
  })
  .meta({ id: "SourceInfo" });
export type SourceInfo = z.infer<typeof SourceInfo>;

/** Display units of the source document. IR values are always SI regardless. */
export const Units = z.object({ length: LengthUnit, angle: AngleUnit, mass: MassUnit.optional() }).meta({ id: "Units" });

export const Body = z.object({ id: Id, name: z.string().optional(), type: z.enum(["solid", "sheet"]) }).meta({ id: "Body" });

export const Material = z.object({ name: z.string(), density: z.number().positive().optional() }).meta({ id: "Material" });

/** One part (or multibody part): its feature tree and what it produces. */
export const PartStudio = z
  .object({
    id: Id,
    name: z.string().min(1),
    /** Rollback order. A feature may only reference features that precede it. */
    features: z.array(Feature),
    /** Output bodies at the end of the tree. */
    bodies: z.array(Body),
    material: Material.optional(),
    /** Custom properties, verbatim. */
    properties: z.record(z.string(), z.string()).optional(),
    /** Evidence layer, keyed by feature id. Optional and excluded from intent hashes. */
    evidence: z.record(Id, FeatureEvidence).optional(),
    ext: Ext.optional(),
  })
  .meta({ id: "PartStudio" });
export type PartStudio = z.infer<typeof PartStudio>;

export const Document = z
  .object({
    irVersion: z.literal(IR_VERSION),
    id: Id.optional(),
    name: z.string().min(1),
    source: SourceInfo,
    units: Units,
    parameters: z.array(Parameter),
    configurations: z.array(Configuration),
    /** Configuration the base model (feature values, suppression) was extracted in. */
    activeConfiguration: Id.optional(),
    partStudios: z.array(PartStudio),
    assemblies: z.array(Assembly),
    properties: z.record(z.string(), z.string()).optional(),
    ext: Ext.optional(),
  })
  .meta({
    id: "Document",
    title: "CAD design-intent IR",
    description: "Vendor-neutral, history-based CAD model: intent layer plus optional evidence layer",
  });
export type Document = z.infer<typeof Document>;
