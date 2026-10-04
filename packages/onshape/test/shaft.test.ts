/**
 * Second end-to-end fixture: a chamfered shaft with a patterned radial hole.
 * Exercises, through the fake Onshape, what the plate does not: an arc in a
 * sketch, a revolve about a sketch line (sketchEntity selection), a chamfer,
 * a reference plane and a sketch on it, and a circular feature pattern
 * (features selection, cylindrical-face axis). No evidence is attached, so
 * this proves resolution and wire JSON, not geometry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDocument, type Document, type Vec3 } from "@slop/ir";
import { buildDocument } from "../src/builder.ts";
import type { BTFeatureQuery, BTIndividualQuery, BTMFeature, BTMSketch, BTParameterBoolean, BTParameterEnum, BTParameterQuantity, BTParameterQueryList } from "../src/client/types.ts";
import { renderMarkdown } from "../src/report.ts";
import { FakeOnshape, type RawRecord, type World } from "./fake.ts";

const shaft = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/shaft.ir.json", import.meta.url)), "utf8")) as Document;
assertValidDocument(shaft);

const param = <T>(f: BTMFeature | BTMSketch, id: string): T => f.parameters.find((p) => p.parameterId === id) as T;
const ids = (f: BTMFeature | BTMSketch, id: string) => (param<BTParameterQueryList>(f, id).queries[0] as BTIndividualQuery).deterministicIds;

const plane = (id: string, origin: Vec3, normal: Vec3, x: Vec3): RawRecord => ({ ids: [id], type: "PLANE", origin, normal, x, centroid: origin });
const line = (id: string, a: Vec3, b: Vec3): RawRecord => {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  return { ids: [id], type: "LINE", origin: a, direction: d.map((v) => v / len), length: len, midpoint: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] };
};
const circle = (id: string, center: Vec3, r: number, axis: Vec3): RawRecord => ({ ids: [id], type: "CIRCLE", center, axis, radius: r, length: 2 * Math.PI * r, midpoint: [center[0], center[1] + r, center[2]] });

/** Onshape-side geometry of the shaft: Ø10 x 20 mm along +X, built from the sketch on the XY plane. */
function shaftWorld(): World {
  return {
    evidence: {},
    topology: {
      Top: { face: [plane("JCC", [0, 0, 0], [0, 0, 1], [1, 0, 0])] },
      Front: { face: [plane("JDC", [0, 0, 0], [0, -1, 0], [1, 0, 0])] },
      Right: { face: [plane("JFC", [0, 0, 0], [1, 0, 0], [0, 1, 0])] },
      Origin: { vertex: [{ ids: ["JGC"], type: "VERTEX", point: [0, 0, 0] }] },
      // Sketch curves are edges with deterministic ids, like any model edge.
      Sketch1: {
        edge: [
          line("E_l1", [0, 0, 0], [0.02, 0, 0]),
          line("E_l2", [0.02, 0, 0], [0.02, 0.004, 0]),
          circle("E_a1", [0.019, 0.004, 0], 0.001, [0, 0, 1]),
          line("E_l3", [0.019, 0.005, 0], [0, 0.005, 0]),
          line("E_l4", [0, 0.005, 0], [0, 0, 0]),
        ],
      },
      Revolve1: {
        face: [
          { ids: ["F_cyl"], type: "CYLINDER", origin: [0, 0, 0], axis: [1, 0, 0], radius: 0.005, area: 2 * Math.PI * 0.005 * 0.019 },
          { ids: ["F_torus"], type: "TORUS", origin: [0.019, 0, 0], axis: [1, 0, 0], radius: 0.004, minorRadius: 0.001 },
          plane("F_capStart", [0, 0, 0], [-1, 0, 0], [0, 1, 0]),
          plane("F_capEnd", [0.02, 0, 0], [1, 0, 0], [0, 1, 0]),
        ],
        edge: [circle("E_rim_start", [0, 0, 0], 0.005, [1, 0, 0]), circle("E_rim_end", [0.02, 0, 0], 0.004, [1, 0, 0]), circle("E_torus_seam", [0.019, 0, 0], 0.005, [1, 0, 0])],
      },
      Plane1: { face: [plane("P_plane1", [0, 0, 0.01], [0, 0, 1], [1, 0, 0])] },
    },
  };
}

