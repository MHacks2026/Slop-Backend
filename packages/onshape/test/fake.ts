import type { Document, Evidence, Vec3 } from "@slop/ir";
import type { OnshapeApi } from "../src/client/api.ts";
import type { AddFeatureResponse, BTFeature, BTParameterQuantity, DocumentRef, FeatureListResponse, FeatureState, MassPropertiesBody } from "../src/client/types.ts";
import { decodeFsValue } from "../src/fs/values.ts";
import { safeId } from "../src/sketch/compose.ts";

/** Raw topology record as the FeatureScript lambda would return it (before BTFSValue wrapping). */
export interface RawRecord {
  ids: string[];
  type: string;
  [k: string]: unknown;
}

/** What the fake reports while one sketch dimension is changed from its built value. */
export interface BehaviorState {
  /** Final-model evidence with the change applied. */
  evidence?: Evidence;
  /** Feature names that go into ERROR under this change (a reference that did not survive). */
  broken?: string[];
}

export interface World {
  /** Keyed by feature *name* (Onshape ids are assigned at add time) or datum name. */
  topology: Record<string, Partial<Record<"face" | "edge" | "vertex", RawRecord[]>>>;
  /** Evidence to report after each solid feature, by feature name. */
  evidence: Record<string, Evidence>;
  /** Keyed by "<constraint entityId>=<expression>", e.g. "f1.D1_Sketch1=55 mm". */
  behavior?: Record<string, BehaviorState>;
}

/**
 * In-memory Onshape. Assigns feature ids, answers topology lambdas from a
 * scripted world, and reports mass properties from the IR's own evidence, so
 * the builder loop runs end to end without credentials. Results are
 * BTFSValue-encoded to exercise the decoder.
 *
 * Behaviour tests: `updateFeature` on a sketch changes a dimension expression;
 * while exactly one dimension differs from its built value, evidence and
 * feature states come from `world.behavior` for that change.
 */
