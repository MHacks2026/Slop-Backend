import type { Mat4, Vec2, Vec3 } from "@slop/ir";

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n === 0) throw new RangeError("cannot normalize zero vector");
  return scale(a, 1 / n);
}

/** Apply a row-major 4x4 to a point (w = 1). */
export function applyPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
    m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
    m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
  ];
}

/** Apply a row-major 4x4 to a direction (w = 0). */
export function applyDir(m: Mat4, d: Vec3): Vec3 {
  const [x, y, z] = d;
  return [
    m[0]! * x + m[1]! * y + m[2]! * z,
    m[4]! * x + m[5]! * y + m[6]! * z,
    m[8]! * x + m[9]! * y + m[10]! * z,
  ];
}

/** A plane with an in-plane x axis: Onshape's `Plane` type. */
export interface PlaneFrame {
  origin: Vec3;
  normal: Vec3;
  x: Vec3;
}

export const planeY = (f: PlaneFrame): Vec3 => cross(f.normal, f.x);

/**
 * The coordinate system Onshape gives a sketch on this plane. Verified live:
 * `evSurfaceDefinition`/`evPlane` report a face's centroid as `origin`, but
 * `evOwnerSketchPlane` of the resulting sketch has its origin at the world
 * origin projected onto the plane (x axis unchanged). Sketch coordinates must
 * be expressed in the latter or the geometry lands offset by the centroid.
 */
export function sketchFrameOf(f: PlaneFrame): PlaneFrame {
  const n = normalize(f.normal);
  // World origin projected onto the plane: n * (p . n) for any point p on it.
  const origin = scale(n, dot(f.origin, n));
  return { origin, normal: n, x: normalize(f.x) };
}

export const sameFrame = (a: PlaneFrame, b: PlaneFrame, tol = 1e-6): boolean =>
  dist(a.origin, b.origin) <= tol && dist(normalize(a.normal), normalize(b.normal)) <= tol && dist(normalize(a.x), normalize(b.x)) <= tol;

export function toPlaneCoords(f: PlaneFrame, p: Vec3): Vec2 {
  const d = sub(p, f.origin);
  return [dot(d, f.x), dot(d, planeY(f))];
}

export function planeDistance(f: PlaneFrame, p: Vec3): number {
  return dot(sub(p, f.origin), f.normal);
}

export const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number");
