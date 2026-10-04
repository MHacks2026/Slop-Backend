/**
 * Sketch arguments that point at model geometry (architecture doc §7, "sketch
 * dimensions referencing model edges"): the one intent loss the plate had.
 *
 * Before: a dimension from the hole centre to a plate edge was skipped and the
 * hole placed at fixed coordinates. Geometry checks pass, but widen the plate
 * and the hole stays put. After: the edge is resolved to an Onshape
 * deterministic id and the dimension references it live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDocument, hashDocument, type Document, type SketchFeature, type TopoRef } from "@slop/ir";
import { buildDocument } from "../src/builder.ts";
import type { BTIndividualQuery, BTMSketch, BTParameterQueryList, BTParameterString } from "../src/client/types.ts";
import type { PlaneFrame } from "../src/geometry.ts";
import type { CreateSketchOp } from "../src/plan/types.ts";
import { PlanValidationError, validateStepProposal } from "../src/plan/validate.ts";
import { ReplayPlanner } from "../src/planner/replay.ts";
import { RulePlanner } from "../src/planner/rules.ts";
import type { Feedback, Planner, StepProposal, StepRequest } from "../src/planner/types.ts";
import { renderMarkdown } from "../src/report.ts";
import { composeSketch, externalArg, parseExternalArg, SketchComposeError } from "../src/sketch/compose.ts";
import { FakeOnshape, plateWorld } from "./fake.ts";

const plate = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/plate.ir.json", import.meta.url)), "utf8")) as Document;
assertValidDocument(plate);

const sketch2 = (doc: Document = plate): SketchFeature => doc.partStudio.features.find((f) => f.id === "f3") as SketchFeature;
const param = <T>(c: { parameters: Array<{ parameterId: string }> }, id: string): T => c.parameters.find((p) => p.parameterId === id) as T;

// In the fake plate world, the top face's edges are E_top0..3 going around the
// rectangle from the origin: E_top0 lies on y = 0, E_top3 on x = 0.
const LEFT_EDGE = "E_top3";
const BOTTOM_EDGE = "E_top0";

test("locating dimensions to model edges become live external references and keep the sketch at rung exact", async () => {
  const api = new FakeOnshape(plateWorld(plate));
  const report = await buildDocument(plate, api);
  assert.equal(report.stoppedEarly, false);

  const f3 = report.features.find((f) => f.irId === "f3")!;
  assert.equal(f3.status, "built");
  assert.equal(f3.rung, "exact");
  assert.doesNotMatch(f3.notes.join("\n"), /fixed coordinates|not resolved/);

  // Each model-edge argument was resolved by geometric signature, uniquely.
  const refs = Object.fromEntries(f3.refs.map((r) => [r.parameterId, r]));
  assert.deepEqual(refs["D2@Sketch2"]!.deterministicIds, [LEFT_EDGE]);
  assert.deepEqual(refs["D3@Sketch2"]!.deterministicIds, [BOTTOM_EDGE]);
  for (const id of ["D2@Sketch2", "D3@Sketch2"]) {
    assert.equal(refs[id]!.resolver, "signature");
    assert.ok(refs[id]!.confidence > 0.99, `${id} confidence ${refs[id]!.confidence}`);
    assert.ok(refs[id]!.runnerUp! < 0.01, `${id} runner-up ${refs[id]!.runnerUp}`);
    assert.equal(refs[id]!.candidates, 12);
  }

  // The wire JSON: a DISTANCE constraint from the circle centre to an external query on the edge.
  const sk2 = api.added.find((a) => a.feature.name === "Sketch2")!.feature as BTMSketch;
  assert.deepEqual(sk2.constraints.map((c) => c.constraintType), ["DIAMETER", "DISTANCE", "DISTANCE"]);
  const [, d2, d3] = sk2.constraints;
  for (const [c, edge] of [[d2!, LEFT_EDGE], [d3!, BOTTOM_EDGE]] as const) {
    assert.equal(param<BTParameterString>(c, "localFirst").value, "c1.center");
    assert.deepEqual((param<BTParameterQueryList>(c, "externalSecond").queries[0] as BTIndividualQuery).deterministicIds, [edge]);
  }
  assert.equal(param<{ expression: string }>(d2!, "length").expression, "25 mm");
  assert.equal(param<{ expression: string }>(d3!, "length").expression, "15 mm");

  // The whole plate is now rung 1 and the report says where each edge came from.
  assert.equal(report.summary.byRung.exact, 5);
  assert.equal(report.summary.byRung.approximated, undefined);
  const md = renderMarkdown(report);
  assert.match(md, /Ref `f3\.D2@Sketch2`: \{"kind":"irRef","irFeature":"f3","path":"dimensions\[1\]\.args\[1\]"\} -> E_top3 via signature/);
  assert.match(md, /Ref `f3\.D3@Sketch2`: .* -> E_top0 via signature/);
});

test("a model-edge argument whose signature ties is surfaced to the planner instead of guessed", async () => {
  const report = await buildDocument(ambiguousPlate(), new FakeOnshape(plateWorld(plate)), { planner: new RulePlanner() });
  const f3 = report.features.find((f) => f.irId === "f3")!;
  assert.equal(f3.status, "failed");
  assert.match(f3.error!, /candidates tie/);
  assert.match(f3.error!, /dimensions\[1\]\.args\[1\]/);
  assert.equal(report.stoppedEarly, true);
});

test("the planner resolves a tie with an explicit ext:<id> argument, which is recorded and replays", async () => {
  const ir = ambiguousPlate();
  const planner = new PicksEdgeAfterTie();
  const api = new FakeOnshape(plateWorld(plate));
  const report = await buildDocument(ir, api, { planner });

  const f3 = report.features.find((f) => f.irId === "f3")!;
  assert.equal(f3.status, "built");
  assert.equal(f3.rung, "exact");
  assert.equal(f3.attempts, 2);
  assert.equal(planner.ties, 1);
  assert.match(f3.attemptLog[0]!.summary, /candidates tie/);

  // The explicit pick is on the record with its own resolver, so the report is honest about who chose.
  const d2 = f3.refs.find((r) => r.parameterId === "D2@Sketch2")!;
  assert.equal(d2.resolver, "explicit");
  assert.deepEqual(d2.deterministicIds, [LEFT_EDGE]);
  assert.deepEqual(d2.selection, { kind: "entities", ids: [LEFT_EDGE] });

  // The sketch Onshape received still references the edge live.
  const sk2 = api.added.find((a) => a.feature.name === "Sketch2")!.feature as BTMSketch;
  const ext = param<BTParameterQueryList>(sk2.constraints[1]!, "externalSecond");
  assert.deepEqual((ext.queries[0] as BTIndividualQuery).deterministicIds, [LEFT_EDGE]);

  // The accepted plan carries "ext:E_top3" and passes plan validation on replay.
  const replay = await buildDocument(ir, new FakeOnshape(plateWorld(plate)), { planner: new ReplayPlanner(report.plan, hashDocument(ir).intent) });
  assert.equal(replay.summary.failed, 0);
  assert.deepEqual(replay.features.find((f) => f.irId === "f3")!.refs.find((r) => r.parameterId === "D2@Sketch2")!.deterministicIds, [LEFT_EDGE]);
});

test("the plan schema accepts ext:<id> sketch arguments and rejects malformed ones", () => {
  const proposal = (arg: unknown) => ({
    reasoning: "test",
    ops: [
      {
        op: "createSketch",
        id: "s",
        intent: "test",
        rung: "exact",
        name: "S",
        plane: { kind: "datum", name: "TOP" },
        entities: [{ id: "c1", type: "circle", construction: false, center: [0, 0], r: 0.001 }],
        constraints: [],
        dimensions: [{ id: "D1@S", type: "distance", args: ["c1.center", arg], value: { expr: "1 mm", value: 0.001, unit: "m" }, driving: true }],
      },
    ],
  });
  assert.doesNotThrow(() => validateStepProposal(proposal("ext:JHK")));
  assert.doesNotThrow(() => validateStepProposal(proposal("ext:JHK,JHL")));
  assert.doesNotThrow(() => validateStepProposal(proposal(sketch2().dimensions[1]!.args[1])), "an IR Ref is still a valid arg");
  assert.throws(() => validateStepProposal(proposal("ext:")), PlanValidationError);
  assert.throws(() => validateStepProposal(proposal("ext:bad id")), PlanValidationError);
  assert.throws(() => validateStepProposal(proposal("JHK:ext")), PlanValidationError);
});

test("composeSketch writes ext: arguments as external queries and still refuses to guess an unresolved Ref", () => {
  const s = sketch2();
  const frame: PlaneFrame = { origin: [0, 0, 0.01], normal: [0, 0, 1], x: [1, 0, 0] };
  const base = { name: s.src.name, planeIds: ["F_cap"], frame, sourceTransform: s.transform, entities: s.entities, constraints: s.constraints, idPrefix: s.id };

  const resolved = composeSketch({
    ...base,
    dimensions: s.dimensions.map((d, i) => (i === 0 ? d : { ...d, args: [d.args[0]!, externalArg([i === 1 ? LEFT_EDGE : BOTTOM_EDGE])] })),
  });
  assert.equal(resolved.rung, "exact");
  assert.deepEqual(resolved.skipped, []);
  assert.deepEqual(resolved.notes, []);
  const d2 = resolved.feature.constraints[1]!;
  assert.equal(d2.constraintType, "DISTANCE");
  assert.deepEqual((param<BTParameterQueryList>(d2, "externalSecond").queries[0] as BTIndividualQuery).deterministicIds, [LEFT_EDGE]);

  // The raw IR Ref (what the executor receives before resolving) is never turned into a coordinate guess.
  const unresolved = composeSketch({ ...base, dimensions: s.dimensions });
  assert.equal(unresolved.rung, "approximated");
  assert.deepEqual(unresolved.skipped, [
    { kind: "dimension", id: "D2@Sketch2" },
    { kind: "dimension", id: "D3@Sketch2" },
  ]);
  assert.equal(unresolved.feature.constraints.length, 1);

  assert.deepEqual(parseExternalArg("ext:A,B"), ["A", "B"]);
  assert.equal(parseExternalArg("c1.center"), undefined);
  assert.equal(parseExternalArg(s.dimensions[1]!.args[1]!), undefined);
  assert.throws(() => parseExternalArg("ext:"), SketchComposeError);
});

// --- helpers -----------------------------------------------------------------

/**
 * The plate with Sketch2's left-edge dimension extracted badly: only the edge
 * length survived. Four edges of the plate are 30 mm long, so the signature
 * resolver cannot pick one.
 */
