/**
 * One build, start to finish, with no knowledge of where it came from or
 * where the results go: validate the IR, build it in Onshape, stream events,
 * return the outcome. `main.ts` wires this to Supabase; tests wire it to the
 * fake Onshape.
 */
import { hashDocument, validateDocument, type Document } from "@slop/ir";
import { buildDocument, RulePlanner, type AttemptOutcome, type BuildEvent, type BuildReport, type DocumentRef, type OnshapeApi, type Planner } from "@slop/onshape";

export type PlannerName = "rules" | "claude";

export interface BuildInput {
  id: string;
  name: string;
  planner: PlannerName | string;
  ir: unknown;
}

/** What the runner records as progress. `finished` is always last. */
export type RunEvent =
  | { kind: "log"; payload: { line: string } }
  | { kind: "document"; payload: { did: string; wid: string; eid: string; url: string } }
  | { kind: "featureStart"; payload: { index: number; total: number; irId: string; name: string; op: string } }
  | { kind: "attempt"; payload: { index: number; total: number; irId: string; n: number; outcome: AttemptOutcome } & Record<string, unknown> }
  | { kind: "feature"; payload: { index: number; total: number } & Record<string, unknown> }
  | { kind: "behavior"; payload: { index: number; total: number } & Record<string, unknown> }
  | { kind: "finished"; payload: { status: "succeeded" | "failed"; error?: string; summary?: unknown } };

export interface RunOutcome {
  status: "succeeded" | "failed";
  error?: string;
  irIntentHash?: string;
  document?: { did: string; wid: string; eid: string };
  report?: BuildReport;
}

export interface RunDeps {
  api: OnshapeApi;
  /** Creates the planner for a build, or throws when it cannot (e.g. no LLM key). */
  planner: (name: string, ir: Document) => Planner;
  emit: (event: RunEvent) => Promise<void> | void;
  /** Behaviour tests on by default; tests and dry runs may switch them off. */
  behavior?: boolean;
  /** Build into this Part Studio instead of creating a document. */
  target?: DocumentRef;
  /** Base of the document link in `document` events. Default https://cad.onshape.com. */
  baseUrl?: string;
}

