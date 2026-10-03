/**
 * JSON Schema for a step proposal: what the LLM must hand back through the
 * `submit_step` tool. Shared with the executor's validation so the same
 * schema gates both the model's output and any replayed plan.
 *
 * Sketch entity / constraint / dimension shapes are imported from the IR
 * schema by reference, so the translator writes sketches in the same
 * vocabulary it read them in.
 */
import irSchema from "@slop/ir/schema" with { type: "json" };

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const vec3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const rung = { enum: ["exact", "composite", "featurescript", "approximated", "geometry", "dropped"] };

const selection = {
  oneOf: [
    { type: "object", required: ["kind", "name"], additionalProperties: false, properties: { kind: { const: "datum" }, name: { enum: ["FRONT", "TOP", "RIGHT"] } } },
    { type: "object", required: ["kind"], additionalProperties: false, properties: { kind: { const: "origin" } } },
    { type: "object", required: ["kind", "sketch"], additionalProperties: false, properties: { kind: { const: "sketchRegion" }, sketch: { type: "string" } } },
    { type: "object", required: ["kind", "irFeature", "path"], additionalProperties: false, properties: { kind: { const: "irRef" }, irFeature: { type: "string" }, path: { type: "string" } } },
    { type: "object", required: ["kind", "ids"], additionalProperties: false, properties: { kind: { const: "entities" }, ids: { type: "array", minItems: 1, items: { type: "string" } } } },
    {
      type: "object",
      required: ["kind", "feature", "entity"],
      additionalProperties: false,
      properties: {
        kind: { const: "createdBy" },
        feature: { type: "string" },
        entity: { enum: ["face", "edge", "vertex"] },
        where: {
          type: "object",
          additionalProperties: false,
          properties: { type: { type: "string" }, normal: vec3, offset: { type: "number" }, radius: { type: "number" }, near: vec3 },
        },
      },
    },
  ],
};

const parameterValue = {
  oneOf: [
    { type: "object", required: ["id", "quantity"], additionalProperties: false, properties: { id: { type: "string" }, quantity: { type: "string" } } },
    { type: "object", required: ["id", "enum"], additionalProperties: false, properties: { id: { type: "string" }, enum: { type: "object", required: ["name", "value"], additionalProperties: false, properties: { name: { type: "string" }, value: { type: "string" } } } } },
    { type: "object", required: ["id", "boolean"], additionalProperties: false, properties: { id: { type: "string" }, boolean: { type: "boolean" } } },
    { type: "object", required: ["id", "string"], additionalProperties: false, properties: { id: { type: "string" }, string: { type: "string" } } },
    { type: "object", required: ["id", "selections"], additionalProperties: false, properties: { id: { type: "string" }, selections: { type: "array", items: ref("Selection") } } },
  ],
};

const opBase = {
  id: { type: "string", pattern: "^[A-Za-z0-9_.-]+$" },
  intent: { type: "string", minLength: 1 },
  rung,
  enhancement: { type: "boolean" },
};

const op = {
  oneOf: [
    {
      type: "object",
      required: ["op", "id", "intent", "rung", "name", "expression"],
      additionalProperties: false,
      properties: { ...opBase, op: { const: "createVariable" }, name: { type: "string" }, expression: { type: "string" } },
    },
    {
      type: "object",
      required: ["op", "id", "intent", "rung", "name", "plane", "entities", "constraints", "dimensions"],
      additionalProperties: false,
      properties: {
        ...opBase,
        op: { const: "createSketch" },
        name: { type: "string" },
        plane: ref("Selection"),
        irSketch: { type: "string" },
        entities: { type: "array", items: ref("SketchEntity") },
        constraints: { type: "array", items: ref("Constraint") },
        dimensions: { type: "array", items: ref("Dimension") },
      },
    },
    {
      type: "object",
      required: ["op", "id", "intent", "rung", "name", "featureType", "parameters"],
      additionalProperties: false,
      properties: { ...opBase, op: { const: "createFeature" }, name: { type: "string" }, featureType: { type: "string" }, parameters: { type: "array", items: ref("ParameterValue") } },
    },
    {
      type: "object",
      required: ["op", "id", "intent", "rung", "name", "namespace", "featureType", "parameters"],
      additionalProperties: false,
      properties: { ...opBase, op: { const: "insertCustomFeature" }, name: { type: "string" }, namespace: { type: "string" }, featureType: { type: "string" }, parameters: { type: "array", items: ref("ParameterValue") } },
    },
    {
      type: "object",
      required: ["op", "id", "intent", "rung", "name", "brepBefore", "brepAfter"],
      additionalProperties: false,
      properties: { ...opBase, op: { const: "geometryPatch" }, name: { type: "string" }, brepBefore: { type: "string" }, brepAfter: { type: "string" } },
    },
  ],
};

const irDefs = (irSchema as { $defs: Record<string, unknown> }).$defs;

/** Schema for one step proposal (the `submit_step` tool input). */
export const stepProposalSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://slop.dev/schemas/plan/0.1.0/step.schema.json",
  type: "object",
  required: ["ops", "reasoning"],
  additionalProperties: false,
  properties: {
    reasoning: { type: "string", description: "Why these operations reproduce the source feature's intent." },
    ops: { type: "array", items: ref("Op") },
  },
  $defs: {
    Selection: selection,
    ParameterValue: parameterValue,
    Op: op,
    // Reuse the IR's sketch vocabulary so sketches are written as they were read.
    ...pick(irDefs, ["Id", "Vec2", "Vec3", "Unit", "Quantity", "DatumRef", "FeatureOutputRef", "FaceSignature", "EdgeSignature", "VertexSignature", "TopoRef", "Ref", "SketchEntityBase", "SketchEntity", "SketchArg", "Constraint", "Dimension"]),
  },
} as const;

/** Schema for the behaviour-test proposal tool. */
export const behaviorTestsSchema = {
  type: "object",
  required: ["tests"],
  additionalProperties: false,
  properties: {
    tests: {
      type: "array",
      items: {
        type: "object",
        required: ["target", "expression", "expectation"],
        additionalProperties: false,
        properties: { target: { type: "string" }, expression: { type: "string" }, expectation: { type: "string" } },
      },
    },
  },
} as const;

function pick<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
