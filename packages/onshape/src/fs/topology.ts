import type { EntityType, Vec3 } from "@slop/ir";
import type { OnshapeApi } from "../client/api.ts";
import type { DocumentRef } from "../client/types.ts";
import { isVec3, type PlaneFrame } from "../geometry.ts";
import { isRecord } from "./values.ts";
import { bodyStatsScript, topologyScript } from "./scripts.ts";

/** One Onshape entity with the geometry the resolver scores against. */
export interface Candidate {
  id: string;
  entity: EntityType;
  /** Lower-case surface/curve type: plane, cylinder, ..., line, circle, ..., vertex. */
  type: string;
  origin?: Vec3;
  normal?: Vec3;
  /** In-plane x axis (planes only). */
  x?: Vec3;
  axis?: Vec3;
  radius?: number;
  minorRadius?: number;
  centroid?: Vec3;
  area?: number;
  center?: Vec3;
  midpoint?: Vec3;
  length?: number;
  direction?: Vec3;
  point?: Vec3;
}

export interface BodyStats {
  bodyCount: number;
  faceCount: number;
  edgeCount: number;
  vertexCount: number;
  faceTypes: Record<string, number>;
}

/** Entities created by `featureId`, with signatures. */
export async function queryTopology(api: OnshapeApi, ref: DocumentRef, featureId: string, entity: EntityType): Promise<Candidate[]> {
  const raw = await api.evaluateFeatureScript(ref, topologyScript(featureId, entity));
  if (!Array.isArray(raw)) throw new Error(`topology query for ${featureId}/${entity} returned ${typeof raw}`);
  return raw.map((r) => parseCandidate(r, entity));
}

export async function queryBodyStats(api: OnshapeApi, ref: DocumentRef): Promise<BodyStats> {
  const raw = await api.evaluateFeatureScript(ref, bodyStatsScript);
  if (!isRecord(raw)) throw new Error("body stats query returned no map");
  const n = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : 0);
  const faceTypes: Record<string, number> = {};
  if (isRecord(raw.faceTypes)) {
    for (const [k, v] of Object.entries(raw.faceTypes)) if (typeof v === "number") faceTypes[k.toLowerCase()] = v;
  }
  return { bodyCount: n("bodyCount"), faceCount: n("faceCount"), edgeCount: n("edgeCount"), vertexCount: n("vertexCount"), faceTypes };
}

/** Frame of a planar face candidate (sketch plane coordinate system). */
export function frameOf(c: Candidate): PlaneFrame {
  if (c.type !== "plane" || !c.origin || !c.normal || !c.x) throw new Error(`entity ${c.id} is not a planar face with a frame`);
  return { origin: c.origin, normal: c.normal, x: c.x };
}

function parseCandidate(r: unknown, entity: EntityType): Candidate {
  if (!isRecord(r)) throw new Error("topology record is not a map");
  const ids = r.ids;
  const id = Array.isArray(ids) ? ids[0] : ids;
  if (typeof id !== "string") throw new Error(`topology record has no deterministic id: ${JSON.stringify(r).slice(0, 200)}`);

  const out: Record<string, unknown> = { id, entity, type: String(r.type ?? "").toLowerCase() };
  for (const k of ["origin", "normal", "x", "axis", "centroid", "center", "midpoint", "direction", "point"]) {
    if (isVec3(r[k])) out[k] = r[k];
  }
  for (const k of ["radius", "minorRadius", "area", "length"]) {
    if (typeof r[k] === "number") out[k] = r[k];
  }
  return out as unknown as Candidate;
}
