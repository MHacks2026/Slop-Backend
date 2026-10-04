import type { Document, Evidence, Vec3 } from "@slop/ir";
import type { OnshapeApi } from "../src/client/api.ts";
import type { AddFeatureResponse, BTFeature, DocumentRef, FeatureListResponse, MassPropertiesBody } from "../src/client/types.ts";
import { decodeFsValue } from "../src/fs/values.ts";

/** Raw topology record as the FeatureScript lambda would return it (before BTFSValue wrapping). */
export interface RawRecord {
  ids: string[];
  type: string;
  [k: string]: unknown;
}

export interface World {
  /** Keyed by feature *name* (Onshape ids are assigned at add time) or datum name. */
  topology: Record<string, Partial<Record<"face" | "edge" | "vertex", RawRecord[]>>>;
  /** Evidence to report after each solid feature, by feature name. */
  evidence: Record<string, Evidence>;
}

/**
 * In-memory Onshape. Assigns feature ids, answers topology lambdas from a
 * scripted world, and reports mass properties from the IR's own evidence, so
 * the builder loop runs end to end without credentials. Results are
 * BTFSValue-encoded to exercise the decoder.
 */
export class FakeOnshape implements OnshapeApi {
  calls = 0;
  readonly added: Array<{ id: string; feature: BTFeature }> = [];
  private readonly nameById = new Map<string, string>();
  private lastSolid: string | undefined;
  private readonly solidTypes = new Set(["extrude", "revolve", "fillet", "chamfer", "hole", "shell", "linearPattern", "circularPattern", "mirror"]);

  constructor(
    private readonly world: World,
    private readonly overrides: { massProperties?: (name: string | undefined, evidence: Evidence | undefined) => MassPropertiesBody | undefined } = {},
  ) {}

  callCount(): number {
    return this.calls;
  }

  async createDocument(): Promise<DocumentRef> {
    this.calls += 2;
    return { did: "D1", wid: "W1", eid: "E1" };
  }

  async getFeatures(): Promise<FeatureListResponse> {
    this.calls++;
    return { features: this.added.map((a) => a.feature), rollbackIndex: this.added.length, serializationVersion: "1", sourceMicroversion: "m" };
  }

  async addFeature(_ref: DocumentRef, feature: BTFeature): Promise<AddFeatureResponse> {
    this.calls++;
    const id = `F${this.added.length + 1}`;
    const stored = { ...feature, featureId: id };
    this.added.push({ id, feature: stored });
    this.nameById.set(id, feature.name);
    if (this.solidTypes.has(feature.featureType)) this.lastSolid = feature.name;
    return { feature: stored, featureState: { featureStatus: "OK" }, serializationVersion: "1", sourceMicroversion: `m${id}` };
  }

  async evaluateFeatureScript(_ref: DocumentRef, script: string): Promise<unknown> {
    this.calls++;
    if (script.includes("qAllModifiableSolidBodies")) {
      const ev = this.lastSolid ? this.world.evidence[this.lastSolid] : undefined;
      const faceTypes = Object.fromEntries(Object.entries(ev?.faceTypes ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
      return decodeFsValue(encode({ bodyCount: ev?.bodyCount ?? 0, faceCount: ev?.faceCount ?? 0, edgeCount: ev?.edgeCount ?? 0, vertexCount: ev?.vertexCount ?? 0, faceTypes, centroid: ev?.centerOfMass }));
    }
    if (script.includes("evOwnerSketchPlane")) return this.sketchPlane(script);
    const m = /makeId\("([^"]+)"\)[\s\S]*?EntityType\.(FACE|EDGE|VERTEX)/.exec(script);
    if (!m) throw new Error(`fake cannot interpret script:\n${script}`);
    const key = this.nameById.get(m[1]!) ?? m[1]!;
    const entity = m[2]!.toLowerCase() as "face" | "edge" | "vertex";
    const records = this.world.topology[key]?.[entity] ?? [];
    return decodeFsValue(encode(records));
  }

  /** Like Onshape: the sketch plane is the face's plane with its origin at the projected world origin. */
  private sketchPlane(script: string): unknown {
    const id = /makeId\("([^"]+)"\)/.exec(script)?.[1];
    const added = this.added.find((a) => a.id === id);
    const planeParam = added?.feature.parameters.find((p) => p.parameterId === "sketchPlane") as { queries?: Array<{ deterministicIds?: string[] }> } | undefined;
    const faceId = planeParam?.queries?.[0]?.deterministicIds?.[0];
    if (!faceId) return undefined;
    for (const t of Object.values(this.world.topology)) {
      const rec = t.face?.find((r) => r.ids.includes(faceId));
      if (rec && Array.isArray(rec.origin) && Array.isArray(rec.normal) && Array.isArray(rec.x)) {
        const o = rec.origin as Vec3, n = rec.normal as Vec3;
        const d = o[0] * n[0] + o[1] * n[1] + o[2] * n[2];
        return decodeFsValue(encode({ origin: [n[0] * d, n[1] * d, n[2] * d], normal: n, x: rec.x }));
      }
    }
    return undefined;
  }

