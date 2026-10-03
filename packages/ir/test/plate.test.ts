import { describe, expect, it } from "vitest";
import { Document, checkIntegrity, hashDocument, parseDocument } from "../src";
import { plate } from "../src/fixtures/plate";

describe("section 16 plate fixture", () => {
  it("parses against the schema", () => {
    expect(() => parseDocument(plate)).not.toThrow();
  });

  it("survives a JSON round trip unchanged", () => {
    const parsed = Document.parse(JSON.parse(JSON.stringify(plate)));
    expect(parsed).toEqual(plate);
  });

  it("has no integrity issues", () => {
    expect(checkIntegrity(plate)).toEqual([]);
  });

  it("has the expected tree", () => {
    const ops = plate.partStudios[0]!.features.map((f) => f.op);
    expect(ops).toEqual(["sketch", "extrude", "sketch", "extrude", "fillet"]);
  });

  it("evidence volumes match the analytic values", () => {
    const ev = plate.partStudios[0]!.evidence!;
    const volumes = ["f2", "f4", "f5"].map((id) => ev[id]!.bodies[0]!.volume * 1e9);
    expect(volumes[0]).toBeCloseTo(15000, 2);
    expect(volumes[1]).toBeCloseTo(14803.65, 2);
    expect(volumes[2]).toBeCloseTo(14787.76, 2);
  });

  it("intent hash ignores evidence, source and fidelity", async () => {
    const base = await hashDocument(plate);

    const stripped: Document = {
      ...plate,
      source: { cad: "onshape", extractedAt: "2026-01-01T00:00:00Z" },
      partStudios: plate.partStudios.map((ps) => {
        const { evidence: _e, ...rest } = ps;
        return {
          ...rest,
          features: rest.features.map((f) => ({ ...f, fidelity: { level: "exact" as const } })),
        };
      }),
    };
    const other = await hashDocument(stripped);
    expect(other.document).toBe(base.document);
  });

  it("changing one feature changes only that feature's hash and its ancestors", async () => {
    const base = await hashDocument(plate);
    const changed: Document = structuredClone(plate);
    const fillet = changed.partStudios[0]!.features[4]!;
    if (fillet.op !== "fillet") throw new Error("expected fillet");
    fillet.radius = { expr: "3 mm", value: 0.003, unit: "mm", name: "D1@Fillet1" };

    const other = await hashDocument(changed);
    expect(other.document).not.toBe(base.document);
    expect(other.partStudios.ps1!.hash).not.toBe(base.partStudios.ps1!.hash);
    expect(other.partStudios.ps1!.features.f5).not.toBe(base.partStudios.ps1!.features.f5);
    for (const id of ["f1", "f2", "f3", "f4"]) {
      expect(other.partStudios.ps1!.features[id]).toBe(base.partStudios.ps1!.features[id]);
    }
    expect(other.parameters).toBe(base.parameters);
  });
});