export class FakeOnshape implements OnshapeApi {
  calls = 0;
  updates = 0;
  readonly added: Array<{ id: string; feature: BTFeature }> = [];
  private readonly nameById = new Map<string, string>();
  private readonly builtExpressions = new Map<string, string>();
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
    const broken = new Set(this.activeBehavior()?.broken ?? []);
    const featureStates: Record<string, FeatureState> = {};
    for (const a of this.added) featureStates[a.id] = { featureStatus: broken.has(a.feature.name) ? "ERROR" : "OK" };
    return { features: this.added.map((a) => a.feature), rollbackIndex: this.added.length, serializationVersion: "1", sourceMicroversion: "m", featureStates };
  }

  async addFeature(_ref: DocumentRef, feature: BTFeature): Promise<AddFeatureResponse> {
    this.calls++;
    const id = `F${this.added.length + 1}`;
    const stored = { ...feature, featureId: id };
    this.added.push({ id, feature: stored });
    this.nameById.set(id, feature.name);
    if (this.solidTypes.has(feature.featureType)) this.lastSolid = feature.name;
    if (stored.btType === "BTMSketch-151") {
      for (const c of stored.constraints) {
        const q = c.parameters.find((p): p is BTParameterQuantity => p.btType === "BTMParameterQuantity-147");
        if (q) this.builtExpressions.set(c.entityId, q.expression);
      }
    }
    return { feature: stored, featureState: { featureStatus: "OK" }, serializationVersion: "1", sourceMicroversion: `m${id}` };
  }

  async updateFeature(_ref: DocumentRef, featureId: string, feature: BTFeature): Promise<AddFeatureResponse> {
    this.calls++;
    this.updates++;
    const i = this.added.findIndex((a) => a.id === featureId);
    if (i < 0) throw new Error(`fake: no feature ${featureId} to update`);
    const stored = { ...feature, featureId };
    this.added[i] = { id: featureId, feature: stored };
    const broken = new Set(this.activeBehavior()?.broken ?? []);
    return { feature: stored, featureState: { featureStatus: broken.has(feature.name) ? "ERROR" : "OK" }, serializationVersion: "1", sourceMicroversion: `m${featureId}u${this.updates}` };
  }

  async evaluateFeatureScript(_ref: DocumentRef, script: string): Promise<unknown> {
    this.calls++;
    if (script.includes("qAllModifiableSolidBodies")) {
      const ev = this.currentEvidence();
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
    const ev = this.currentEvidence();
    if (this.overrides.massProperties) return this.overrides.massProperties(this.lastSolid, ev);
    if (!ev) return undefined;
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

  /** "<entityId>=<expression>" when exactly one built dimension differs from its built value. */
  activeChange(): string | undefined {
    const changed: string[] = [];
    for (const a of this.added) {
      if (a.feature.btType !== "BTMSketch-151") continue;
      for (const c of a.feature.constraints) {
        const q = c.parameters.find((p): p is BTParameterQuantity => p.btType === "BTMParameterQuantity-147");
        const built = this.builtExpressions.get(c.entityId);
        if (q && built !== undefined && q.expression !== built) changed.push(`${c.entityId}=${q.expression}`);
      }
    }
    return changed.length === 1 ? changed[0] : undefined;
  }

  private activeBehavior(): BehaviorState | undefined {
    const key = this.activeChange();
    return key ? this.world.behavior?.[key] : undefined;
  }

  private currentEvidence(): Evidence | undefined {
    return this.activeBehavior()?.evidence ?? (this.lastSolid ? this.world.evidence[this.lastSolid] : undefined);
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

  // Source-side perturbation evidence, keyed the way the fake sees the change:
  // the dimension's constraint entityId is "<sketch feature id>.<safeId(dimension id)>".
  const behavior: Record<string, BehaviorState> = {};
  for (const b of ir.behaviorEvidence ?? []) {
    const sketch = ir.partStudio.features.find((f) => f.op === "sketch" && f.dimensions.some((d) => d.id === b.target));
    if (sketch) behavior[`${sketch.id}.${safeId(b.target)}=${b.expression}`] = { evidence: b.evidence };
  }

  return {
    evidence,
    behavior,
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

// --- analytic plate ----------------------------------------------------------

export interface PlateParams {
  W?: number;
  H?: number;
  T?: number;
  /** Hole radius. */
  R?: number;
  /** Fillet radius on the hole's top rim. */
  r?: number;
  /** Hole centre. */
  xh?: number;
  yh?: number;
}

/**
 * Closed-form final-model evidence for the plate: a W x H x T block, a
 * through hole of radius R at (xh, yh), and a fillet of radius r on the
 * hole's top rim (volume by Pappus on the corner cross-section). This is what
 * the fixture's evidence and behaviour evidence were generated from.
 */
export function analyticPlate({ W = 0.05, H = 0.03, T = 0.01, R = 0.0025, r = 0.002, xh = 0.025, yh = 0.015 }: PlateParams = {}): Evidence {
  const Vp = W * H * T;
  const Vc = Math.PI * R * R * T;
  const Ac = r * r * (1 - Math.PI / 4);
  const cc = (r * (5 / 6 - Math.PI / 4)) / (1 - Math.PI / 4);
  const Vf = 2 * Math.PI * (R + cc) * Ac;
  const V = Vp - Vc - Vf;
  const Ap = 2 * (W * H + W * T + H * T) - 2 * Math.PI * R * R + 2 * Math.PI * R * T;
  const lostTop = Math.PI * ((R + r) ** 2 - R * R);
  const lostWall = 2 * Math.PI * R * r;
  const filletSurface = ((Math.PI * r) / 2) * 2 * Math.PI * (R + r - (2 * r) / Math.PI);
  const A = Ap - lostTop - lostWall + filletSurface;
  const com: Vec3 = [
    ((W / 2) * Vp - xh * (Vc + Vf)) / V,
    ((H / 2) * Vp - yh * (Vc + Vf)) / V,
    ((T / 2) * Vp - (T / 2) * Vc - (T - cc) * Vf) / V,
  ];
  return { bodyCount: 1, volume: V, area: A, centerOfMass: com, bbox: { min: [0, 0, 0], max: [W, H, T] }, faceCount: 8, faceTypes: { plane: 6, cylinder: 1, torus: 1 } };
}
