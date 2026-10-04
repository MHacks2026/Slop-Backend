import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDocument, hashDocument, type Document } from "@slop/ir";
import { buildDocument } from "../src/builder.ts";
import type { BTMFeature, BTMSketch, BTParameterBoolean, BTParameterQueryList, BTIndividualQuery } from "../src/client/types.ts";
import type { CreateFeatureOp } from "../src/plan/types.ts";
import { ReplayPlanner } from "../src/planner/replay.ts";
import { RulePlanner } from "../src/planner/rules.ts";
import type { Planner, StepProposal, StepRequest } from "../src/planner/types.ts";
import { proposeDirect } from "../src/proposers/index.ts";
import { renderMarkdown } from "../src/report.ts";
import { FakeOnshape, plateWorld } from "./fake.ts";

const plate = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/plate.ir.json", import.meta.url)), "utf8")) as Document;
assertValidDocument(plate);

const param = <T>(f: BTMFeature | BTMSketch, id: string): T => f.parameters.find((p) => p.parameterId === id) as T;

test("plate builds end to end against the fake with all Level 1 checks passing", async () => {
  const api = new FakeOnshape(plateWorld(plate));
  const report = await buildDocument(plate, api);

  assert.equal(report.stoppedEarly, false);
  assert.deepEqual(
    report.features.map((f) => [f.irId, f.status, f.rung, f.attempts]),
    [
      ["f1", "built", "exact", 1],
      ["f2", "built", "exact", 1],
      ["f3", "built", "approximated", 1],
      ["f4", "built", "exact", 1],
      ["f5", "built", "exact", 1],
    ],
  );
  assert.equal(report.summary.checksFailed, 0);
  assert.ok(report.summary.checksPassed > 0);
  assert.equal(report.apiCalls, api.callCount());
  assert.equal(report.plan.steps.length, 5);
  assert.equal(report.plan.provenance.planner, "rules");
  assert.ok(report.plan.behaviorTests.length > 0);

  const f3 = report.features[2]!;
  assert.deepEqual(f3.refs[0]!.deterministicIds, ["F_cap"]);
  assert.equal(f3.refs[0]!.resolver, "signature");
  assert.match(f3.notes.join("\n"), /D2@Sketch2 references model geometry/);

  const f5 = report.features[4]!;
  assert.deepEqual(f5.refs[0]!.deterministicIds, ["E_hole_top"]);
  assert.equal(f5.refs[0]!.candidates, 2);
  assert.ok(f5.refs[0]!.runnerUp! < 0.1);

  const [sk1, ext, sk2, cut, fillet] = api.added.map((a) => a.feature) as [BTMSketch, BTMFeature, BTMSketch, BTMFeature, BTMFeature];
  assert.equal(param<BTParameterBoolean>(ext, "oppositeDirection").value, false);
  assert.equal(param<BTParameterBoolean>(cut, "oppositeDirection").value, true);
  assert.equal(param<BTParameterQueryList>(cut, "entities").queries[0]!.btType, "BTMIndividualSketchRegionQuery-140");
  assert.deepEqual((param<BTParameterQueryList>(fillet, "entities").queries[0] as BTIndividualQuery).deterministicIds, ["E_hole_top"]);
  assert.deepEqual((param<BTParameterQueryList>(sk1, "sketchPlane").queries[0] as BTIndividualQuery).deterministicIds, ["JCC"]);
  assert.equal(sk1.entities.length, 4);
  assert.equal(sk1.constraints.length, 9 + 2);
  assert.ok(sk1.constraints.find((c) => c.parameters.some((p) => p.parameterId === "externalSecond")));

  const circle = sk2.entities[0]!;
  assert.equal(circle.btType, "BTMSketchCurve-4");
  if (circle.btType === "BTMSketchCurve-4") {
    // Onshape sketch frames originate at the projected world origin (verified live), so the hole keeps its
    // model position; the fake's cap frame has x = +Y, so model (0.025, 0.015) is local (0.015, -0.025).
    assert.ok(Math.abs(circle.geometry.xCenter - 0.015) < 1e-12 && Math.abs(circle.geometry.yCenter + 0.025) < 1e-12);
    assert.equal(circle.geometry.radius, 0.0025);
  }

  const md = renderMarkdown(report);
  assert.match(md, /\| 5 \| Fillet1 \| fillet \| exact \| built \(OK\) \| 1 \| F5 \|/);
  assert.match(md, /Planner: rules/);
});

