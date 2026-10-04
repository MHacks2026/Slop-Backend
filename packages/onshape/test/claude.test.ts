import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDocument, type Document } from "@slop/ir";
import { ClaudePlanner } from "../src/planner/claude.ts";
import type { StepContext } from "../src/plan/executor.ts";

const plate = JSON.parse(readFileSync(fileURLToPath(new URL("../../ir/fixtures/plate.ir.json", import.meta.url)), "utf8")) as Document;
assertValidDocument(plate);

test("ClaudePlanner submits a schema-valid step through the tool loop", async () => {
  const ops = [
    {
      op: "createSketch",
      id: "f1",
      intent: "rectangle on Front",
      rung: "exact",
      name: "Sketch1",
      plane: { kind: "datum", name: "FRONT" },
      entities: [{ id: "l1", type: "line", construction: false, p0: [0, 0], p1: [0.05, 0] }],
      constraints: [],
      dimensions: [],
    },
  ];

  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        content: [{ type: "tool_use", id: "t1", name: "submit_step", input: { reasoning: "direct sketch", ops } }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const planner = new ClaudePlanner({ apiKey: "test-key", fetchImpl });
  const ctx = {
    ir: plate,
    onshapeId: () => undefined,
    sketchFrame: () => undefined,
    datumFrame: async () => ({ origin: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0] }),
    listTopology: async () => [],
    opsFor: () => [],
  } as unknown as StepContext;

  const proposal = await planner.proposeStep({ ir: plate, feature: plate.partStudio.features[0]!, index: 0, priorSteps: [], context: ctx });
  assert.equal(proposal.ops[0]!.op, "createSketch");
  assert.equal(planner.usage().calls, 1);
  assert.equal(planner.usage().inputTokens, 10);
});

test("feedback answers the submit_step tool call as a tool_result, as the Messages API requires", async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const submit = (id: string) =>
    new Response(
      JSON.stringify({
        content: [
          {
            type: "tool_use",
            id,
            name: "submit_step",
            input: {
              reasoning: "r",
              ops: [{ op: "createSketch", id: "f1", intent: "i", rung: "exact", name: "Sketch1", plane: { kind: "datum", name: "FRONT" }, entities: [], constraints: [], dimensions: [] }],
            },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  let n = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return submit(`toolu_${++n}`);
  };
  const planner = new ClaudePlanner({ apiKey: "test-key", fetchImpl });
  const ctx = { ir: plate, onshapeId: () => undefined, sketchFrame: () => undefined, datumFrame: async () => ({ origin: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0] }), listTopology: async () => [], opsFor: () => [] } as unknown as StepContext;
  const req = { ir: plate, feature: plate.partStudio.features[0]!, index: 0, priorSteps: [], context: ctx };

  const first = await planner.proposeStep(req);
  await planner.reviseStep(req, first, { ok: false, errors: ["volume off"], featureStatuses: [], checks: [], summary: "Level 1 divergence: volume" });

  const revision = bodies[1]!.messages;
  assert.equal(revision.at(-1)!.role, "user");
  const blocks = revision.at(-1)!.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
  assert.equal(blocks[0]!.type, "tool_result");
  assert.equal(blocks[0]!.tool_use_id, "toolu_1");
  assert.match(blocks[0]!.content!, /Level 1 divergence: volume/);
  // The assistant turn before it is the submit_step call, so the pair is well-formed.
  assert.equal(revision.at(-2)!.role, "assistant");
});
