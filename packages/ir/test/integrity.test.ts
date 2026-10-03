import { describe, expect, it } from "vitest";
import type { Document } from "../src";
import { checkIntegrity } from "../src";
import { plate } from "../src/fixtures/plate";

function mutate(fn: (doc: Document) => void): Document {
  const doc = structuredClone(plate);
  fn(doc);
  return doc;
}

const codes = (doc: Document) => checkIntegrity(doc).map((i) => i.code);

describe("integrity checks", () => {
  it("rejects a reference to a later feature", () => {
    const doc = mutate((d) => {
      const f = d.partStudios[0]!.features;
      [f[1], f[2]] = [f[2]!, f[1]!]; // Sketch2 now precedes the extrude it sits on
    });
    expect(codes(doc)).toContain("forward-reference");
  });

  it("rejects a reference to a missing feature", () => {
    const doc = mutate((d) => {
      const fillet = d.partStudios[0]!.features[4]!;
      if (fillet.op !== "fillet") throw new Error("expected fillet");
      const edge = fillet.edges[0]!;
      if (edge.kind !== "topo") throw new Error("expected topo ref");
      edge.createdBy = "nope";
    });
    expect(codes(doc)).toContain("unknown-feature");
  });

  it("rejects duplicate feature ids", () => {
    const doc = mutate((d) => {
      d.partStudios[0]!.features[4]!.id = "f4";
    });
    expect(codes(doc)).toContain("duplicate-id");
  });

  it("rejects a sketch arg that names an unknown entity", () => {
    const doc = mutate((d) => {
      const s = d.partStudios[0]!.features[0]!;
      if (s.op === "sketch") s.constraints[0]!.args = ["l9"];
    });
    expect(codes(doc)).toContain("unknown-sketch-entity");
  });

  it("rejects a sub-point the entity does not have", () => {
    const doc = mutate((d) => {
      const s = d.partStudios[0]!.features[0]!;
      if (s.op === "sketch") s.constraints[0]!.args = ["l1.center"];
    });
    expect(codes(doc)).toContain("invalid-sub-point");
  });

  it("rejects an external ref the sketch does not declare", () => {
    const doc = mutate((d) => {
      const s = d.partStudios[0]!.features[2]!;
      if (s.op === "sketch") s.dimensions[1]!.args = ["c1.center", "ext:missing"];
    });
    expect(codes(doc)).toContain("unknown-external-ref");
  });

  it("rejects a region ref that points at a non-sketch", () => {
    const doc = mutate((d) => {
      const cut = d.partStudios[0]!.features[3]!;
      if (cut.op === "extrude") cut.profile = [{ kind: "feature-output", feature: "f2", role: "region" }];
    });
    expect(codes(doc)).toContain("wrong-feature-kind");
  });

  it("accepts an equation that targets a feature-level named quantity", () => {
    const doc = mutate((d) => {
      d.parameters.push({
        id: "p1",
        name: "D1@Boss-Extrude1",
        scope: "global",
        expr: '"D1@Sketch1" / 5',
        value: 0.01,
        unit: "mm",
        target: "D1@Boss-Extrude1",
      });
    });
    expect(codes(doc)).toEqual([]);
  });

  it("rejects an equation that targets nothing", () => {
    const doc = mutate((d) => {
      d.parameters.push({ id: "p1", name: "x", scope: "global", expr: "1", value: 1, unit: "unitless", target: "D9@Nope" });
    });
    expect(codes(doc)).toContain("unknown-dimension");
  });

  it("rejects configuration overrides of unknown nodes", () => {
    const doc = mutate((d) => {
      d.configurations[0]!.overrides.push({ kind: "suppression", feature: "ghost", suppressed: true });
      d.configurations[0]!.parent = "nope";
      d.activeConfiguration = "also-nope";
    });
    const c = codes(doc);
    expect(c).toContain("unknown-feature");
    expect(c.filter((x) => x === "unknown-configuration")).toHaveLength(2);
  });

  it("rejects evidence keyed by a different feature", () => {
    const doc = mutate((d) => {
      d.partStudios[0]!.evidence!.f2!.feature = "f3";
    });
    expect(codes(doc)).toContain("evidence-mismatch");
  });

  it("resolves mate instance paths through subassemblies", () => {
    const doc = mutate((d) => {
      d.assemblies.push(
        {
          id: "sub",
          name: "sub",
          instances: [{ id: "i1", name: "plate-1", component: { kind: "partStudio", partStudio: "ps1" }, transform: IDENTITY, fixed: false, suppressed: false }],
          mates: [],
        },
        {
          id: "top",
          name: "top",
          instances: [
            { id: "s1", name: "sub-1", component: { kind: "assembly", assembly: "sub" }, transform: IDENTITY, fixed: true, suppressed: false },
            { id: "i2", name: "plate-2", component: { kind: "partStudio", partStudio: "ps1" }, transform: IDENTITY, fixed: false, suppressed: false },
          ],
          mates: [
            {
              id: "m1",
              name: "Coincident1",
              type: "coincident",
              suppressed: false,
              entities: [
                { instancePath: ["s1", "i1"], ref: { kind: "topo", entity: "face", createdBy: "f2", role: "cap:end" } },
                { instancePath: ["i2"], ref: { kind: "topo", entity: "face", createdBy: "f2", role: "cap:start" } },
              ],
            },
            {
              id: "m2",
              name: "Broken",
              type: "coincident",
              suppressed: false,
              entities: [{ instancePath: ["i2", "deeper"], ref: { kind: "datum", name: "TOP" } }],
            },
          ],
        },
      );
    });
    const issues = checkIntegrity(doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("unknown-instance");
    expect(issues[0]!.path).toContain("/mates/1/");
  });
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