test("Level 1 divergence stops the build at the offending feature", async () => {
  const api = new FakeOnshape(plateWorld(plate), {
    massProperties: (name, ev) =>
      ev ? { hasMass: true, volume: [name === "Cut-Extrude1" ? ev.volume * 1.01 : ev.volume], periphery: [ev.area], centroid: [...(ev.centerOfMass ?? [0, 0, 0])] } : undefined,
  });
  const report = await buildDocument(plate, api);
  assert.equal(report.stoppedEarly, true);
  assert.equal(report.features.length, 4);
  assert.equal(report.features[3]!.status, "failed");
  assert.match(report.features[3]!.error!, /Level 1 divergence: volume/);
  assert.equal(report.plan.steps.length, 3);
});

test("an unmapped op is recorded as dropped and later features are not attempted", async () => {
  const ir = structuredClone(plate);
  ir.partStudio.features.splice(4, 0, {
    id: "f4b",
    src: { name: "Chamfer1" },
    op: "chamfer",
    suppressed: false,
    fidelity: { rung: "pending" },
    spec: { type: "equalDistance", distance: { expr: "1 mm", value: 0.001, unit: "m" } },
    edges: [{ kind: "topo", entity: "edge", createdBy: "f4" }],
    tangentPropagation: true,
  });
  ir.partStudio.features[5] = { ...ir.partStudio.features[5]!, edges: [{ kind: "topo", entity: "edge", createdBy: "f4b" }] } as typeof ir.partStudio.features[5];
  assertValidDocument(ir);

  const report = await buildDocument(ir, new FakeOnshape(plateWorld(plate)));
  const chamfer = report.features.find((f) => f.irId === "f4b")!;
  assert.equal(chamfer.status, "failed");
  assert.equal(chamfer.rung, "dropped");
  assert.match(chamfer.error!, /no direct-mapping proposer for op "chamfer"/);
  assert.equal(report.features.find((f) => f.irId === "f5"), undefined);
});

test("an accepted plan replays without asking the planner again", async () => {
  const first = await buildDocument(plate, new FakeOnshape(plateWorld(plate)));
  const api = new FakeOnshape(plateWorld(plate));
  const replay = await buildDocument(plate, api, { planner: new ReplayPlanner(first.plan, hashDocument(plate).intent) });
  assert.equal(replay.stoppedEarly, false);
  assert.equal(replay.plan.provenance.planner, "replay");
  assert.equal(replay.summary.failed, 0);
  assert.deepEqual(
    replay.features.map((f) => f.refs.map((r) => r.deterministicIds)),
    first.features.map((f) => f.refs.map((r) => r.deterministicIds)),
  );
});

test("a translator that picks the wrong edge is shown the failure and can correct itself", async () => {
  const planner = new WrongThenRightFillet();
  const report = await buildDocument(plate, new FakeOnshape(plateWorld(plate)), { planner });
  const fillet = report.features.find((f) => f.irId === "f5")!;
  assert.equal(fillet.status, "built");
  assert.equal(fillet.attempts, 2);
  assert.deepEqual(fillet.refs[0]!.deterministicIds, ["E_hole_top"]);
  assert.match(fillet.attemptLog[0]!.summary, /edges\[9\]/);
});

/** First fillet pick is the bottom rim (wrong); revision uses the direct proposer. */
class WrongThenRightFillet implements Planner {
  readonly provenance = { planner: "claude" as const, model: "scripted", promptVersion: "test" };
  private readonly rules = new RulePlanner();
  private totals = { calls: 0, inputTokens: 0, outputTokens: 0 };

  async proposeStep(req: StepRequest): Promise<StepProposal> {
    this.totals.calls++;
    if (req.feature.id !== "f5") return this.rules.proposeStep(req);
    const [op] = proposeDirect(req.feature, req.context, new Map());
    const fillet = op as CreateFeatureOp;
    return {
      reasoning: "fillet a non-existent edge (wrong on purpose)",
      ops: [
        {
          ...fillet,
          parameters: fillet.parameters.map((p) =>
            "selections" in p ? { ...p, selections: [{ kind: "irRef" as const, irFeature: "f5", path: "edges[9]" }] } : p,
          ),
        },
      ],
    };
  }

  async reviseStep(req: StepRequest): Promise<StepProposal | undefined> {
    this.totals.calls++;
    return this.rules.proposeStep(req);
  }

  async proposeBehaviorTests(ir: Document) {
    return this.rules.proposeBehaviorTests(ir, []);
  }

  usage() {
    return this.totals;
  }
}
