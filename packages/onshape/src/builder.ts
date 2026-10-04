import { hashDocument, type Document, type FeatureOp, type Rung } from "@slop/ir";
import { normalizeExpression, runBehaviorTests, type BehaviorCase, type BehaviorResult } from "./behavior.ts";
import type { OnshapeApi } from "./client/api.ts";
import type { DocumentRef } from "./client/types.ts";
import { queryBodyStats } from "./fs/topology.ts";
import { AmbiguousSelectionError, DATUM_REMAP, ExecutionError, Executor, type SelectionRecord } from "./plan/executor.ts";
import type { BehaviorTest, BuildPlan, PlanStep } from "./plan/types.ts";
import { PlanValidationError, validateStepProposal } from "./plan/validate.ts";
import { RulePlanner } from "./planner/rules.ts";
import type { Feedback, Planner, StepProposal, StepRequest } from "./planner/types.ts";
import { DEFAULT_TOLERANCES, hardFailures, level1Checks, type Check, type Tolerances } from "./validate.ts";
import type { ResolveOptions } from "./resolver.ts";

export { DATUM_REMAP };

/** Ops whose result is a solid body and so carry evidence worth checking. */
const SOLID_OPS = new Set<FeatureOp>(["extrude", "revolve", "fillet", "chamfer", "hole", "shell", "linearPattern", "circularPattern", "mirror"]);

export interface BuildOptions {
  name?: string;
  target?: DocumentRef;
  tolerances?: Tolerances;
  resolver?: ResolveOptions;
  /** Stop at the first feature that cannot be made to pass. Default true. */
  stopOnDivergence?: boolean;
  bodyStats?: boolean;
  /**
   * Who writes the plan. Default is `RulePlanner` (direct mappings, no LLM).
   * Pass `ClaudePlanner` for the architecture's translator, or `ReplayPlanner`
   * to re-run an accepted plan without asking anyone.
   */
  planner?: Planner;
  /** Propose/execute/measure cycles per feature. Default 4. */
  maxAttempts?: number;
  /** Ask Onshape for a shaded view after each accepted solid (costs an API call). */
  captureView?: boolean;
  /**
   * Run Level 3 behaviour tests after a complete build: change each driving
   * dimension in Onshape, measure, restore (architecture doc §9). Default true.
   */
  behavior?: boolean;
  log?: (line: string) => void;
  /** Structured progress, in order: the document, each feature as it finishes, each behaviour test. */
  onEvent?: (event: BuildEvent) => void;
}

/** Progress a caller can stream to a UI while a build runs. */
export type BuildEvent =
  | { type: "document"; document: DocumentRef }
  | { type: "feature"; index: number; total: number; record: FeatureRecord }
  | { type: "behavior"; index: number; total: number; result: BehaviorResult };

export interface AttemptRecord {
  n: number;
  reasoning: string;
  errors: string[];
  checks: Check[];
  summary: string;
}

export interface FeatureRecord {
  irId: string;
  srcName: string;
  op: FeatureOp;
  status: "built" | "failed" | "skipped";
  rung: Rung;
  onshapeFeatureId?: string;
  featureStatus?: string;
  notes: string[];
  refs: SelectionRecord[];
  checks: Check[];
  attempts: number;
  reasoning?: string;
  enhancements: string[];
  attemptLog: AttemptRecord[];
  error?: string;
}

