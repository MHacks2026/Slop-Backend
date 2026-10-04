/**
 * One build, start to finish, with no knowledge of where it came from or
 * where the results go: validate the IR, build it in Onshape, stream events,
 * return the outcome. `main.ts` wires this to Supabase; tests wire it to the
 * fake Onshape.
 */
import { hashDocument, validateDocument, type Document } from "@slop/ir";
import { buildDocument, RulePlanner, type BuildEvent, type BuildReport, type OnshapeApi, type Planner } from "@slop/onshape";

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
      log: (line) => void emit({ kind: "log", payload: { line } }),
      onEvent: (e: BuildEvent) => {
        if (e.type === "document") {
          document = e.document;
          void emit({ kind: "document", payload: { ...e.document, url: documentUrl(e.document) } });
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

export const documentUrl = (d: { did: string; wid: string; eid: string }): string => `https://cad.onshape.com/documents/${d.did}/w/${d.wid}/e/${d.eid}`;

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
    refs: r.refs.map((x) => ({ parameterId: x.parameterId, ids: x.deterministicIds, resolver: x.resolver })),
    notes: r.notes,
    reasoning: r.reasoning,
    error: r.error,
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