test("the shaft builds end to end: arc, revolve about a sketch line, chamfer, offset plane, sketch on it, circular feature pattern", async () => {
  const api = new FakeOnshape(shaftWorld());
  const report = await buildDocument(shaft, api, { behavior: false });

  assert.equal(report.stoppedEarly, false, report.features.map((f) => `${f.irId}: ${f.status} ${f.error ?? ""}`).join("\n"));
  assert.deepEqual(
    report.features.map((f) => [f.irId, f.op, f.status, f.rung]),
    [
      ["f1", "sketch", "built", "exact"],
      ["f2", "revolve", "built", "exact"],
      ["f3", "chamfer", "built", "exact"],
      ["f4", "plane", "built", "exact"],
      ["f5", "sketch", "built", "exact"],
      ["f6", "extrude", "built", "exact"],
      ["f7", "circularPattern", "built", "exact"],
    ],
  );

  const [sk1, revolve, chamfer, cplane, sk2, cut, pattern] = api.added.map((a) => a.feature) as [BTMSketch, BTMFeature, BTMFeature, BTMFeature, BTMSketch, BTMFeature, BTMFeature];

  // Arc: a counter-clockwise quarter circle from angle 0 to pi/2 about (19, 4) mm, keeping the IR point ids.
  const arc = sk1.entities.find((e) => e.entityId === "a1")!;
  assert.equal(arc.btType, "BTMSketchCurveSegment-155");
  if (arc.btType === "BTMSketchCurveSegment-155" && arc.geometry.btType === "BTCurveGeometryCircle-115") {
    assert.ok(Math.abs(arc.geometry.xCenter - 0.019) < 1e-12 && Math.abs(arc.geometry.yCenter - 0.004) < 1e-12);
    assert.ok(Math.abs(arc.geometry.radius - 0.001) < 1e-12, `radius ${arc.geometry.radius}`);
    assert.ok(Math.abs(arc.startParam) < 1e-12 && Math.abs(arc.endParam - Math.PI / 2) < 1e-12);
    assert.equal(arc.startPointId, "a1.start");
    assert.equal(arc.endPointId, "a1.end");
    assert.equal(arc.centerId, "a1.center");
  }
  assert.ok(sk1.constraints.some((c) => c.constraintType === "TANGENT"));
  assert.ok(sk1.constraints.some((c) => c.constraintType === "RADIUS"));

  // Revolve about sketch line l1, resolved to its deterministic id by probing the sketch's edges.
  assert.equal(revolve.featureType, "revolve");
  assert.deepEqual(ids(revolve, "axis"), ["E_l1"]);
  assert.equal(param<BTParameterEnum>(revolve, "revolveType").value, "FULL");
  assert.equal(param<BTParameterQueryList>(revolve, "entities").queries[0]!.btType, "BTMIndividualSketchRegionQuery-140");
  const axisRef = report.features[1]!.refs.find((r) => r.parameterId === "axis")!;
  assert.equal(axisRef.resolver, "probe");
  assert.deepEqual(axisRef.selection, { kind: "sketchEntity", sketch: "f1", entity: "l1" });

  // Chamfer on the start rim, picked by circle centre and radius among three circular edges.
  assert.equal(chamfer.featureType, "chamfer");
  assert.deepEqual(ids(chamfer, "entities"), ["E_rim_start"]);
  assert.equal(param<BTParameterEnum>(chamfer, "chamferType").value, "EQUAL_OFFSETS");
  assert.equal(param<BTParameterQuantity>(chamfer, "width").expression, "1 mm");

  // Offset plane from the (remapped) FRONT datum.
  assert.equal(cplane.featureType, "cPlane");
  assert.deepEqual(ids(cplane, "entities"), ["JCC"]);
  assert.equal(param<BTParameterQuantity>(cplane, "offset").expression, "10 mm");

  // Sketch2 sits on the plane the cPlane created, found as the face that feature made.
  assert.deepEqual(ids(sk2, "sketchPlane"), ["P_plane1"]);
  const c1 = sk2.entities[0]!;
  if (c1.btType === "BTMSketchCurve-4") assert.ok(Math.abs(c1.geometry.xCenter - 0.01) < 1e-12 && Math.abs(c1.geometry.yCenter) < 1e-12);

  // Cut goes against the plane normal (IR flip true on a plane whose normal matches Onshape's).
  assert.equal(param<BTParameterEnum>(cut, "operationType").value, "REMOVE");
  assert.equal(param<BTParameterBoolean>(cut, "oppositeDirection").value, true);

  // Circular pattern: seed as a feature query, axis as the cylindrical face by signature.
  assert.equal(pattern.featureType, "circularPattern");
  const seed = param<BTParameterQueryList>(pattern, "instanceFunction").queries[0] as BTFeatureQuery;
  assert.equal(seed.btType, "BTMFeatureQueryWithOccurrence-157");
  assert.equal(seed.featureId, "F6");
  assert.deepEqual(ids(pattern, "axis"), ["F_cyl"]);
  assert.equal(param<BTParameterQuantity>(pattern, "instanceCount").expression, "4");
  assert.equal(param<BTParameterBoolean>(pattern, "equalSpace").value, true);
  const axis = report.features[6]!.refs.find((r) => r.parameterId === "axis")!;
  assert.equal(axis.resolver, "signature");
  assert.equal(axis.candidates, 4);

  const md = renderMarkdown(report);
  assert.match(md, /\| 2 \| Revolve1 \| revolve \| exact \| built \(OK\) \|/);
  assert.match(md, /\| 7 \| CirPattern1 \| circularPattern \| exact \| built \(OK\) \|/);
  assert.match(md, /Ref `f2\.axis`: .*sketchEntity.* -> E_l1 via probe/);
});

test("a sketch-entity selection that matches two sketch curves is a tie, not a guess", async () => {
  const world = shaftWorld();
  // Two coincident copies of l1 in the sketch's edge list.
  world.topology.Sketch1!.edge!.push(line("E_l1_dup", [0, 0, 0], [0.02, 0, 0]));
  const report = await buildDocument(shaft, new FakeOnshape(world), { behavior: false });
  const revolve = report.features.find((f) => f.irId === "f2")!;
  assert.equal(revolve.status, "failed");
  assert.match(revolve.error!, /candidates tie/);
});

test("a sketch-entity selection with no nearby curve fails with a reason", async () => {
  const world = shaftWorld();
  world.topology.Sketch1!.edge = world.topology.Sketch1!.edge!.filter((e) => e.ids[0] !== "E_l1");
  const report = await buildDocument(shaft, new FakeOnshape(world), { behavior: false });
  const revolve = report.features.find((f) => f.irId === "f2")!;
  assert.equal(revolve.status, "failed");
  assert.match(revolve.error!, /no edge of sketch f1 matches entity "l1"/);
});
