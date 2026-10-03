/**
 * The build plan: typed operations the translator writes and the executor
 * carries out in Onshape (architecture doc §7, "What the LLM produces").
 *
 * The plan is the contract between the LLM and deterministic code. The LLM
 * never emits Onshape wire JSON; it emits these ops, which are validated
 * against `plan/schema.ts` before anything is sent. Every op carries the
 * translator's stated intent so reviewers can read why it chose what it did.
 */
import type { Constraint, Dimension, Rung, SketchEntity } from "@slop/ir";

export const PLAN_VERSION = "0.1.0";

/** How an op points at something in the Onshape model. */
export type Selection =
  /** A SolidWorks default plane, remapped to Onshape's. */
  | { kind: "datum"; name: "FRONT" | "TOP" | "RIGHT" }
  /** The Part Studio origin vertex. */
  | { kind: "origin" }
  /** All regions of a sketch created earlier in the plan. */
  | { kind: "sketchRegion"; sketch: string }
  /** Resolve the IR `Ref` at `irFeature`.`path` with the resolver cascade. Fails as ambiguous if candidates tie. */
  | { kind: "irRef"; irFeature: string; path: string }
  /** Deterministic ids the translator saw in feedback or topology listings. The explicit pick for ties. */
  | { kind: "entities"; ids: string[] }
  /** Everything of one entity type created by an earlier plan feature, optionally narrowed by a predicate. */
  | { kind: "createdBy"; feature: string; entity: "face" | "edge" | "vertex"; where?: EntityPredicate };

export interface EntityPredicate {
  /** Surface or curve type, lower-case: plane, cylinder, line, circle, ... */
  type?: string;
  /** Plane normal or curve axis within angular tolerance. */
  normal?: [number, number, number];
  /** Signed plane offset along `normal` (m). */
  offset?: number;
  radius?: number;
  /** Point on or near the entity (m). */
  near?: [number, number, number];
}

export type ParameterValue =
  | { id: string; quantity: string }
  | { id: string; enum: { name: string; value: string } }
  | { id: string; boolean: boolean }
  | { id: string; string: string }
  | { id: string; selections: Selection[] };

interface OpBase {
  /** Plan-unique id; later ops refer to this feature by it. */
  id: string;
  /** Why the translator chose this. Shown in the report. */
  intent: string;
  /** Fidelity rung this op realises for its IR feature. */
  rung: Rung;
  /** Intent the source never encoded (a centering relation, an equation). Listed separately in the report. */
  enhancement?: boolean;
}

export interface CreateVariableOp extends OpBase {
  op: "createVariable";
  name: string;
  expression: string;
}

export interface CreateSketchOp extends OpBase {
  op: "createSketch";
  name: string;
  plane: Selection;
  /**
   * IR sketch whose frame the 2D coordinates below are in. When set, the
   * executor projects IR coordinates through the Onshape plane frame; when
   * absent, coordinates are taken directly in Onshape's plane frame.
   */
  irSketch?: string;
  entities: SketchEntity[];
  constraints: Constraint[];
  dimensions: Dimension[];
}

export interface CreateFeatureOp extends OpBase {
  op: "createFeature";
  name: string;
  /** Onshape featureType: extrude, revolve, fillet, chamfer, shell, hole, linearPattern, mirror, cPlane, ... */
  featureType: string;
  parameters: ParameterValue[];
}

export interface InsertCustomFeatureOp extends OpBase {
  op: "insertCustomFeature";
  name: string;
  /** Feature Studio holding the FeatureScript: "e<elementId>::m<microversionId>" (rung 3). */
  namespace: string;
  featureType: string;
  parameters: ParameterValue[];
}

export interface GeometryPatchOp extends OpBase {
  op: "geometryPatch";
  name: string;
  /** Blob hashes of before/after B-reps in the evidence store (rung 5). */
  brepBefore: string;
  brepAfter: string;
}

export type Op = CreateVariableOp | CreateSketchOp | CreateFeatureOp | InsertCustomFeatureOp | GeometryPatchOp;

/** One IR feature's worth of ops, as finally accepted. */
export interface PlanStep {
  irFeature: string;
  ops: Op[];
  /** The translator's reasoning, verbatim. */
  reasoning?: string;
  attempts: number;
}

export interface BehaviorTest {
  /** IR dimension or parameter id to perturb. */
  target: string;
  /** New expression, e.g. "60 mm". */
  expression: string;
  /** What should hold if intent survived. */
  expectation: string;
}

export interface PlanProvenance {
  planner: "claude" | "rules" | "replay";
  model?: string;
  promptVersion?: string;
}

/** Stored with the IR commit so a migration can be replayed without asking the LLM again. */
export interface BuildPlan {
  planVersion: typeof PLAN_VERSION;
  irIntentHash: string;
  provenance: PlanProvenance;
  steps: PlanStep[];
  behaviorTests: BehaviorTest[];
}
