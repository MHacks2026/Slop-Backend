import type { Document } from "../schema/document";
import type { Quantity } from "../schema/primitives";

/**
 * The example part from the architecture doc, section 16.
 *
 * A 50 x 30 mm rectangle on the Front plane with one corner on the origin,
 * extruded 10 mm; a 5 mm hole sketched on the top face at the centre and cut
 * through all; a 2 mm fillet on the top rim of the hole. The fillet references
 * an edge created by the cut, which is the hard case for reference resolution.
 *
 * All coordinates are SI (metres). Evidence values are the analytic numbers
 * from the document; face counts assume Parasolid keeps the hole wall as one
 * face, which is inferred and must be confirmed in Phase 0.
 */

const mm = (v: number, extra: Partial<Quantity> = {}): Quantity => ({
  expr: `${v} mm`,
  value: v / 1000,
  unit: "mm",
  ...extra,
});

export const plate: Document = {
  irVersion: "0.1.0",
  id: "plate-example",
  name: "plate",
  source: {
    cad: "solidworks",
    version: "SOLIDWORKS 2025",
    fileName: "plate.sldprt",
    extractor: { name: "fixture", version: "0" },
  },
  units: { length: "mm", angle: "deg" },
  parameters: [],
  configurations: [{ id: "cfg-default", name: "Default", overrides: [] }],
  activeConfiguration: "cfg-default",
  assemblies: [],
  partStudios: [
    {
      id: "ps1",
      name: "plate",
      bodies: [{ id: "body1", type: "solid" }],
      features: [
        {
          id: "f1",
          name: "Sketch1",
          op: "sketch",
          suppressed: false,
          plane: { kind: "datum", name: "FRONT" },
          frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
          entities: [
            { id: "l1", type: "line", construction: false, p0: [0, 0], p1: [0.05, 0] },
            { id: "l2", type: "line", construction: false, p0: [0.05, 0], p1: [0.05, 0.03] },
            { id: "l3", type: "line", construction: false, p0: [0.05, 0.03], p1: [0, 0.03] },
            { id: "l4", type: "line", construction: false, p0: [0, 0.03], p1: [0, 0] },
          ],
          constraints: [
            { type: "horizontal", args: ["l1"] },
            { type: "horizontal", args: ["l3"] },
            { type: "vertical", args: ["l2"] },
            { type: "vertical", args: ["l4"] },
            { type: "coincident", args: ["l1.start", "ORIGIN"] },
            { type: "coincident", args: ["l1.end", "l2.start"] },
            { type: "coincident", args: ["l2.end", "l3.start"] },
            { type: "coincident", args: ["l3.end", "l4.start"] },
            { type: "coincident", args: ["l4.end", "l1.start"] },
          ],
          dimensions: [
            { id: "D1@Sketch1", type: "distance", args: ["l1"], value: mm(50), driving: true },
            { id: "D2@Sketch1", type: "distance", args: ["l2"], value: mm(30), driving: true },
          ],
          solved: "fullyDefined",
        },
        {
          id: "f2",
          name: "Boss-Extrude1",
          op: "extrude",
          suppressed: false,
          parents: ["f1"],
          mode: "new",
          profile: [{ kind: "feature-output", feature: "f1", role: "region", index: 0 }],
          flip: false,
          end: { type: "blind", depth: mm(10, { name: "D1@Boss-Extrude1" }) },
          merge: true,
        },
        {
          id: "f3",
          name: "Sketch2",
          op: "sketch",
          suppressed: false,
          parents: ["f2"],
          plane: {
            kind: "topo",
            entity: "face",
            createdBy: "f2",
            role: "cap:end",
            sourceId: "sw-persist-face-top",
            signature: { type: "face", surface: "plane", normal: [0, 0, 1], origin: [0, 0, 0.01], area: 0.0015 },
          },
          frame: { origin: [0, 0, 0.01], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
          entities: [{ id: "c1", type: "circle", construction: false, center: [0.025, 0.015], r: 0.0025 }],
          constraints: [],
          dimensions: [
            { id: "D1@Sketch2", type: "diameter", args: ["c1"], value: mm(5), driving: true },
            { id: "D2@Sketch2", type: "distance", args: ["c1.center", "ext:leftEdge"], value: mm(25), driving: true },
            { id: "D3@Sketch2", type: "distance", args: ["c1.center", "ext:bottomEdge"], value: mm(15), driving: true },
          ],
          externalRefs: {
            leftEdge: {
              kind: "topo",
              entity: "edge",
              createdBy: "f2",
              role: "between(f2.cap:end, f2.side:l4)",
              sourceId: "sw-persist-edge-top-left",
              signature: {
                type: "edge",
                curve: "line",
                start: [0, 0, 0.01],
                end: [0, 0.03, 0.01],
                midpoint: [0, 0.015, 0.01],
                length: 0.03,
                adjacentSurfaces: ["plane", "plane"],
              },
            },
            bottomEdge: {
              kind: "topo",
              entity: "edge",
              createdBy: "f2",
              role: "between(f2.cap:end, f2.side:l1)",
              sourceId: "sw-persist-edge-top-bottom",
              signature: {
                type: "edge",
                curve: "line",
                start: [0, 0, 0.01],
                end: [0.05, 0, 0.01],
                midpoint: [0.025, 0, 0.01],
                length: 0.05,
                adjacentSurfaces: ["plane", "plane"],
              },
            },
          },
          solved: "fullyDefined",
        },
        {
          id: "f4",
          name: "Cut-Extrude1",
          op: "extrude",
          suppressed: false,
          parents: ["f3"],
          mode: "remove",
          profile: [{ kind: "feature-output", feature: "f3", role: "region", index: 0 }],
          flip: true,
          end: { type: "throughAll" },
          merge: true,
        },
        {
          id: "f5",
          name: "Fillet1",
          op: "fillet",
          suppressed: false,
          parents: ["f4"],
          radius: mm(2, { name: "D1@Fillet1" }),
          edges: [
            {
              kind: "topo",
              entity: "edge",
              createdBy: "f4",
              role: "between(f4.side:c1, f2.cap:end)",
              sourceId: "sw-persist-edge-hole-top",
              signature: {
                type: "edge",
                curve: "circle",
                center: [0.025, 0.015, 0.01],
                axis: [0, 0, 1],
                radius: 0.0025,
                adjacentSurfaces: ["cylinder", "plane"],
              },
            },
          ],
          selectionMode: "single",
          tangentPropagation: true,
        },
      ],
      evidence: {
        f2: {
          feature: "f2",
          bodies: [
            {
              type: "solid",
              volume: 15000e-9,
              area: 4600e-6,
              bbox: { min: [0, 0, 0], max: [0.05, 0.03, 0.01] },
              faceCount: 6,
              faceTypes: { plane: 6 },
            },
          ],
          created: {
            faces: ["sw-persist-face-top", "sw-persist-face-bottom", "sw-persist-face-l1", "sw-persist-face-l2", "sw-persist-face-l3", "sw-persist-face-l4"],
            edges: ["sw-persist-edge-top-left", "sw-persist-edge-top-bottom"],
          },
        },
        f4: {
          feature: "f4",
          bodies: [
            {
              type: "solid",
              volume: 14803.65e-9,
              area: 4717.81e-6,
              bbox: { min: [0, 0, 0], max: [0.05, 0.03, 0.01] },
              faceCount: 7,
              faceTypes: { plane: 6, cylinder: 1 },
            },
          ],
          created: { faces: ["sw-persist-face-hole"], edges: ["sw-persist-edge-hole-top", "sw-persist-edge-hole-bottom"] },
        },
        f5: {
          feature: "f5",
          bodies: [
            {
              type: "solid",
              volume: 14787.76e-9,
              area: 4706.11e-6,
              bbox: { min: [0, 0, 0], max: [0.05, 0.03, 0.01] },
              faceCount: 8,
              faceTypes: { plane: 6, cylinder: 1, torus: 1 },
            },
          ],
          created: { faces: ["sw-persist-face-fillet"] },
        },
      },
    },
  ],
};
