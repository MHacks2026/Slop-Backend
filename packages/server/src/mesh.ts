/**
 * Onshape tessellation -> a compact mesh for the browser viewer.
 *
 * Onshape's `tessellatedfaces` response (with `outputIndexTable`) is about
 * 1 MB of JSON for a small part, mostly type tags. The viewer only needs, per
 * face, triangle positions and vertex normals; those go out as base64
 * little-endian Float32 arrays, non-indexed (three vertices per triangle).
 * Faces keep their Onshape ids so the viewer can light up the faces a
 * feature just created.
 */

export type Vec3 = [number, number, number];

export interface MeshFace {
  id: string;
  /** base64 Float32Array, 9 floats per triangle (metres). */
  positions: string;
  /** base64 Float32Array, 9 floats per triangle. */
  normals: string;
  triangles: number;
}

export interface MeshBody {
  id: string;
  name: string;
  faces: MeshFace[];
}

export interface Mesh {
  bodies: MeshBody[];
  triangles: number;
  bbox?: { min: Vec3; max: Vec3 };
}

type Point = { x: number; y: number; z: number } | [number, number, number];

interface RawFacet {
  indices?: number[];
  vertices?: Point[];
  normals?: Point[];
  normal?: Point | null;
}

interface RawFace {
  id?: string;
  facets?: RawFacet[];
}

interface RawBody {
  id?: string;
  name?: string;
  bodyType?: string;
  faces?: RawFace[];
  facetPoints?: Point[];
}

const xyz = (p: Point | null | undefined): Vec3 | undefined => {
  if (!p) return undefined;
  if (Array.isArray(p)) return p.length >= 3 ? [p[0], p[1], p[2]] : undefined;
  return typeof p.x === "number" ? [p.x, p.y, p.z] : undefined;
};

const b64 = (values: number[]): string => Buffer.from(new Float32Array(values).buffer).toString("base64");

/** Accepts both the index-table form and the older per-facet `vertices` form. */
export function toMesh(raw: unknown): Mesh {
  const res = (Array.isArray(raw) ? { bodies: raw } : raw ?? {}) as { bodies?: RawBody[]; facetPoints?: Point[] };
  const shared = res.facetPoints ?? [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let total = 0;

  const bodies: MeshBody[] = [];
  for (const [bi, body] of (res.bodies ?? []).entries()) {
    if (body.bodyType && body.bodyType !== "SOLID") continue;
    const points = body.facetPoints?.length ? body.facetPoints : shared;
    const faces: MeshFace[] = [];
    for (const [fi, face] of (body.faces ?? []).entries()) {
      const pos: number[] = [];
      const nor: number[] = [];
      for (const facet of face.facets ?? []) {
        const corners = facet.indices?.length === 3 ? facet.indices.map((i) => xyz(points[i])) : (facet.vertices ?? []).map(xyz);
        if (corners.length !== 3 || corners.some((c) => !c)) continue;
        const [a, b, c] = corners as [Vec3, Vec3, Vec3];
        const flat = facetNormal(a, b, c);
        const normals = facet.normals?.length === 3 ? facet.normals.map((n) => xyz(n) ?? flat) : [0, 1, 2].map(() => xyz(facet.normal) ?? flat);
        for (let k = 0; k < 3; k++) {
          const p = corners[k]!;
          pos.push(p[0], p[1], p[2]);
          const n = normals[k]!;
          nor.push(n[0], n[1], n[2]);
          for (let d = 0; d < 3; d++) {
            if (p[d]! < min[d]!) min[d] = p[d]!;
            if (p[d]! > max[d]!) max[d] = p[d]!;
          }
        }
      }
      if (!pos.length) continue;
      const triangles = pos.length / 9;
      total += triangles;
      faces.push({ id: face.id ?? `face${bi}.${fi}`, positions: b64(pos), normals: b64(nor), triangles });
    }
    if (faces.length) bodies.push({ id: body.id ?? `body${bi}`, name: body.name ?? `Part ${bi + 1}`, faces });
  }
  return { bodies, triangles: total, ...(total ? { bbox: { min, max } } : {}) };
}

function facetNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

export const faceIds = (mesh: Mesh): string[] => mesh.bodies.flatMap((b) => b.faces.map((f) => f.id));
