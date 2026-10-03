import type { Document } from "@slop/ir";
import type { BehaviorTest, BuildPlan, PlanStep } from "../plan/types.ts";
import { validateStepProposal } from "../plan/validate.ts";
import type { Feedback, LlmUsage, Planner, StepProposal, StepRequest } from "./types.ts";

/**
 * Replays an accepted plan (architecture doc §7, "Consistency and cost"):
 * the same ops are executed again without asking the LLM, so a migration is
 * reproducible. Fails loudly if the IR changed since the plan was accepted.
 */
export class ReplayPlanner implements Planner {
  readonly provenance;
  private readonly byFeature = new Map<string, PlanStep>();

  constructor(
    private readonly plan: BuildPlan,
    irIntentHash: string,
  ) {
    if (plan.irIntentHash !== irIntentHash) {
      throw new Error(`plan was accepted for IR ${plan.irIntentHash.slice(0, 12)}…, current IR is ${irIntentHash.slice(0, 12)}…`);
    }
    this.provenance = { ...plan.provenance, planner: "replay" as const };
    for (const s of plan.steps) this.byFeature.set(s.irFeature, s);
  }

  async proposeStep(req: StepRequest): Promise<StepProposal> {
    const step = this.byFeature.get(req.feature.id);
    if (!step) throw new Error(`stored plan has no step for feature ${req.feature.id}`);
    return validateStepProposal({ ops: step.ops, reasoning: step.reasoning ?? "replayed" });
  }

  async reviseStep(): Promise<StepProposal | undefined> {
    return undefined;
  }

  async proposeBehaviorTests(_ir: Document, _steps: PlanStep[]): Promise<BehaviorTest[]> {
    return this.plan.behaviorTests;
  }

  usage(): LlmUsage {
    return { calls: 0, inputTokens: 0, outputTokens: 0 };
  }

  /** A per-feature failure in replay is a regression; surface it. */
  static describeFeedback(f: Feedback): string {
    return f.summary;
  }
}
