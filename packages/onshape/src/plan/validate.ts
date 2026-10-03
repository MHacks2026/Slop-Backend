import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { behaviorTestsSchema, stepProposalSchema } from "./schema.ts";
import type { BehaviorTest, Op } from "./types.ts";

export interface StepProposal {
  ops: Op[];
  reasoning: string;
}

let stepFn: ValidateFunction | undefined;
let testsFn: ValidateFunction | undefined;

function ajv() {
  const a = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(a);
  return a;
}

export class PlanValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid step proposal:\n${issues.map((i) => `  ${i}`).join("\n")}`);
    this.name = "PlanValidationError";
  }
}

/** Validates an LLM (or replayed) step proposal against the plan schema. */
export function validateStepProposal(value: unknown): StepProposal {
  stepFn ??= ajv().compile(stepProposalSchema);
  if (!stepFn(value)) {
    throw new PlanValidationError((stepFn.errors ?? []).map((e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"} ${JSON.stringify(e.params)}`));
  }
  const proposal = value as StepProposal;
  const ids = new Set<string>();
  const issues: string[] = [];
  for (const op of proposal.ops) {
    if (ids.has(op.id)) issues.push(`/ops: duplicate op id "${op.id}"`);
    ids.add(op.id);
  }
  if (issues.length) throw new PlanValidationError(issues);
  return proposal;
}

export function validateBehaviorTests(value: unknown): BehaviorTest[] {
  testsFn ??= ajv().compile(behaviorTestsSchema);
  if (!testsFn(value)) {
    throw new PlanValidationError((testsFn.errors ?? []).map((e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`));
  }
  return (value as { tests: BehaviorTest[] }).tests;
}
