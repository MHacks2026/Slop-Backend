import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDocument, hashDocument, validateDocument, type Document, type ExtrudeFeature, type FilletFeature } from "../src/index.ts";

const plate = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/plate.ir.json", import.meta.url)), "utf8")) as Document;

const clone = <T>(v: T): T => structuredClone(v);
const feature = <F>(doc: Document, id: string) => doc.partStudio.features.find((f) => f.id === id) as F;

test("plate fixture validates (schema + structure)", () => {
  const r = validateDocument(plate);
  assert.deepEqual(r, { ok: true, schema: [], structure: [] });
});

test("rollback order: a feature cannot reference a later feature", () => {
  const doc = clone(plate);
  const f2 = feature<ExtrudeFeature>(doc, "f2");
  f2.profile = { kind: "feature-output", feature: "f3", role: "region" };
  const r = validateDocument(doc);
  assert.equal(r.ok, false);
  assert.match(r.structure[0]!.message, /does not precede "f2"/);
});

test("feature-output role must match the target op", () => {
  const doc = clone(plate);
  const f4 = feature<ExtrudeFeature>(doc, "f4");
  f4.profile = { kind: "feature-output", feature: "f2", role: "region" };
  const r = validateDocument(doc);
  assert.equal(r.ok, false);
  assert.match(r.structure[0]!.message, /must target a sketch/);
});

test("sketch args must name entities of that sketch", () => {
  const doc = clone(plate);
  feature<any>(doc, "f1").constraints.push({ type: "horizontal", args: ["l9"] });
  const r = validateDocument(doc);
  assert.equal(r.ok, false);
  assert.match(r.structure[0]!.message, /unknown sketch entity "l9"/);
});

test("schema rejects unknown feature fields and non-SI units", () => {
  const doc = clone(plate) as any;
  doc.partStudio.features[1].depth = 10;
  doc.partStudio.features[4].radius.unit = "mm";
  const r = validateDocument(doc);
  assert.equal(r.ok, false);
  assert.ok(r.schema.length > 0);
});

test("intent hash is stable under key order and ignores evidence", () => {
  const a = hashDocument(plate);

  // Reorder keys everywhere.
  const shuffled = JSON.parse(JSON.stringify(plate, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  assert.equal(hashDocument(shuffled).intent, a.intent);

  // Change evidence only.
  const noEvidence = clone(plate);
  for (const f of noEvidence.partStudio.features) delete f.evidence;
  const b = hashDocument(noEvidence);
  assert.equal(b.intent, a.intent);
  assert.deepEqual(b.features, a.features);

  // Change intent.
  const edited = clone(plate);
  feature<FilletFeature>(edited, "f5").radius = { expr: "3 mm", value: 0.003, unit: "m" };
  const c = hashDocument(edited);
  assert.notEqual(c.intent, a.intent);
  assert.notEqual(c.features["f5"], a.features["f5"]);
  assert.equal(c.features["f4"], a.features["f4"]);
});

test("plate evidence matches analytic geometry (doc §16 step 5)", () => {
  assertValidDocument(plate);
  const W = 0.05, H = 0.03, T = 0.01, R = 0.0025, r = 0.002;
  const rel = (actual: number, expected: number, tol: number) => assert.ok(Math.abs(actual - expected) / expected < tol, `${actual} vs ${expected}`);

  const v2 = feature<ExtrudeFeature>(plate, "f2").evidence!;
  rel(v2.volume, W * H * T, 1e-9);
  rel(v2.area, 2 * (W * H + W * T + H * T), 1e-9);

  const v4 = feature<ExtrudeFeature>(plate, "f4").evidence!;
  const hole = Math.PI * R * R * T;
  rel(v4.volume, W * H * T - hole, 1e-6);
  rel(v4.area, 2 * (W * H + W * T + H * T) - 2 * Math.PI * R * R + 2 * Math.PI * R * T, 1e-5);

  // Fillet on a convex 90° edge around a circle of radius R (Pappus).
  const v5 = feature<FilletFeature>(plate, "f5").evidence!;
  const cornerArea = r * r * (1 - Math.PI / 4);
  const cornerCentroid = r * (5 / 6 - Math.PI / 4) / (1 - Math.PI / 4);
  const filletRemoved = 2 * Math.PI * (R + cornerCentroid) * cornerArea;
  rel(v5.volume, v4.volume - filletRemoved, 1e-6);
  const arcLen = (Math.PI * r) / 2;
  const arcRadial = R + r - r * Math.sin(Math.PI / 4) / (Math.PI / 4) * Math.SQRT1_2;
  const filletSurface = arcLen * 2 * Math.PI * arcRadial;
  const lostTop = Math.PI * ((R + r) ** 2 - R * R);
  const lostWall = 2 * Math.PI * R * r;
  rel(v5.area, v4.area - lostTop - lostWall + filletSurface, 1e-5);
});

test("behaviour evidence is evidence: outside the intent hash, and its targets must exist", () => {
  assert.ok(plate.behaviorEvidence && plate.behaviorEvidence.length >= 5);

  const without = clone(plate);
  delete without.behaviorEvidence;
  assert.equal(hashDocument(without).intent, hashDocument(plate).intent);

  const bad = clone(plate);
  bad.behaviorEvidence!.push({ target: "D9@Nowhere", expression: "1 mm", evidence: plate.behaviorEvidence![0]!.evidence });
  const r = validateDocument(bad);
  assert.equal(r.ok, false);
  assert.match(r.structure[0]!.message, /unknown dimension or parameter "D9@Nowhere"/);
});
