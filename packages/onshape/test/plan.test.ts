import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStepProposal, PlanValidationError } from "../src/plan/validate.ts";

test("a valid sketch+extrude proposal passes the plan schema", () => {
  const proposal = validateStepProposal({
    reasoning: "direct extrude of Sketch1",
    ops: [
      {
        op: "createSketch",
        id: "f1",
        intent: "rectangle on Front",
        rung: "exact",
        name: "Sketch1",
        plane: { kind: "datum", name: "FRONT" },
        entities: [{ id: "l1", type: "line", construction: false, p0: [0, 0], p1: [0.05, 0] }],
        constraints: [{ type: "horizontal", args: ["l1"] }],
        dimensions: [{ id: "D1@Sketch1", type: "distance", args: ["l1"], value: { expr: "50 mm", value: 0.05, unit: "m" }, driving: true }],
      },
      {
        op: "createFeature",
        id: "f2",
        intent: "extrude 10 mm",
        rung: "exact",
        name: "Boss-Extrude1",
        featureType: "extrude",
        parameters: [
          { id: "operationType", enum: { name: "NewBodyOperationType", value: "NEW" } },
          { id: "entities", selections: [{ kind: "sketchRegion", sketch: "f1" }] },
          { id: "depth", quantity: "10 mm" },
        ],
      },
    ],
  });
  assert.equal(proposal.ops.length, 2);
});

test("duplicate op ids and unknown rungs are rejected", () => {
  assert.throws(
    () =>
      validateStepProposal({
        reasoning: "x",
        ops: [
          { op: "createVariable", id: "v", intent: "w", rung: "exact", name: "W", expression: "50 mm" },
          { op: "createVariable", id: "v", intent: "w", rung: "exact", name: "H", expression: "30 mm" },
        ],
      }),
    (e: unknown) => e instanceof PlanValidationError && e.issues.some((i) => /duplicate/.test(i)),
  );
  assert.throws(
    () => validateStepProposal({ reasoning: "x", ops: [{ op: "createVariable", id: "v", intent: "w", rung: "maybe", name: "W", expression: "1" }] }),
    PlanValidationError,
  );
});