export interface BuildReport {
  document: DocumentRef;
  irIntentHash: string;
  startedAt: string;
  finishedAt: string;
  apiCalls: number;
  stoppedEarly: boolean;
  features: FeatureRecord[];
  /** The accepted plan: store this and replay it to reproduce the migration. */
  plan: BuildPlan;
  /** Level 3 results; empty when the build stopped early or behaviour tests were disabled. */
  behavior: BehaviorResult[];
  summary: {
    byRung: Partial<Record<Rung, number>>;
    built: number;
    failed: number;
    skipped: number;
    checksPassed: number;
    checksFailed: number;
    enhancements: number;
    behaviorPassed: number;
    /** Failed comparisons plus regeneration failures. */
    behaviorFailed: number;
    /** Ran without source evidence, or could not be run. */
    behaviorUnverified: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Per-feature propose → execute → measure → (revise) loop (architecture doc §7).
 *
 * The planner decides. This function only: runs the ops, measures them against
 * SolidWorks evidence, and hands the difference back. It never marks a failed
 * measurement as passed.
 */
export async function buildDocument(ir: Document, api: OnshapeApi, options: BuildOptions = {}): Promise<BuildReport> {
  const log = options.log ?? (() => {});
  const planner = options.planner ?? new RulePlanner();
  const maxAttempts = options.maxAttempts ?? 4;
  const startedAt = new Date().toISOString();
  const callsBefore = api.callCount();
  const irIntentHash = hashDocument(ir).intent;
  const ref = options.target ?? (await api.createDocument(options.name ?? ir.partStudio.name));
  log(`document ${ref.did} workspace ${ref.wid} part studio ${ref.eid} planner=${planner.provenance.planner}`);
  options.onEvent?.({ type: "document", document: ref });
  const total = ir.partStudio.features.length;

  const executor = new Executor(ir, api, ref, options.resolver ?? {});
  const records: FeatureRecord[] = [];
  const steps: PlanStep[] = [];
  let stoppedEarly = false;

  for (const [index, f] of ir.partStudio.features.entries()) {
    const rec: FeatureRecord = {
      irId: f.id,
      srcName: f.src.name,
      op: f.op,
      status: "built",
      rung: "pending",
      notes: [],
      refs: [],
      checks: [],
      attempts: 0,
      enhancements: [],
      attemptLog: [],
    };
    records.push(rec);

    if (f.suppressed) {
      rec.status = "skipped";
      rec.rung = "exact";
      rec.notes.push("suppressed in source; not created");
      options.onEvent?.({ type: "feature", index, total, record: rec });
      continue;
    }

    const req: StepRequest = { ir, feature: f, index, priorSteps: steps, context: executor };
    let proposal: StepProposal | undefined;
    try {
      proposal = await planner.proposeStep(req);
    } catch (err) {
      rec.status = "failed";
      rec.rung = "dropped";
      rec.error = err instanceof Error ? err.message : String(err);
      log(`${f.src.name}: FAILED to propose: ${rec.error}`);
      if (options.stopOnDivergence !== false) {
        stoppedEarly = true;
        break;
      }
      continue;
    }

    let accepted: PlanStep | undefined;
    for (let n = 1; n <= maxAttempts; n++) {
      rec.attempts = n;
      if (!proposal) break;

      let checked: StepProposal;
      try {
        checked = validateStepProposal(proposal);
      } catch (err) {
        const issues = err instanceof PlanValidationError ? err.issues : [err instanceof Error ? err.message : String(err)];
        const feedback = feedbackFromErrors(issues, "plan failed schema validation");
        rec.attemptLog.push({ n, reasoning: proposal.reasoning, errors: issues, checks: [], summary: feedback.summary });
        log(`${f.src.name}: attempt ${n} invalid plan: ${issues[0]}`);
        proposal = await planner.reviseStep(req, proposal, feedback);
        continue;
      }

      const execution = await executor.run(checked.ops);
      if (execution.error) {
        await executor.undo(execution);
        const feedback = feedbackFromExecution(execution.error);
        rec.attemptLog.push({ n, reasoning: checked.reasoning, errors: feedback.errors, checks: [], summary: feedback.summary });
        log(`${f.src.name}: attempt ${n} exec failed: ${feedback.summary}`);
        proposal = await planner.reviseStep(req, checked, feedback);
        continue;
      }

      const last = execution.results.at(-1);
      rec.onshapeFeatureId = last?.onshapeFeatureId;
      rec.featureStatus = last?.featureStatus;
      rec.notes = execution.results.flatMap((r) => r.notes);
      rec.refs = execution.results.flatMap((r) => r.selections);
      // The planner's rung is a claim; the executor reports what it could realise. Keep the worse of the two.
      const claimed = worstRung(checked.ops.map((o) => o.rung));
      const achieved = worstRung(execution.results.flatMap((r) => (r.achievedRung ? [r.achievedRung] : [])));
      rec.rung = worstRung([claimed, achieved]);
      if (rec.rung !== claimed) rec.notes.push(`planner claimed rung "${claimed}" but the executor realised "${rec.rung}"`);
      rec.enhancements = checked.ops.filter((o) => o.enhancement).map((o) => o.intent);
      rec.reasoning = checked.reasoning;

      let checks: Check[] = [];
      if (f.evidence && SOLID_OPS.has(f.op)) {
        const mass = await api.massProperties(ref);
        const stats = options.bodyStats === false ? undefined : await queryBodyStats(api, ref);
        checks = level1Checks(f.evidence, mass, stats, options.tolerances ?? DEFAULT_TOLERANCES);
        rec.checks = checks;
        for (const c of checks) log(`  ${c.pass ? "ok  " : c.advisory ? "warn" : "FAIL"} ${c.name}: expected ${c.expected}, got ${c.actual}`);
      }

      const failed = hardFailures(checks);
      if (failed.length) {
        await executor.undo(execution);
        rec.onshapeFeatureId = undefined;
        rec.featureStatus = undefined;
        const feedback = feedbackFromChecks(checks, execution);
        rec.attemptLog.push({ n, reasoning: checked.reasoning, errors: feedback.errors, checks, summary: feedback.summary });
        log(`${f.src.name}: attempt ${n} ${feedback.summary}`);
        proposal = await planner.reviseStep(req, checked, feedback);
        continue;
      }

      const opIds = execution.results.map((r) => r.opId);
      executor.accept(f.id, opIds);
      accepted = { irFeature: f.id, ops: checked.ops, reasoning: checked.reasoning, attempts: n };
      rec.attemptLog.push({ n, reasoning: checked.reasoning, errors: [], checks, summary: "accepted" });
      log(`${f.src.name}: ${f.op} -> ${rec.onshapeFeatureId ?? "?"} [${rec.featureStatus ?? "?"}] rung=${rec.rung} attempts=${n}`);

      if (options.captureView && api.shadedView) {
        try {
          await api.shadedView(ref);
        } catch {
          /* view is optional feedback, not a build failure */
        }
      }
      break;
    }

    if (!accepted) {
      rec.status = "failed";
      rec.error ??= rec.attemptLog.at(-1)?.summary ?? "translator gave up";
      rec.rung = rec.rung === "pending" ? "dropped" : rec.rung;
      log(`${f.src.name}: FAILED ${rec.error}`);
      options.onEvent?.({ type: "feature", index, total, record: rec });
      if (options.stopOnDivergence !== false) {
        stoppedEarly = true;
        break;
      }
      continue;
    }
    steps.push(accepted);
    options.onEvent?.({ type: "feature", index, total, record: rec });
  }

  const behaviorTests = stoppedEarly ? [] : await planner.proposeBehaviorTests(ir, steps);

  // Level 3: only on a complete build, and only against the document as built.
  let behavior: BehaviorResult[] = [];
  if (!stoppedEarly && options.behavior !== false) {
    const nominal = [...ir.partStudio.features].reverse().find((f) => f.evidence)?.evidence;
    const cases = behaviorCases(ir, behaviorTests);
    behavior = await runBehaviorTests(api, ref, cases, nominal, {
      ...(options.tolerances ? { tolerances: options.tolerances } : {}),
      ...(options.bodyStats === false ? { bodyStats: false } : {}),
      log,
      onResult: (result, index) => options.onEvent?.({ type: "behavior", index, total: cases.length, result }),
    });
  }

  const usage = planner.usage();
  const summary = summarize(records);
  return {
    document: ref,
    irIntentHash,
    startedAt,
    finishedAt: new Date().toISOString(),
    apiCalls: api.callCount() - callsBefore,
    stoppedEarly,
    features: records,
    plan: {
      planVersion: "0.1.0",
      irIntentHash,
      provenance: planner.provenance,
      steps,
      behaviorTests,
    },
    behavior,
    summary: {
      ...summary,
      behaviorPassed: behavior.filter((b) => b.status === "passed").length,
      behaviorFailed: behavior.filter((b) => b.status === "failed" || b.status === "regenerationFailed").length,
      behaviorUnverified: behavior.filter((b) => b.status === "unverified" || b.status === "unsupported").length,
      llmCalls: usage.calls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}

/**
 * What to perturb: every change the extractor recorded source evidence for
 * (verified), then the planner's proposals not already covered (unverified:
 * they prove regeneration, not equivalence).
 */
function behaviorCases(ir: Document, proposals: BehaviorTest[]): BehaviorCase[] {
  const cases: BehaviorCase[] = (ir.behaviorEvidence ?? []).map((b) => ({
    target: b.target,
    expression: b.expression,
    expectation: b.expectation ?? "regenerates; Level 1 metrics match the source after the same change",
    evidence: b.evidence,
  }));
  const seen = new Set(cases.map((c) => `${c.target}=${normalizeExpression(c.expression)}`));
  for (const t of proposals) {
    const key = `${t.target}=${normalizeExpression(t.expression)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push(t);
  }
  return cases;
}

function feedbackFromErrors(errors: string[], summary: string): Feedback {
  return { ok: false, errors, featureStatuses: [], checks: [], summary };
}

function feedbackFromExecution(err: ExecutionError | AmbiguousSelectionError): Feedback {
  if (err instanceof AmbiguousSelectionError) {
    return {
      ok: false,
      errors: [err.message],
      ambiguous: { opId: err.opId, selection: err.selection, candidates: err.ranked.map((r) => ({ candidate: r.candidate, score: r.score })) },
      featureStatuses: [],
      checks: [],
      summary: err.message,
    };
  }
  return { ok: false, errors: [err.message], featureStatuses: [], checks: [], summary: err.message };
}

function feedbackFromChecks(checks: Check[], execution: { results: Array<{ opId: string; onshapeFeatureId: string; featureStatus?: string }> }): Feedback {
  const failed = hardFailures(checks);
  return {
    ok: false,
    errors: failed.map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`),
    featureStatuses: execution.results.map((r) => ({ opId: r.opId, onshapeFeatureId: r.onshapeFeatureId, status: r.featureStatus })),
    checks,
    summary: `Level 1 divergence: ${failed.map((c) => c.name).join(", ")}`,
  };
}

const ORDER: Rung[] = ["pending", "exact", "composite", "featurescript", "approximated", "geometry", "dropped"];
function worstRung(rungs: Rung[]): Rung {
  return rungs.reduce((a, b) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b), "exact");
}

function summarize(records: FeatureRecord[]) {
  const byRung: Partial<Record<Rung, number>> = {};
  let built = 0,
    failed = 0,
    skipped = 0,
    checksPassed = 0,
    checksFailed = 0,
    enhancements = 0;
  for (const r of records) {
    byRung[r.rung] = (byRung[r.rung] ?? 0) + 1;
    if (r.status === "built") built++;
    else if (r.status === "failed") failed++;
    else skipped++;
    enhancements += r.enhancements.length;
    for (const c of r.checks) {
      if (c.pass || c.advisory) checksPassed++;
      else checksFailed++;
    }
  }
  return { byRung, built, failed, skipped, checksPassed, checksFailed, enhancements };
}
