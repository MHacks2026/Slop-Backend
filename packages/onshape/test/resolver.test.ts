import { test } from "node:test";
import assert from "node:assert/strict";
import type { TopoRef } from "@slop/ir";
import type { Candidate } from "../src/fs/topology.ts";
import { ResolveError, resolveTopo } from "../src/resolver.ts";

const circles: Candidate[] = [
  { id: "bottom", entity: "edge", type: "circle", center: [0.025, 0.015, 0], axis: [0, 0, 1], radius: 0.0025 },
  { id: "top", entity: "edge", type: "circle", center: [0.025, 0.015, 0.01], axis: [0, 0, 1], radius: 0.0025 },
];

test("signature picks the hole's top edge by circle centre", () => {
  const ref: TopoRef = { kind: "topo", entity: "edge", signature: { curve: "circle", radius: 0.0025, center: [0.025, 0.015, 0.01] } };
  const r = resolveTopo(ref, circles);
  assert.equal(r.id, "top");
  assert.equal(r.resolver, "signature");
  assert.ok(r.confidence > 0.99);
  assert.ok(r.runnerUp! < 1e-6);
});

test("kernel noise within tolerance still matches", () => {
  const ref: TopoRef = { kind: "topo", entity: "edge", signature: { curve: "circle", radius: 0.0025 + 2e-10, center: [0.025, 0.015, 0.01 + 3e-10] } };
  assert.equal(resolveTopo(ref, circles).id, "top");
});

test("ambiguous signature throws instead of guessing", () => {
  const ref: TopoRef = { kind: "topo", entity: "edge", signature: { curve: "circle", radius: 0.0025 } };
  assert.throws(() => resolveTopo(ref, circles), (e: unknown) => e instanceof ResolveError && e.scores.length === 2);
});

test("probe breaks a tie the signature cannot", () => {
  const ref: TopoRef = { kind: "topo", entity: "edge", signature: { curve: "circle", radius: 0.0025 }, probe: [0.0275, 0.015, 0.01] };
  const r = resolveTopo(ref, circles);
  assert.equal(r.id, "top");
  assert.equal(r.resolver, "probe");
});

test("wrong curve type scores zero", () => {
  const ref: TopoRef = { kind: "topo", entity: "edge", signature: { curve: "line", length: 0.05 } };
  assert.throws(() => resolveTopo(ref, circles), ResolveError);
});

test("plane face by normal and offset; opposite normal is rejected", () => {
  const faces: Candidate[] = [
    { id: "cap", entity: "face", type: "plane", origin: [0.025, 0.015, 0.01], normal: [0, 0, 1], x: [1, 0, 0] },
    { id: "bottom", entity: "face", type: "plane", origin: [0.025, 0.015, 0], normal: [0, 0, -1], x: [1, 0, 0] },
    { id: "side", entity: "face", type: "plane", origin: [0.05, 0.015, 0.005], normal: [1, 0, 0], x: [0, 1, 0] },
  ];
  const ref: TopoRef = { kind: "topo", entity: "face", signature: { surface: "plane", normal: [0, 0, 1], offset: 0.01 } };
  assert.equal(resolveTopo(ref, faces).id, "cap");
  const flipped: TopoRef = { kind: "topo", entity: "face", signature: { surface: "plane", normal: [0, 0, -1], offset: -0.01 } };
  assert.throws(() => resolveTopo(flipped, faces), ResolveError);
});

test("a single candidate with no signature resolves semantically", () => {
  const r = resolveTopo({ kind: "topo", entity: "face" }, [{ id: "only", entity: "face", type: "cylinder" }]);
  assert.equal(r.resolver, "semantic");
  assert.equal(r.id, "only");
});