  async massProperties(): Promise<MassPropertiesBody | undefined> {
    this.calls++;
    const ev = this.lastSolid ? this.world.evidence[this.lastSolid] : undefined;
    if (this.overrides.massProperties) return this.overrides.massProperties(this.lastSolid, ev);
    if (!ev) return undefined;
    const c = ev.centerOfMass ?? [0, 0, 0];
    // Like the live API with no material assigned: hasMass false and a zero centroid.
    return { hasMass: false, volume: [ev.volume, ev.volume, ev.volume], periphery: [ev.area, ev.area, ev.area], centroid: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  }

  async deleteFeature(_ref: DocumentRef, featureId: string): Promise<void> {
    this.calls++;
    const i = this.added.findIndex((a) => a.id === featureId);
    if (i >= 0) {
      this.added.splice(i, 1);
      this.nameById.delete(featureId);
    }
    const prev = [...this.added].reverse().find((a) => this.solidTypes.has(a.feature.featureType));
    this.lastSolid = prev?.feature.name;
  }
}

/** Wrap plain values the way `POST .../featurescript` does. */
export function encode(v: unknown): unknown {
  if (v === undefined) return { btType: "com.belmonttech.serialize.fsvalue.BTFSValueUndefined" };
  if (typeof v === "number") return { btType: "BTFSValueNumber-772", value: v };
  if (typeof v === "string") return { btType: "BTFSValueString-1422", value: v };
  if (typeof v === "boolean") return { btType: "BTFSValueBoolean-1195", value: v };
  if (Array.isArray(v)) return { btType: "com.belmonttech.serialize.fsvalue.BTFSValueArray", value: v.map(encode) };
  if (typeof v === "object" && v !== null) {
    return { btType: "com.belmonttech.serialize.fsvalue.BTFSValueMap", value: Object.entries(v).map(([k, val]) => ({ key: encode(k), value: encode(val) })) };
  }
  throw new Error(`cannot encode ${typeof v}`);
}

// --- the plate world ----------------------------------------------------------

const plane = (ids: string, origin: Vec3, normal: Vec3, x: Vec3, area?: number): RawRecord => ({
  ids: [ids],
  type: "PLANE",
  origin,
  normal,
  x,
  centroid: origin,
  ...(area !== undefined ? { area } : {}),
});
const line = (id: string, a: Vec3, b: Vec3): RawRecord => {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  return { ids: [id], type: "LINE", origin: a, direction: d.map((x) => x / len), length: len, midpoint: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] };
};
const circle = (id: string, center: Vec3, r: number, axis: Vec3): RawRecord => ({
  ids: [id],
  type: "CIRCLE",
  center,
  axis,
  radius: r,
  length: 2 * Math.PI * r,
  midpoint: [center[0] - r, center[1], center[2]],
});

/** Onshape-side geometry of the §16 plate (W 50, H 30, T 10 mm, hole Ø5 at (25, 15)). */
export function plateWorld(ir: Document): World {
  const W = 0.05, H = 0.03, T = 0.01, R = 0.0025;
  const corners: Vec3[] = [[0, 0, 0], [W, 0, 0], [W, H, 0], [0, H, 0]];
  const topEdges = corners.map((c, i) => line(`E_top${i}`, [c[0], c[1], T], [corners[(i + 1) % 4]![0], corners[(i + 1) % 4]![1], T]));
  const botEdges = corners.map((c, i) => line(`E_bot${i}`, c, corners[(i + 1) % 4]!));
  const vertEdges = corners.map((c, i) => line(`E_vert${i}`, c, [c[0], c[1], T]));

  const evidence: Record<string, Evidence> = {};
  for (const f of ir.partStudio.features) if (f.evidence) evidence[f.src.name] = f.evidence;

  return {
    evidence,
    topology: {
      // Onshape default datums. Frames are the fake's belief about Onshape; verify with `cli planes`.
      Top: { face: [plane("JCC", [0, 0, 0], [0, 0, 1], [1, 0, 0])] },
      Front: { face: [plane("JDC", [0, 0, 0], [0, -1, 0], [1, 0, 0])] },
      Right: { face: [plane("JFC", [0, 0, 0], [1, 0, 0], [0, 1, 0])] },
      Origin: { vertex: [{ ids: ["JGC"], type: "VERTEX", point: [0, 0, 0] }] },
      "Boss-Extrude1": {
        face: [
          // Cap face frame deliberately uses x = +Y to exercise the in-plane rotation handling.
          plane("F_cap", [W / 2, H / 2, T], [0, 0, 1], [0, 1, 0], W * H),
          plane("F_bottom", [W / 2, H / 2, 0], [0, 0, -1], [1, 0, 0], W * H),
          plane("F_front", [W / 2, 0, T / 2], [0, -1, 0], [1, 0, 0], W * T),
          plane("F_right", [W, H / 2, T / 2], [1, 0, 0], [0, 1, 0], H * T),
          plane("F_back", [W / 2, H, T / 2], [0, 1, 0], [-1, 0, 0], W * T),
          plane("F_left", [0, H / 2, T / 2], [-1, 0, 0], [0, -1, 0], H * T),
        ],
        edge: [...topEdges, ...botEdges, ...vertEdges],
      },
      "Cut-Extrude1": {
        face: [{ ids: ["F_hole"], type: "CYLINDER", origin: [W / 2, H / 2, 0], axis: [0, 0, 1], radius: R, area: 2 * Math.PI * R * T }],
        edge: [circle("E_hole_bottom", [W / 2, H / 2, 0], R, [0, 0, 1]), circle("E_hole_top", [W / 2, H / 2, T], R, [0, 0, 1])],
      },
    },
  };
}