function ambiguousPlate(): Document {
  const ir = structuredClone(plate);
  const ref = sketch2(ir).dimensions[1]!.args[1] as TopoRef;
  ref.signature = { curve: "line", length: 0.03 };
  delete ref.probe;
  assertValidDocument(ir);
  return ir;
}

/**
 * Stands in for the LLM: proposes the direct mapping, and when the executor
 * reports a tie, reads the candidate list (which carries each edge's
 * midpoint) and picks the 30 mm edge on the x = 0 side of the top face.
 */
class PicksEdgeAfterTie implements Planner {
  readonly provenance = { planner: "claude" as const, model: "scripted", promptVersion: "test" };
  private readonly rules = new RulePlanner();
  ties = 0;

  proposeStep(req: StepRequest): Promise<StepProposal> {
    return this.rules.proposeStep(req);
  }

  async reviseStep(_req: StepRequest, previous: StepProposal, feedback: Feedback): Promise<StepProposal | undefined> {
    if (!feedback.ambiguous) return undefined;
    this.ties++;
    const { opId, selection, candidates } = feedback.ambiguous;
    const pick = candidates.find((c) => c.candidate.midpoint && Math.abs(c.candidate.midpoint[0]) < 1e-9 && Math.abs(c.candidate.midpoint[2] - 0.01) < 1e-9);
    if (!pick) return undefined;
    const path = selection.kind === "irRef" ? selection.path : "";
    const m = /dimensions\[(\d+)\]\.args\[(\d+)\]/.exec(path);
    if (!m) return undefined;
    const ops = structuredClone(previous.ops);
    const op = ops.find((o) => o.id === opId) as CreateSketchOp;
    op.dimensions[Number(m[1])]!.args[Number(m[2])] = `ext:${pick.candidate.id}`;
    return { ops, reasoning: `picked ${pick.candidate.id}: the 30 mm edge at x = 0 on the top face, which the source dimension measures from` };
  }

  proposeBehaviorTests(ir: Document) {
    return this.rules.proposeBehaviorTests(ir, []);
  }

  usage() {
    return { calls: 0, inputTokens: 0, outputTokens: 0 };
  }
}
