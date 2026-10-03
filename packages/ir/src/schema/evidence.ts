import { z } from "zod";
import { BBox, Id, Vec3 } from "./primitives";
import { EdgeSignature, FaceSignature, SurfaceKind } from "./ref";

/** Mass and topology summary of one body after a feature regenerated. All SI. */
export const BodyEvidence = z
  .object({
    /** Source body name, when the source names bodies. */
    name: z.string().optional(),
    type: z.enum(["solid", "sheet"]),
    /** Hash of the exported B-rep, when one was exported. */
    hash: z.string().optional(),
    volume: z.number().nonnegative(),
    area: z.number().nonnegative(),
    centerOfMass: Vec3.optional(),
    /** Inertia tensor about the centre of mass, row-major 3x3, kg m2 (unit density unless a material is set). */
    inertia: z.array(z.number()).length(9).optional(),
    bbox: BBox.optional(),
    faceCount: z.number().int().nonnegative().optional(),
    edgeCount: z.number().int().nonnegative().optional(),
    vertexCount: z.number().int().nonnegative().optional(),
    /** Histogram of face surface kinds. */
    faceTypes: z.partialRecord(SurfaceKind, z.number().int().nonnegative()).optional(),
  })
  .meta({ id: "BodyEvidence" });
export type BodyEvidence = z.infer<typeof BodyEvidence>;

export const FaceEvidence = z
  .object({ sourceId: z.string(), signature: FaceSignature, adjacentEdges: z.array(z.string()).optional() })
  .meta({ id: "FaceEvidence" });
export const EdgeEvidence = z
  .object({ sourceId: z.string(), signature: EdgeSignature, adjacentFaces: z.array(z.string()).optional() })
  .meta({ id: "EdgeEvidence" });
export const VertexEvidence = z.object({ sourceId: z.string(), point: Vec3 }).meta({ id: "VertexEvidence" });

export const BlobRef = z
  .object({
    /** Storage path or URL of the blob. */
    path: z.string(),
    /** sha256 hex of the blob. */
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .meta({ id: "BlobRef" });

/**
 * What the source produced right after one feature, captured by rolling back
 * and rebuilding. Regenerable, so it is stored apart from the intent layer and
 * excluded from intent hashes.
 */
export const FeatureEvidence = z
  .object({
    feature: Id,
    bodies: z.array(BodyEvidence),
    faces: z.array(FaceEvidence).optional(),
    edges: z.array(EdgeEvidence).optional(),
    vertices: z.array(VertexEvidence).optional(),
    /** Source ids of entities this feature created (what "createdBy" roles resolve against). */
    created: z
      .object({
        faces: z.array(z.string()).optional(),
        edges: z.array(z.string()).optional(),
        vertices: z.array(z.string()).optional(),
      })
      .optional(),
    brep: z.object({ format: z.enum(["parasolid", "step"]), blob: BlobRef }).optional(),
    renders: z.array(z.object({ view: z.string(), blob: BlobRef })).optional(),
  })
  .meta({ id: "FeatureEvidence" });
export type FeatureEvidence = z.infer<typeof FeatureEvidence>;
