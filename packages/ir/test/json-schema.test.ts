import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildJsonSchema } from "../src/json-schema";
import { plate } from "../src/fixtures/plate";

const schema = buildJsonSchema();

function compile() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("generated JSON Schema", () => {
  it("names every core node in $defs", () => {
    const defs = Object.keys((schema.$defs as Record<string, unknown>) ?? {});
    for (const name of ["Feature", "SketchFeature", "ExtrudeFeature", "Ref", "TopoRef", "Quantity", "Parameter", "Configuration", "PartStudio", "Assembly", "FeatureEvidence"]) {
      expect(defs).toContain(name);
    }
  });

  it("accepts the plate fixture", () => {
    const validate = compile();
    const ok = validate(JSON.parse(JSON.stringify(plate)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects a document with an unknown feature op", () => {
    const validate = compile();
    const bad = JSON.parse(JSON.stringify(plate));
    bad.partStudios[0].features[1].op = "extrood";
    expect(validate(bad)).toBe(false);
  });

  it("rejects a sketch arg with a bad sub-point syntax", () => {
    const validate = compile();
    const bad = JSON.parse(JSON.stringify(plate));
    bad.partStudios[0].features[0].constraints[0].args = ["l1.left"];
    expect(validate(bad)).toBe(false);
  });

  it("matches the checked-in schema/ir.schema.json (run `npm run gen:schema` after schema changes)", () => {
    const onDisk = JSON.parse(readFileSync(resolve(__dirname, "../schema/ir.schema.json"), "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(schema)));
  });
});
