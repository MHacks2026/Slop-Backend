import type { Document, Parameter } from "@slop/ir";
import type { PlanStep, BehaviorTest } from "../plan/types.ts";
import { proposeDirect, ProposalError } from "../proposers/index.ts";
import type { Feedback, LlmUsage, Planner, StepProposal, StepRequest } from "./types.ts";

/**
 * Deterministic planner: one direct-mapping proposal per feature, no
 * revision. This is the offline path (tests, CI, replay-free dry runs) and
 * the baseline the LLM translator is measured against. It gives up on the
 * first failure; the whole point of the LLM planner is that it does not.
 */
export class RulePlanner implements Planner {
  readonly provenance = { planner: "rules" as const, promptVersion: "n/a" };

  async proposeStep(req: StepRequest): Promise<StepProposal> {
    const parameters: ReadonlyMap<string, Parameter> = new Map(req.ir.parameters.map((p) => [p.id, p]));
    try {
      const ops = proposeDirect(req.feature, req.context, parameters);
      return { ops, reasoning: `direct mapping of ${req.feature.op} "${req.feature.src.name}"` };
    } catch (err) {
      if (err instanceof ProposalError) throw new RulePlannerError(err.message);
      throw err;
    }
  }

  async reviseStep(_req: StepRequest, _previous: StepProposal, _feedback: Feedback): Promise<StepProposal | undefined> {
    return undefined;
  }

  /** Perturb each driving dimension by +10%; expectation is the generic one from doc §9. */
  async proposeBehaviorTests(ir: Document, _steps: PlanStep[]): Promise<BehaviorTest[]> {
    const tests: BehaviorTest[] = [];
    for (const f of ir.partStudio.features) {
      if (f.op !== "sketch") continue;
      for (const d of f.dimensions) {
        if (!d.driving || d.value.unit !== "m") continue;
        tests.push({
          target: d.id,
          expression: `${+(d.value.value * 1100).toPrecision(10)} mm`,
          expectation: "model regenerates; dependent features keep their references; volumes match the source after the same change",
        });
      }
    }
    return tests.slice(0, 10);
  }

  usage(): LlmUsage {
    return { calls: 0, inputTokens: 0, outputTokens: 0 };
  }
}

export class RulePlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulePlannerError";
  }
}
