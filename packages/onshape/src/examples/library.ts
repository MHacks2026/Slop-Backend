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
];

export function exampleLibraryPrompt(): string {
  const listed = proposableOps().join(", ");
  return (
    `Direct-mapping proposers (call propose_direct) exist for: ${listed}.\n` +
    EXAMPLE_INDEX.map((e) => `- ${e.sourceOp} [${e.rung}]: ${e.notes}`).join("\n")
  );
}
