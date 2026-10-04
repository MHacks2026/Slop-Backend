/**
 * Direct-mapping proposers for the MVP feature set beyond sketch/extrude/fillet.
 * These check the plan ops: feature type, parameter ids, enum values and
 * selections. The Onshape wire shapes they imply are unverified until a live
 * readback; what is verified here is that the IR fields land in the right
 * place and that unmappable cases are refused rather than guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDocument, type ChamferFeature, type CircularPatternFeature, type Document, type Feature, type HoleFeature, type PlaneFeature, type Quantity, type RevolveFeature } from "@slop/ir";
import type { StepContext } from "../src/plan/executor.ts";
import type { CreateFeatureOp, CreateSketchOp, ParameterValue } from "../src/plan/types.ts";
import { validateStepProposal } from "../src/plan/validate.ts";
import { proposableOps, proposeDirect, ProposalError } from "../src/proposers/index.ts";

const shaft = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/shaft.ir.json", import.meta.url)), "utf8")) as Document;
assertValidDocument(shaft);

const ctx = {
  ir: shaft,
  onshapeId: () => undefined,
  sketchFrame: () => undefined,
  datumFrame: async () => ({ origin: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0] }),
  listTopology: async () => [],
  opsFor: () => [],
} as unknown as StepContext;

const mm = (v: number): Quantity => ({ expr: `${v} mm`, value: v / 1000, unit: "m" });
const deg = (v: number): Quantity => ({ expr: `${v} deg`, value: (v * Math.PI) / 180, unit: "rad" });
const count = (n: number): Quantity => ({ expr: String(n), value: n, unit: "" });
const base = (id: string, name: string) => ({ id, src: { name }, suppressed: false, fidelity: { rung: "pending" as const } });

const feature = <F extends Feature = Feature>(id: string): F => shaft.partStudio.features.find((f) => f.id === id) as F;
const param = (op: CreateFeatureOp, id: string): ParameterValue => {
  const p = op.parameters.find((x) => x.id === id);
  assert.ok(p, `parameter ${id} on ${op.featureType}`);
  return p;
};
const enumOf = (op: CreateFeatureOp, id: string) => (param(op, id) as { enum: { name: string; value: string } }).enum;
const quantityOf = (op: CreateFeatureOp, id: string) => (param(op, id) as { quantity: string }).quantity;
const boolOf = (op: CreateFeatureOp, id: string) => (param(op, id) as { boolean: boolean }).boolean;
const selectionsOf = (op: CreateFeatureOp, id: string) => (param(op, id) as { selections: unknown[] }).selections;
const one = (f: Feature): CreateFeatureOp => {
  const ops = proposeDirect(f, ctx, new Map());
  assert.equal(ops.length, 1);
  validateStepProposal({ reasoning: "t", ops });
  return ops[0] as CreateFeatureOp;
};

test("every MVP op has a direct proposer", () => {
  assert.deepEqual(
    [...proposableOps()].sort(),
    ["chamfer", "circularPattern", "extrude", "fillet", "hole", "linearPattern", "mirror", "plane", "revolve", "shell", "sketch"].sort(),
  );
});

test("revolve: full turn about a sketch line, region as profile", () => {
  const op = one(feature("f2"));
  assert.equal(op.featureType, "revolve");
  assert.equal(op.rung, "exact");
  assert.deepEqual(enumOf(op, "revolveType"), { name: "RevolveType", value: "FULL" });
  assert.deepEqual(enumOf(op, "operationType"), { name: "NewBodyOperationType", value: "NEW" });
  assert.deepEqual(selectionsOf(op, "entities"), [{ kind: "sketchRegion", sketch: "f1" }]);
  assert.deepEqual(selectionsOf(op, "axis"), [{ kind: "sketchEntity", sketch: "f1", entity: "l1" }]);
  assert.equal(op.parameters.some((p) => p.id === "angle"), false, "a full revolve carries no angle");
  assert.equal(boolOf(op, "oppositeDirection"), false);
});

test("revolve: partial angle and a model-edge axis", () => {
  const f: RevolveFeature = { ...feature<RevolveFeature>("f2"), angle: deg(90), flip: true, axis: { kind: "topo", entity: "edge", createdBy: "f1" } };
  const op = one(f);
  assert.deepEqual(enumOf(op, "revolveType"), { name: "RevolveType", value: "ONE_DIRECTION" });
  assert.equal(quantityOf(op, "angle"), "90 deg");
  assert.equal(boolOf(op, "oppositeDirection"), true);
  assert.deepEqual(selectionsOf(op, "axis"), [{ kind: "irRef", irFeature: "f2", path: "axis" }]);
});

test("chamfer: the three SolidWorks specs map to the three Onshape chamfer types", () => {
  const equal = one(feature("f3"));
  assert.equal(equal.featureType, "chamfer");
  assert.deepEqual(enumOf(equal, "chamferType"), { name: "ChamferType", value: "EQUAL_OFFSETS" });
  assert.equal(quantityOf(equal, "width"), "1 mm");
  assert.equal(boolOf(equal, "tangentPropagation"), true);
  assert.deepEqual(selectionsOf(equal, "entities"), [{ kind: "irRef", irFeature: "f3", path: "edges[0]" }]);

  const two = one({ ...feature<ChamferFeature>("f3"), spec: { type: "twoDistances", distance1: mm(1), distance2: mm(2), flip: true } });
  assert.deepEqual(enumOf(two, "chamferType"), { name: "ChamferType", value: "TWO_OFFSETS" });
  assert.equal(quantityOf(two, "width1"), "1 mm");
  assert.equal(quantityOf(two, "width2"), "2 mm");
  assert.equal(boolOf(two, "oppositeDirection"), true);

  const angled = one({ ...feature<ChamferFeature>("f3"), spec: { type: "distanceAngle", distance: mm(1), angle: deg(30), flip: false } });
  assert.deepEqual(enumOf(angled, "chamferType"), { name: "ChamferType", value: "OFFSET_ANGLE" });
  assert.equal(quantityOf(angled, "angle"), "30 deg");
});

test("shell: thickness, removed faces, outward flag", () => {
  const op = one({ ...base("s1", "Shell1"), op: "shell", thickness: mm(1.5), outward: true, removeFaces: [{ kind: "topo", entity: "face", createdBy: "f2" }] } as Feature);
  assert.equal(op.featureType, "shell");
  assert.equal(quantityOf(op, "thickness"), "1.5 mm");
  assert.equal(boolOf(op, "oppositeDirection"), true);
  assert.deepEqual(selectionsOf(op, "entities"), [{ kind: "irRef", irFeature: "s1", path: "removeFaces[0]" }]);
});

test("reference plane: offset, mid-plane and angle definitions", () => {
  const offset = one(feature("f4"));
  assert.equal(offset.featureType, "cPlane");
  assert.deepEqual(enumOf(offset, "cplaneType"), { name: "CPlaneType", value: "OFFSET" });
  assert.deepEqual(selectionsOf(offset, "entities"), [{ kind: "datum", name: "FRONT" }]);
  assert.equal(quantityOf(offset, "offset"), "10 mm");
  assert.equal(boolOf(offset, "oppositeDirection"), false);

  const mid = one({ ...feature<PlaneFeature>("f4"), definition: { type: "midPlane", a: { kind: "datum", name: "FRONT" }, b: { kind: "feature-output", feature: "f4", role: "plane" } } });
  assert.deepEqual(enumOf(mid, "cplaneType"), { name: "CPlaneType", value: "MID_PLANE" });
  assert.equal(selectionsOf(mid, "entities").length, 2);

  const angled = one({ ...feature<PlaneFeature>("f4"), definition: { type: "angle", base: { kind: "datum", name: "TOP" }, axis: { kind: "sketch-entity", sketch: "f1", entity: "l1" } as unknown as PlaneFeature["definition"] extends { type: "angle"; axis: infer A } ? A : never, angle: deg(45), flip: true } });
  assert.deepEqual(enumOf(angled, "cplaneType"), { name: "CPlaneType", value: "LINE_ANGLE" });
  assert.deepEqual(selectionsOf(angled, "entities"), [
    { kind: "datum", name: "TOP" },
    { kind: "sketchEntity", sketch: "f1", entity: "l1" },
  ]);
  assert.equal(quantityOf(angled, "angle"), "45 deg");
});

test("mirror: seeds as a features selection, plane as a datum or reference", () => {
  const op = one({ ...base("m1", "Mirror1"), op: "mirror", seeds: ["f3", "f6"], plane: { kind: "datum", name: "RIGHT" } } as Feature);
  assert.equal(op.featureType, "mirror");
  assert.deepEqual(selectionsOf(op, "instanceFunction"), [{ kind: "features", features: ["f3", "f6"] }]);
  assert.deepEqual(selectionsOf(op, "mirrorPlane"), [{ kind: "datum", name: "RIGHT" }]);
  assert.throws(() => proposeDirect({ ...base("m2", "Mirror2"), op: "mirror", seeds: [], plane: { kind: "datum", name: "RIGHT" } } as Feature, ctx, new Map()), ProposalError);
});

test("linear pattern: one and two directions; skipped instances are refused", () => {
  const dir1 = { direction: { kind: "sketch-entity", sketch: "f1", entity: "l1" }, count: count(3), spacing: mm(8), flip: false };
  const f = { ...base("p1", "LPattern1"), op: "linearPattern", seeds: ["f6"], direction1: dir1 } as Feature;
  const op = one(f);
  assert.equal(op.featureType, "linearPattern");
  assert.deepEqual(enumOf(op, "patternType"), { name: "PatternType", value: "FEATURE" });
  assert.deepEqual(selectionsOf(op, "instanceFunction"), [{ kind: "features", features: ["f6"] }]);
  assert.deepEqual(selectionsOf(op, "directionOne"), [{ kind: "sketchEntity", sketch: "f1", entity: "l1" }]);
  assert.equal(quantityOf(op, "distance"), "8 mm");
  assert.equal(quantityOf(op, "instanceCount"), "3");
  assert.equal(op.parameters.some((p) => p.id === "hasSecondDir"), false);

  const two = one({ ...f, direction2: { direction: { kind: "datum", name: "TOP" }, count: count(2), spacing: mm(5), flip: true } } as Feature);
  assert.equal(boolOf(two, "hasSecondDir"), true);
  assert.deepEqual(selectionsOf(two, "directionTwo"), [{ kind: "datum", name: "TOP" }]);
  assert.equal(quantityOf(two, "instanceCountTwo"), "2");
  assert.equal(boolOf(two, "oppositeDirectionTwo"), true);

  assert.throws(() => proposeDirect({ ...f, skipped: [[1, 0]] } as Feature, ctx, new Map()), /skipped instances/);
});

test("circular pattern: axis, count, angle, equal spacing", () => {
  const op = one(feature("f7"));
  assert.equal(op.featureType, "circularPattern");
  assert.deepEqual(selectionsOf(op, "instanceFunction"), [{ kind: "features", features: ["f6"] }]);
  assert.deepEqual(selectionsOf(op, "axis"), [{ kind: "irRef", irFeature: "f7", path: "axis" }]);
  assert.equal(quantityOf(op, "instanceCount"), "4");
  assert.equal(quantityOf(op, "angle"), "360 deg");
  assert.equal(boolOf(op, "equalSpace"), true);
  assert.equal(boolOf(op, "oppositeDirection"), false);
  assert.throws(() => proposeDirect({ ...feature<CircularPatternFeature>("f7"), skipped: [2] }, ctx, new Map()), /skipped instances/);
});

test("hole: composite of a position sketch tied to the vertex plus a cut; counterbore adds a second pair", () => {
  const hole: HoleFeature = {
    ...base("h1", "Hole1"),
    op: "hole",
    style: "simple",
    startFace: { kind: "topo", entity: "face", createdBy: "f2", signature: { surface: "plane", normal: [0, 0, 1], offset: 0.01, centroid: [0.025, 0.015, 0.01] } },
    positions: [{ kind: "topo", entity: "vertex", createdBy: "f1", signature: { point: [0.025, 0.015, 0.01] } }],
    diameter: mm(5),
    end: { type: "throughAll" },
  };
  const ops = proposeDirect(hole, ctx, new Map());
  validateStepProposal({ reasoning: "t", ops });
  assert.deepEqual(ops.map((o) => [o.op, o.id, o.rung]), [
    ["createSketch", "h1.sketch", "composite"],
    ["createFeature", "h1", "composite"],
  ]);

  const sk = ops[0] as CreateSketchOp;
  assert.deepEqual(sk.plane, { kind: "irRef", irFeature: "h1", path: "startFace" });
  assert.ok(sk.transform && sk.transform.length === 16);
  const circle = sk.entities[0]!;
  assert.equal(circle.type, "circle");
  if (circle.type === "circle") {
    // Frame on z = 0.01 with x along world X: the vertex lands at local (0.025, 0.015).
    assert.ok(Math.abs(circle.center[0] - 0.025) < 1e-12 && Math.abs(circle.center[1] - 0.015) < 1e-12);
    assert.equal(circle.r, 0.0025);
  }
  // Live tie to the position vertex: the executor resolves this Ref like any sketch external reference.
  assert.deepEqual(sk.constraints[0]!.type, "coincident");
  assert.deepEqual(sk.constraints[0]!.args[1], hole.positions[0]);
  assert.equal(sk.dimensions[0]!.type, "diameter");
  assert.equal(sk.dimensions[0]!.value.expr, "5 mm");

  const cut = ops[1] as CreateFeatureOp;
  assert.equal(cut.featureType, "extrude");
  assert.deepEqual(enumOf(cut, "operationType"), { name: "NewBodyOperationType", value: "REMOVE" });
  assert.deepEqual(enumOf(cut, "endBound"), { name: "BoundingType", value: "THROUGH_ALL" });
  assert.deepEqual(selectionsOf(cut, "entities"), [{ kind: "sketchRegion", sketch: "h1.sketch" }]);
  assert.equal(boolOf(cut, "oppositeDirection"), true);

  const cbore = proposeDirect({ ...hole, style: "counterbore", end: { type: "blind", depth: mm(12) }, counterbore: { diameter: mm(9), depth: mm(4) } }, ctx, new Map());
  assert.deepEqual(cbore.map((o) => o.id), ["h1.sketch", "h1", "h1.cbore.sketch", "h1.cbore"]);
  assert.equal(quantityOf(cbore[1] as CreateFeatureOp, "depth"), "12 mm");
  assert.equal(quantityOf(cbore[3] as CreateFeatureOp, "depth"), "4 mm");
  assert.equal((cbore[2] as CreateSketchOp).dimensions[0]!.value.expr, "9 mm");

  // Countersink: a chamfer on the rim the cut created at each centre. 90 deg is symmetric; 82 deg (inch flat heads) is not.
  const csk90 = proposeDirect({ ...hole, style: "countersink", countersink: { diameter: mm(9), angle: deg(90) } }, ctx, new Map());
  assert.deepEqual(csk90.map((o) => [o.op, o.id, o.rung]), [
    ["createSketch", "h1.sketch", "composite"],
    ["createFeature", "h1", "composite"],
    ["createFeature", "h1.csk", "composite"],
  ]);
  const chamfer90 = csk90[2] as CreateFeatureOp;
  assert.equal(chamfer90.featureType, "chamfer");
  assert.deepEqual(enumOf(chamfer90, "chamferType"), { name: "ChamferType", value: "EQUAL_OFFSETS" });
  assert.equal(quantityOf(chamfer90, "width"), "2 mm");
  assert.deepEqual(selectionsOf(chamfer90, "entities"), [{ kind: "createdBy", feature: "h1", entity: "edge", where: { type: "circle", radius: 0.0025, near: [0.025, 0.015, 0.01] } }]);
  const chamfer82 = proposeDirect({ ...hole, style: "countersink", countersink: { diameter: mm(9), angle: deg(82) } }, ctx, new Map())[2] as CreateFeatureOp;
  assert.deepEqual(enumOf(chamfer82, "chamferType"), { name: "ChamferType", value: "TWO_OFFSETS" });
  assert.equal(quantityOf(chamfer82, "width1"), "2 mm");
  assert.ok(Math.abs(parseFloat(quantityOf(chamfer82, "width2")) - 2 / Math.tan((41 * Math.PI) / 180)) < 1e-6);
  // A drill point cannot be extruded: the cut says so and is approximated; a through hole has no tip to lose.
  const tipped = proposeDirect({ ...hole, end: { type: "blind", depth: mm(10) }, drillTip: { angle: deg(118) } }, ctx, new Map());
  assert.equal(tipped[1]!.rung, "approximated");
  assert.match(tipped[1]!.intent, /118 deg drill point/);
  assert.equal(tipped[0]!.rung, "composite");
  assert.equal(proposeDirect({ ...hole, drillTip: { angle: deg(118) } }, ctx, new Map())[1]!.rung, "composite", "through holes keep no tip");
  assert.throws(() => proposeDirect({ ...hole, style: "countersink" }, ctx, new Map()), /without countersink/);
  assert.throws(() => proposeDirect({ ...hole, style: "countersink", countersink: { diameter: mm(4), angle: deg(90) } }, ctx, new Map()), /not larger than the hole/);
  assert.throws(() => proposeDirect({ ...hole, positions: [{ kind: "topo", entity: "vertex", createdBy: "f1" }] }, ctx, new Map()), /no recorded point/);
  assert.throws(() => proposeDirect({ ...hole, startFace: { kind: "topo", entity: "face", createdBy: "f2" } }, ctx, new Map()), /no plane signature/);
});

test("the plan schema accepts the new selection kinds and a sketch transform", () => {
  const ok = {
    reasoning: "t",
    ops: [
      {
        op: "createSketch",
        id: "s",
        intent: "i",
        rung: "composite",
        name: "S",
        plane: { kind: "datum", name: "TOP" },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        entities: [],
        constraints: [],
        dimensions: [],
      },
      { op: "createFeature", id: "r", intent: "i", rung: "exact", name: "R", featureType: "revolve", parameters: [{ id: "axis", selections: [{ kind: "sketchEntity", sketch: "s", entity: "l1" }] }] },
      { op: "createFeature", id: "m", intent: "i", rung: "exact", name: "M", featureType: "mirror", parameters: [{ id: "instanceFunction", selections: [{ kind: "features", features: ["r"] }] }] },
    ],
  };
  assert.doesNotThrow(() => validateStepProposal(ok));
  const bad = structuredClone(ok) as { ops: Array<Record<string, unknown>> };
  bad.ops[0]!.transform = [1, 2, 3];
  assert.throws(() => validateStepProposal(bad));
  const emptySeeds = structuredClone(ok) as { ops: Array<{ parameters?: Array<{ selections: unknown[] }> }> };
  emptySeeds.ops[2]!.parameters![0]!.selections = [{ kind: "features", features: [] }];
  assert.throws(() => validateStepProposal(emptySeeds));
});

test("the first real extraction (LCDM2) has a direct mapping for every feature", () => {
  const lcdm2 = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/lcdm2.ir.json", import.meta.url)), "utf8")) as Document;
  assertValidDocument(lcdm2);
  const ctxFor = { ...ctx, ir: lcdm2 } as unknown as StepContext;
  const parameters = new Map(lcdm2.parameters.map((p) => [p.id, p]));
  const summary = lcdm2.partStudio.features.map((f) => {
    const ops = proposeDirect(f, ctxFor, parameters);
    validateStepProposal({ reasoning: "t", ops });
    return `${f.op}:${ops.map((o) => (o.op === "createFeature" ? o.featureType : o.op)).join("+")}`;
  });
  assert.deepEqual(summary, [
    "sketch:createSketch",
    "revolve:createFeature".replace("createFeature", "revolve"),
    "chamfer:chamfer",
    "sketch:createSketch",
    "hole:createSketch+extrude+chamfer", // #8-32 tapped, countersunk: tap drill plus a chamfer for the cone
    "sketch:createSketch",
    "hole:createSketch+extrude+chamfer", // 5/16 with near-side countersink
    "sketch:createSketch",
    "hole:createSketch+extrude", // #9 plain blind hole
  ]);
  // The tapped hole is honest about what was lost.
  assert.match(lcdm2.partStudio.features[4]!.fidelity.notes ?? "", /tap drill/);
});
