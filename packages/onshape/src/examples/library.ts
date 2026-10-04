import type { FeatureOp } from "@slop/ir";
import { proposableOps } from "../proposers/index.ts";

/**
 * Starter example library (architecture doc §7 / §11).
 *
 * For the MVP the "validated mappings" are the direct proposers themselves.
 * The LLM retrieves them through the `propose_direct` tool. Accepted build
 * plans from real migrations get appended here later (Phase 1).
 */
export interface ExampleIndexEntry {
  sourceOp: FeatureOp;
  rung: "exact";
  notes: string;
}

export const EXAMPLE_INDEX: ExampleIndexEntry[] = [
  { sourceOp: "sketch", rung: "exact", notes: "Planar sketch: entities, common relations, driving dimensions. Args that are IR Refs to model edges/faces/vertices are resolved live and written as external references, so locating dimensions stay parametric." },
  { sourceOp: "extrude", rung: "exact", notes: "Boss/cut extrude: blind, through-all, up-to, mid-plane. Profile is a sketch region." },
  { sourceOp: "fillet", rung: "exact", notes: "Constant-radius fillet. Edges via irRef; ties come back as AmbiguousSelectionError." },
  { sourceOp: "revolve", rung: "exact", notes: "Revolve about a sketch line (sketchEntity selection), datum or model edge; FULL for 360 deg, else ONE_DIRECTION with the angle. Parameter ids unverified live." },
  { sourceOp: "chamfer", rung: "exact", notes: "Equal-distance, two-distance and distance-angle chamfers. Edges via irRef. Parameter ids unverified live." },
  { sourceOp: "shell", rung: "exact", notes: "Uniform shell; removed faces via irRef. Unverified live." },
  { sourceOp: "plane", rung: "exact", notes: "Reference plane by offset, mid-plane or angle (cPlane). Later sketches reference it as feature-output role plane. Unverified live." },
  { sourceOp: "mirror", rung: "exact", notes: "Feature mirror: seeds as a features selection, plane as datum/irRef. Unverified live." },
  { sourceOp: "linearPattern", rung: "exact", notes: "Feature pattern in one or two directions (sketch line, edge or planar face as direction). Skipped instances are not mapped. Unverified live." },
  { sourceOp: "circularPattern", rung: "exact", notes: "Feature pattern about an axis (cylindrical face, edge or sketch line). Skipped instances are not mapped. Unverified live." },
  { sourceOp: "hole", rung: "exact", notes: "Composite (rung 2): sketch of circles on the start face, each centre coincident to its position vertex, plus a cut extrude with the hole's end condition; counterbore adds a second sketch and blind cut. Countersink not mapped." },
];

export function exampleLibraryPrompt(): string {
  const listed = proposableOps().join(", ");
  return (
    `Direct-mapping proposers (call propose_direct) exist for: ${listed}.\n` +
    EXAMPLE_INDEX.map((e) => `- ${e.sourceOp} [${e.rung}]: ${e.notes}`).join("\n")
  );
}
