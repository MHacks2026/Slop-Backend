import type { Document, Feature } from "@slop/ir";
import type { Candidate } from "../fs/topology.ts";
import type { StepContext } from "../plan/executor.ts";
import type { BehaviorTest, PlanProvenance, PlanStep, Selection } from "../plan/types.ts";
import type { StepProposal } from "../plan/validate.ts";
import type { Check } from "../validate.ts";

export type { StepProposal };

/** What a planner is asked to translate. */
export interface StepRequest {
  ir: Document;
  feature: Feature;
  /** Position in the rollback order. */
  index: number;
  /** Steps already accepted for earlier features. */
  priorSteps: PlanStep[];
  /** Live, read-only view of the Onshape build so far. */
  context: StepContext;
}

/**
 * What the builder measured after executing a proposal: exactly what differs,
 * so the translator can correct itself (architecture doc §7 step 4).
 */
export interface Feedback {
  ok: boolean;
  /** Execution failures (malformed op, unresolved selection, Onshape regeneration error). */
  errors: string[];
  /** A selection with several plausible targets; the translator must pick by id. */
  ambiguous?: { opId: string; selection: Selection; candidates: Array<{ candidate: Candidate; score: number }> };
  /** Onshape's regeneration status per op that was created. */
  featureStatuses: Array<{ opId: string; onshapeFeatureId: string; status?: string }>;
  /** Level 1 checks against the source evidence. */
  checks: Check[];
  /** Entities the step created, with geometry: the candidate pool for later references. */
  created?: { faces: Candidate[]; edges: Candidate[] };
  /** Base64 PNG of the model after the step, when available. */
  image?: string;
  /** One-paragraph plain-language account for the translator. */
  summary: string;
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/**
 * The translator. Two implementations ship: `RulePlanner` (direct-mapping
 * proposers only, no LLM; the offline and CI path) and `ClaudePlanner`
 * (the architecture's LLM translator). `ReplayPlanner` replays a stored plan.
 */
export interface Planner {
  readonly provenance: PlanProvenance;
  proposeStep(req: StepRequest): Promise<StepProposal>;
  /** Return a revised proposal, or undefined to give up on this feature. */
  reviseStep(req: StepRequest, previous: StepProposal, feedback: Feedback): Promise<StepProposal | undefined>;
  proposeBehaviorTests(ir: Document, steps: PlanStep[]): Promise<BehaviorTest[]>;
  usage(): LlmUsage;
}
