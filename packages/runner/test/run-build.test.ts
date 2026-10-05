import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RulePlanner } from "@slop/onshape";
import { FakeOnshape, plateWorld } from "../../onshape/test/fake.ts";
import { runBuild, type RunEvent } from "../src/run-build.ts";

const plate = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/plate.ir.json", import.meta.url)), "utf8"));

function sink() {
  const events: RunEvent[] = [];
  return { events, emit: (e: RunEvent) => void events.push(e) };
}
const kinds = (events: RunEvent[]) => events.filter((e) => e.kind !== "log").map((e) => e.kind);
const rules = () => new RulePlanner();

test("a valid IR builds, streams document / featureStart / attempt / feature / behaviour / finished events in order, and succeeds", async () => {
  const { events, emit } = sink();
  const api = new FakeOnshape(plateWorld(plate));
  const out = await runBuild({ id: "b1", name: "plate", planner: "rules", ir: plate }, { api, planner: rules, emit });

  assert.equal(out.status, "succeeded");
  assert.equal(out.error, undefined);
  assert.deepEqual(out.document, { did: "D1", wid: "W1", eid: "E1" });
  assert.equal(out.irIntentHash?.length, 64);
  assert.equal(out.report?.summary.built, 5);

  const perFeature = ["featureStart", "attempt", "feature"];
  assert.deepEqual(kinds(events), ["document", ...perFeature, ...perFeature, ...perFeature, ...perFeature, ...perFeature, "behavior", "behavior", "behavior", "behavior", "behavior", "finished"]);
  const attempts = events.filter((e) => e.kind === "attempt").map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(attempts.map((a) => [a.irId, a.n, a.outcome]), [["f1", 1, "accepted"], ["f2", 1, "accepted"], ["f3", 1, "accepted"], ["f4", 1, "accepted"], ["f5", 1, "accepted"]]);
  const starts = events.filter((e) => e.kind === "featureStart").map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(starts.map((s) => [s.index, s.irId, s.op]), [[0, "f1", "sketch"], [1, "f2", "extrude"], [2, "f3", "sketch"], [3, "f4", "extrude"], [4, "f5", "fillet"]]);
  const doc = events.find((e) => e.kind === "document")!;
  assert.equal((doc.payload as { url: string }).url, "https://cad.onshape.com/documents/D1/w/W1/e/E1");
  const features = events.filter((e) => e.kind === "feature").map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(
    features.map((f) => [f.index, f.total, f.irId, f.status, f.rung]),
    [
      [0, 5, "f1", "built", "exact"],
      [1, 5, "f2", "built", "exact"],
      [2, 5, "f3", "built", "exact"],
      [3, 5, "f4", "built", "exact"],
      [4, 5, "f5", "built", "exact"],
    ],
  );
  assert.equal(features[1]!.checksTotal, 8);
  const behaviors = events.filter((e) => e.kind === "behavior").map((e) => e.payload as Record<string, unknown>);
  assert.ok(behaviors.every((b) => b.status === "passed" && b.restored === true));
  const finished = events.at(-1)!;
  assert.equal(finished.kind, "finished");
  assert.deepEqual((finished.payload as { status: string; summary: { built: number } }).summary.built, 5);
  assert.ok(events.some((e) => e.kind === "log"), "log lines are recorded too");
});

test("an invalid IR fails before any Onshape call, with the validation issues as the error", async () => {
  const { events, emit } = sink();
  const api = new FakeOnshape(plateWorld(plate));
  const bad = structuredClone(plate);
  bad.partStudio.features[1].profile = { kind: "feature-output", feature: "f3", role: "region" }; // forward reference
  const out = await runBuild({ id: "b2", name: "bad", planner: "rules", ir: bad }, { api, planner: rules, emit });

  assert.equal(out.status, "failed");
  assert.match(out.error!, /invalid IR document/);
  assert.match(out.error!, /does not precede/);
  assert.equal(api.callCount(), 0);
  assert.deepEqual(kinds(events), ["finished"]);
});

test("a Level 1 divergence is a failed build that still reports what was built", async () => {
  const { events, emit } = sink();
  const api = new FakeOnshape(plateWorld(plate), {
    massProperties: (name, ev) => (ev ? { hasMass: false, volume: [name === "Cut-Extrude1" ? ev.volume * 1.02 : ev.volume], periphery: [ev.area], centroid: [0, 0, 0] } : undefined),
  });
  const out = await runBuild({ id: "b3", name: "plate", planner: "rules", ir: plate }, { api, planner: rules, emit });

  assert.equal(out.status, "failed");
  assert.match(out.error!, /Level 1 divergence: volume/);
  assert.equal(out.report?.stoppedEarly, true);
  const features = events.filter((e) => e.kind === "feature").map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(
    features.map((f) => [f.irId, f.status]),
    [
      ["f1", "built"],
      ["f2", "built"],
      ["f3", "built"],
      ["f4", "failed"],
    ],
  );
  assert.equal(events.filter((e) => e.kind === "behavior").length, 0, "no behaviour tests on an incomplete build");
  assert.equal(events.at(-1)!.kind, "finished");
});

test("a planner that cannot be created (no LLM key) fails the build cleanly", async () => {
  const { events, emit } = sink();
  const out = await runBuild(
    { id: "b4", name: "plate", planner: "claude", ir: plate },
    {
      api: new FakeOnshape(plateWorld(plate)),
      planner: (name) => {
        if (name === "claude") throw new Error("missing ANTHROPIC_API_KEY");
        return rules();
      },
      emit,
    },
  );
  assert.equal(out.status, "failed");
  assert.equal(out.error, "missing ANTHROPIC_API_KEY");
  assert.equal(out.irIntentHash?.length, 64, "the IR was valid; only the planner was missing");
  assert.deepEqual(kinds(events), ["finished"]);
});

test("an exception from Onshape mid-build is reported, not thrown, and the document is still recorded", async () => {
  const { events, emit } = sink();
  const api = new FakeOnshape(plateWorld(plate));
  let n = 0;
  const original = api.addFeature.bind(api);
  api.addFeature = async (ref, feature) => {
    if (++n === 3) throw new Error("HTTP 500 from Onshape");
    return original(ref, feature);
  };
  const out = await runBuild({ id: "b5", name: "plate", planner: "rules", ir: plate }, { api, planner: rules, emit });
  assert.equal(out.status, "failed");
  assert.match(out.error!, /HTTP 500/);
  assert.deepEqual(out.document, { did: "D1", wid: "W1", eid: "E1" });
  assert.equal(events.at(-1)!.kind, "finished");
});

test("a failing event sink does not fail the build", async () => {
  const api = new FakeOnshape(plateWorld(plate));
  const original = console.error;
  console.error = () => {};
  try {
    const out = await runBuild({ id: "b6", name: "plate", planner: "rules", ir: plate }, { api, planner: rules, emit: () => Promise.reject(new Error("db down")), behavior: false });
    assert.equal(out.status, "succeeded");
  } finally {
    console.error = original;
  }
});