export async function runBuild(build: BuildInput, deps: RunDeps): Promise<RunOutcome> {
  const emit = async (e: RunEvent) => {
    try {
      await deps.emit(e);
    } catch (err) {
      // Progress reporting must never take the build down.
      console.error(`event not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const finish = async (outcome: RunOutcome): Promise<RunOutcome> => {
    await emit({ kind: "finished", payload: { status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.report ? { summary: outcome.report.summary } : {}) } });
    return outcome;
  };

  const validation = validateDocument(build.ir);
  if (!validation.ok) {
    const issues = [...validation.schema, ...validation.structure].slice(0, 20).map((i) => `${i.path}: ${i.message}`);
    return finish({ status: "failed", error: `invalid IR document:\n${issues.join("\n")}` });
  }
  const ir = build.ir as Document;
  const irIntentHash = hashDocument(ir).intent;

  let planner: Planner;
  try {
    planner = deps.planner(build.planner, ir);
  } catch (err) {
    return finish({ status: "failed", irIntentHash, error: err instanceof Error ? err.message : String(err) });
  }

  let document: RunOutcome["document"];
  try {
    const report = await buildDocument(ir, deps.api, {
      planner,
      name: build.name,
      ...(deps.behavior === false ? { behavior: false } : {}),
      ...(deps.target ? { target: deps.target } : {}),
      log: (line) => void emit({ kind: "log", payload: { line } }),
      onEvent: (e: BuildEvent) => {
        if (e.type === "document") {
          document = e.document;
          void emit({ kind: "document", payload: { ...e.document, url: documentUrl(e.document, deps.baseUrl) } });
        } else if (e.type === "featureStart") {
          void emit({ kind: "featureStart", payload: { index: e.index, total: e.total, irId: e.irId, name: e.name, op: e.op } });
        } else if (e.type === "attempt") {
          void emit({ kind: "attempt", payload: { index: e.index, total: e.total, irId: e.irId, outcome: e.outcome, ...attemptSummary(e.attempt) } });
        } else if (e.type === "feature") {
          void emit({ kind: "feature", payload: { index: e.index, total: e.total, ...featureSummary(e.record) } });
        } else {
          void emit({ kind: "behavior", payload: { index: e.index, total: e.total, ...behaviorSummary(e.result) } });
        }
      },
    });
    const failed = report.stoppedEarly || report.summary.failed > 0;
    const error = failed ? report.features.find((f) => f.status === "failed")?.error ?? "build stopped early" : undefined;
    return finish({ status: failed ? "failed" : "succeeded", irIntentHash, ...(document ? { document } : {}), report, ...(error ? { error } : {}) });
  } catch (err) {
    return finish({ status: "failed", irIntentHash, ...(document ? { document } : {}), error: err instanceof Error ? err.message : String(err) });
  }
}

export const documentUrl = (d: { did: string; wid: string; eid: string }, baseUrl = "https://cad.onshape.com"): string =>
  `${baseUrl.replace(/\/+$/, "")}/documents/${d.did}/w/${d.wid}/e/${d.eid}`;

/** The per-feature record without the attempt log's bulk; enough for a progress row. */
function featureSummary(r: BuildReport["features"][number]): Record<string, unknown> {
  return {
    irId: r.irId,
    name: r.srcName,
    op: r.op,
    status: r.status,
    rung: r.rung,
    attempts: r.attempts,
    onshapeFeatureId: r.onshapeFeatureId,
    checksPassed: r.checks.filter((c) => c.pass).length,
    checksTotal: r.checks.length,
    checks: r.checks.map(checkSummary),
    deviation: r.deviation,
    refs: r.refs.map((x) => ({ parameterId: x.parameterId, ids: x.deterministicIds, resolver: x.resolver, confidence: x.confidence })),
    notes: r.notes,
    reasoning: r.reasoning,
    error: r.error,
  };
}

/** A Level 1 comparison, for a UI table: SolidWorks value, Onshape value, verdict. */
function checkSummary(c: BuildReport["features"][number]["checks"][number]): Record<string, unknown> {
  return { name: c.name, expected: c.expected, actual: c.actual, pass: c.pass, ...(c.advisory ? { advisory: true } : {}), ...(c.error !== undefined ? { error: c.error } : {}) };
}

/** One propose/execute/measure cycle: what the planner tried and what came back. */
function attemptSummary(a: BuildReport["features"][number]["attemptLog"][number]): { n: number } & Record<string, unknown> {
  return {
    n: a.n,
    summary: a.summary,
    reasoning: a.reasoning,
    errors: a.errors.slice(0, 10),
    checksPassed: a.checks.filter((c) => c.pass || c.advisory).length,
    checksTotal: a.checks.length,
  };
}

function behaviorSummary(b: BuildReport["behavior"][number]): Record<string, unknown> {
  return {
    target: b.target,
    expression: b.expression,
    status: b.status,
    verified: b.verified,
    restored: b.restored,
    checksPassed: b.checks.filter((c) => c.pass).length,
    checksTotal: b.checks.length,
    failing: b.checks.filter((c) => !c.pass && !c.advisory).map((c) => ({ name: c.name, expected: c.expected, actual: c.actual })),
    featureErrors: b.featureErrors,
    error: b.error,
  };
}

/** The planner factory used by the real runner; tests supply their own. */
export function defaultPlanner(loadClaude: () => { apiKey: string; model: string; baseUrl: string }, ClaudePlannerCtor: new (cfg: { apiKey: string; model?: string; baseUrl?: string }) => Planner) {
  return (name: string): Planner => {
    if (name === "rules") return new RulePlanner();
    if (name === "claude") {
      const cfg = loadClaude();
      return new ClaudePlannerCtor({ apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl });
    }
    throw new Error(`unknown planner "${name}" (rules | claude)`);
  };
}
