/**
 * Level 3 behaviour tests (architecture doc §9): after a complete build, each
 * driving dimension is changed in Onshape, the model regenerated and measured
 * against the source's own result for the same change, then restored.
 *
 * The plate's hole is dimensioned from the right edge, so widening the plate
 * must move the hole. A sketch that placed the hole at fixed coordinates would
 * pass every Level 1 check and fail here on the centre of mass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDocument, type Document } from "@slop/ir";
import { locateDimension, normalizeExpression } from "../src/behavior.ts";
import { buildDocument } from "../src/builder.ts";
import type { BTMSketch, BTParameterQuantity } from "../src/client/types.ts";
import { RulePlanner } from "../src/planner/rules.ts";
import { renderMarkdown } from "../src/report.ts";
import { analyticPlate, FakeOnshape, plateWorld, type PlateParams } from "./fake.ts";

const plate = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/plate.ir.json", import.meta.url)), "utf8")) as Document;
assertValidDocument(plate);

/** Geometry each fixture perturbation corresponds to (hole 25 mm from the right edge, 15 mm from the bottom). */
const ANALYTIC: Record<string, PlateParams> = {
  "D1@Sketch1=55 mm": { W: 0.055, xh: 0.03 },
  "D2@Sketch1=33 mm": { H: 0.033 },
  "D1@Sketch2=5.5 mm": { R: 0.00275 },
  "D2@Sketch2=27.5 mm": { xh: 0.0225 },
  "D3@Sketch2=16.5 mm": { yh: 0.0165 },
};

const close = (actual: number, expected: number, rel = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= rel * Math.max(Math.abs(expected), 1e-12), `${actual} vs ${expected}`);

test("the fixture's behaviour evidence is the analytic plate under each perturbation", () => {
  const entries = plate.behaviorEvidence!;
  assert.deepEqual(
    entries.map((e) => `${e.target}=${e.expression}`),
    Object.keys(ANALYTIC),
  );
  for (const e of entries) {
    const want = analyticPlate(ANALYTIC[`${e.target}=${e.expression}`]);
    close(e.evidence.volume, want.volume);
    close(e.evidence.area, want.area);
    e.evidence.centerOfMass!.forEach((v, i) => close(v, want.centerOfMass![i]!));
  }
  const nominal = analyticPlate();
  const f5 = plate.partStudio.features.find((f) => f.id === "f5")!.evidence!;
  close(f5.volume, nominal.volume);
  close(f5.area, nominal.area);
  f5.centerOfMass!.forEach((v, i) => close(v, nominal.centerOfMass![i]!));
});

