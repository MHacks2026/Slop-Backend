import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feature, Parameter, SketchFeature } from "@slop/ir";
import type { BTMSketch, BTParameterQuantity } from "../src/client/types.ts";
import { lengthExpression } from "../src/expression.ts";
import { decodeFsValue } from "../src/fs/values.ts";
import type { PlaneFrame } from "../src/geometry.ts";
import { composeSketch } from "../src/sketch/compose.ts";
import { encode } from "./fake.ts";

const TOP: PlaneFrame = { origin: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0] };

const square: SketchFeature = {
  id: "s1",
  src: { name: "Sketch1" },
  op: "sketch",
  suppressed: false,
  fidelity: { rung: "pending" },
  plane: { kind: "datum", name: "FRONT" },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  entities: [
    { id: "l1", type: "line", construction: false, p0: [0, 0], p1: [0.02, 0] },
    { id: "l2", type: "line", construction: true, p0: [0.02, 0], p1: [0.02, 0.01] },
  ],
  constraints: [
    { type: "horizontal", args: ["l1"] },
    { type: "vertical", args: ["l2"] },
    { type: "coincident", args: ["l1.start", "ORIGIN"] },
  ],
  dimensions: [{ id: "D1@Sketch1", type: "distance", args: ["l1"], value: { expr: "20 mm", value: 0.02, unit: "m" }, driving: true }],
};

function compose(frame: PlaneFrame, transform = square.transform) {
  return composeSketch({
    name: square.src.name,
    planeIds: ["JCC"],
    frame,
    sourceTransform: transform,
    entities: square.entities,
    constraints: square.constraints,
    dimensions: square.dimensions,
    originId: "JGC",
    idPrefix: square.id,
  });
}

test("sketch on a datum: lines, construction flag, origin reference, length dimension", () => {
  const { feature, rung, notes } = compose(TOP);
  const sk = feature as BTMSketch;
  assert.equal(rung, "exact");
  assert.deepEqual(notes, []);
  assert.equal(sk.entities.length, 2);
  const l1 = sk.entities[0]!;
  assert.equal(l1.btType, "BTMSketchCurveSegment-155");
  if (l1.btType === "BTMSketchCurveSegment-155" && l1.geometry.btType === "BTCurveGeometryLine-117") {
    assert.deepEqual([l1.geometry.pntX, l1.geometry.pntY, l1.geometry.dirX, l1.geometry.dirY], [0, 0, 1, 0]);
    assert.equal(l1.endParam, 0.02);
    assert.equal(l1.startPointId, "l1.start");
  }
  assert.equal(sk.entities[1]!.isConstruction, true);
  assert.deepEqual(
    sk.constraints.map((c) => c.constraintType),
    ["HORIZONTAL", "VERTICAL", "COINCIDENT", "LENGTH"],
  );
  const dim = sk.constraints[3]!;
  assert.equal((dim.parameters.find((p) => p.parameterId === "length") as BTParameterQuantity).expression, "20 mm");
  assert.equal(dim.entityId, "s1.D1_Sketch1");
});

test("a 90-degree in-plane rotation swaps horizontal and vertical and re-projects points", () => {
  const rotated: PlaneFrame = { origin: [0, 0, 0], normal: [0, 0, 1], x: [0, 1, 0] };
  const { feature } = compose(rotated);
  const sk = feature as BTMSketch;
  assert.deepEqual(
    sk.constraints.slice(0, 2).map((c) => c.constraintType),
    ["VERTICAL", "HORIZONTAL"],
  );
  const l1 = sk.entities[0]!;
  if (l1.btType === "BTMSketchCurveSegment-155" && l1.geometry.btType === "BTCurveGeometryLine-117") {
    assert.ok(Math.abs(l1.geometry.dirX) < 1e-12 && Math.abs(l1.geometry.dirY + 1) < 1e-12);
  }
});

test("a sketch off its Onshape plane is rejected rather than silently moved", () => {
  const lifted: PlaneFrame = { origin: [0, 0, 0.005], normal: [0, 0, 1], x: [1, 0, 0] };
  assert.throws(() => compose(lifted), /off the Onshape plane/);
});

test("a non-right-angle frame rotation is rejected", () => {
  const s = Math.SQRT1_2;
  const skew: PlaneFrame = { origin: [0, 0, 0], normal: [0, 0, 1], x: [s, s, 0] };
  assert.throws(() => compose(skew), /rotated 45.00 deg/);
});

test("length expressions keep source literals, format SI otherwise, and bind variables", () => {
  const params = new Map<string, Parameter>([["p1", { id: "p1", name: "Plate Width", scope: "global", expression: "50", value: 0.05, unit: "m", driven: false }]]);
  assert.equal(lengthExpression({ expr: "50 mm", value: 0.05, unit: "m" }), "50 mm");
  assert.equal(lengthExpression({ expr: '"Width"/2', value: 0.025, unit: "m" }), "25 mm");
  assert.equal(lengthExpression({ expr: "x", value: 0.0123456789, unit: "m" }), "12.3456789 mm");
  assert.equal(lengthExpression({ expr: "50", value: 0.05, unit: "m", parameter: "p1" }, params), "#Plate_Width");
});

test("FeatureScript values decode to plain JS", () => {
  const decoded = decodeFsValue(encode({ ids: ["JHC"], type: "PLANE", normal: [0, 0, 1], area: 1.5e-3, nested: { ok: true } })) as Record<string, unknown>;
  assert.deepEqual(decoded, { ids: ["JHC"], type: "PLANE", normal: [0, 0, 1], area: 1.5e-3, nested: { ok: true } });
  assert.equal(decodeFsValue({ btType: "BTFSValueWithUnits-1817", value: 0.01, unitToPower: [{ key: "METER", value: 1 }] }), 0.01);
});

const _ops: Feature["op"][] = ["sketch", "extrude", "fillet"];
void _ops;