test("each driving dimension is changed in Onshape, measured against the source, and restored", async () => {
  const api = new FakeOnshape(plateWorld(plate));
  const report = await buildDocument(plate, api);
  assert.equal(report.stoppedEarly, false);

  assert.deepEqual(
    report.behavior.map((b) => [b.target, b.expression, b.status, b.verified, b.restored]),
    [
      ["D1@Sketch1", "55 mm", "passed", true, true],
      ["D2@Sketch1", "33 mm", "passed", true, true],
      ["D1@Sketch2", "5.5 mm", "passed", true, true],
      ["D2@Sketch2", "27.5 mm", "passed", true, true],
      ["D3@Sketch2", "16.5 mm", "passed", true, true],
    ],
  );
  for (const b of report.behavior) {
    assert.ok(b.checks.some((c) => c.name === "centerOfMass" && c.pass), `${b.target} compares the centre of mass`);
    assert.ok(b.checks.some((c) => c.name === "volume" && c.pass));
    assert.ok(b.restoreChecks.some((c) => c.name === "volume" && c.pass), `${b.target} re-verifies the nominal model after restoring`);
    assert.deepEqual(b.featureErrors, []);
  }
  assert.equal(report.behavior[0]!.onshapeFeatureId, "F1");
  assert.equal(report.behavior[0]!.originalExpression, "50 mm");

  // Five changes and five restores went through the feature update endpoint; the document is left as built.
  assert.equal(api.updates, 10);
  assert.equal(api.activeChange(), undefined);
  const sk1 = api.added.find((a) => a.feature.name === "Sketch1")!.feature as BTMSketch;
  const d1 = sk1.constraints.find((c) => c.entityId === "f1.D1_Sketch1")!;
  assert.equal((d1.parameters.find((p) => p.btType === "BTMParameterQuantity-147") as BTParameterQuantity).expression, "50 mm");

  assert.equal(report.summary.behaviorPassed, 5);
  assert.equal(report.summary.behaviorFailed, 0);
  assert.equal(report.summary.behaviorUnverified, 0);
  const md = renderMarkdown(report);
  assert.match(md, /Behaviour \(Level 3\): 5 passed, 0 failed, 0 unverified/);
  assert.match(md, /## Behaviour tests \(Level 3\)/);
  assert.match(md, /PASSED D1@Sketch1 → `55 mm` \(against source evidence\): \d+\/\d+ checks; restored/);
});

test("a hole that does not follow its edge passes every Level 1 check and fails the behaviour test", async () => {
  // What a sketch with the hole at fixed coordinates produces when the plate widens:
  // identical volume and area, hole still at x = 25 instead of 30.
  const world = plateWorld(plate);
  world.behavior!["f1.D1_Sketch1=55 mm"] = { evidence: analyticPlate({ W: 0.055, xh: 0.025 }) };
  const report = await buildDocument(plate, new FakeOnshape(world));

  assert.equal(report.summary.checksFailed, 0, "Level 1 cannot see the difference");
  const b = report.behavior.find((x) => x.target === "D1@Sketch1")!;
  assert.equal(b.status, "failed");
  assert.deepEqual(
    b.checks.filter((c) => !c.pass && !c.advisory).map((c) => c.name),
    ["centerOfMass"],
  );
  assert.ok(b.checks.find((c) => c.name === "volume")!.pass);
  assert.equal(b.restored, true);
  assert.equal(report.behavior.filter((x) => x.status === "passed").length, 4);
  assert.equal(report.summary.behaviorFailed, 1);
  assert.match(renderMarkdown(report), /FAILED D1@Sketch1 → `55 mm`[\s\S]*FAILED centerOfMass/);
});

test("a reference that breaks under the change is a regeneration failure, and the model is still restored", async () => {
  const world = plateWorld(plate);
  world.behavior!["f1.D1_Sketch1=55 mm"] = { ...world.behavior!["f1.D1_Sketch1=55 mm"], broken: ["Fillet1"] };
  const api = new FakeOnshape(world);
  const report = await buildDocument(plate, api);

  const b = report.behavior.find((x) => x.target === "D1@Sketch1")!;
  assert.equal(b.status, "regenerationFailed");
  assert.deepEqual(b.featureErrors, ["Fillet1"]);
  assert.deepEqual(b.checks, []);
  assert.equal(b.restored, true);
  assert.equal(report.behavior.length, 5, "later tests still run");
  assert.equal(api.activeChange(), undefined);
  assert.equal(report.summary.behaviorFailed, 1);
  assert.match(renderMarkdown(report), /REGENERATION FAILED D1@Sketch1[\s\S]*features in error after the change: Fillet1/);
});

test("planner proposals without source evidence run as unverified; unknown targets are unsupported", async () => {
  class Proposes extends RulePlanner {
    override async proposeBehaviorTests() {
      return [
        { target: "D1@Sketch1", expression: "D1@Sketch1 = 60 mm", expectation: "plate widens to 60 mm" },
        { target: "D1@Sketch1", expression: "55 mm", expectation: "duplicate of a verified case" },
        { target: "D7@Nowhere", expression: "1 mm", expectation: "no such dimension" },
      ];
    }
  }
  const api = new FakeOnshape(plateWorld(plate));
  const report = await buildDocument(plate, api, { planner: new Proposes() });

  assert.equal(report.behavior.length, 7, "5 verified + the 60 mm proposal + the unknown target; the 55 mm duplicate is folded into the verified case");
  const sixty = report.behavior.find((b) => b.expression === "60 mm")!;
  assert.equal(sixty.target, "D1@Sketch1");
  assert.equal(sixty.verified, false);
  assert.equal(sixty.status, "unverified");
  assert.equal(sixty.restored, true);
  const unknown = report.behavior.find((b) => b.target === "D7@Nowhere")!;
  assert.equal(unknown.status, "unsupported");
  assert.match(unknown.error!, /no Onshape sketch dimension found/);
  assert.equal(report.summary.behaviorUnverified, 2);
  assert.equal(api.activeChange(), undefined);
  assert.match(renderMarkdown(report), /UNVERIFIED D1@Sketch1 → `60 mm` \(no source evidence for this change\)/);
});

test("behaviour tests can be switched off, leaving the proposals in the report", async () => {
  const api = new FakeOnshape(plateWorld(plate));
  const report = await buildDocument(plate, api, { behavior: false });
  assert.deepEqual(report.behavior, []);
  assert.equal(api.updates, 0);
  assert.ok(report.plan.behaviorTests.length > 0);
  assert.match(renderMarkdown(report), /## Behaviour tests \(proposed, not run\)/);
});

test("dimension lookup finds the constraint by its IR id; expressions are normalised", async () => {
  const api = new FakeOnshape(plateWorld(plate));
  await buildDocument(plate, api, { behavior: false });
  const list = await api.getFeatures();

  const hit = locateDimension(list, "D2@Sketch2");
  assert.ok(!("error" in hit));
  if (!("error" in hit)) {
    assert.equal(hit.sketch.name, "Sketch2");
    assert.equal(hit.constraint.entityId, "f3.D2_Sketch2");
    assert.equal(hit.quantity.expression, "25 mm");
  }
  assert.match((locateDimension(list, "D9@Sketch9") as { error: string }).error, /no Onshape sketch dimension/);

  assert.equal(normalizeExpression("D1@Sketch1 = 60 mm"), "60 mm");
  assert.equal(normalizeExpression(" 60 mm "), "60 mm");
});
