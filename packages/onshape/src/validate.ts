import type { Evidence } from "@slop/ir";
import type { MassPropertiesBody } from "./client/types.ts";
import type { BodyStats } from "./fs/topology.ts";

export interface Check {
  name: string;
  expected: number | string;
  actual: number | string;
  /** Relative error for numeric checks. */
  error?: number;
  tolerance?: number;
  pass: boolean;
  /** Mismatches that are flagged but do not fail the feature (split faces). */
  advisory?: boolean;
}

export interface Tolerances {
  /** Relative tolerance on volume and area. */
  volume: number;
  area: number;
  /** Absolute tolerance (m) on centre of mass and bounding box. */
  position: number;
}

export const DEFAULT_TOLERANCES: Tolerances = { volume: 1e-6, area: 1e-6, position: 1e-6 };

/**
 * Level 1 geometry checks (architecture doc §9): compare the SolidWorks
 * evidence recorded for a feature with what Onshape produced after building
 * it. Volume and area fail the feature; topology counts are advisory, since
 * the two kernels may split faces differently.
 */
export function level1Checks(evidence: Evidence, mass: MassPropertiesBody | undefined, stats: BodyStats | undefined, tol: Tolerances = DEFAULT_TOLERANCES): Check[] {
  const checks: Check[] = [];

  if (mass) {
    checks.push(relative("volume", evidence.volume, mass.volume[0] ?? NaN, tol.volume));
    checks.push(relative("area", evidence.area, mass.periphery[0] ?? NaN, tol.area));
    if (evidence.centerOfMass && mass.centroid.length >= 3) {
      const [ex, ey, ez] = evidence.centerOfMass;
      const [ax, ay, az] = mass.centroid as [number, number, number];
      const d = Math.hypot(ax - ex, ay - ey, az - ez);
      checks.push({ name: "centerOfMass", expected: fmtVec(evidence.centerOfMass), actual: fmtVec([ax, ay, az]), error: d, tolerance: tol.position, pass: d <= tol.position });
    }
  } else {
    checks.push({ name: "volume", expected: evidence.volume, actual: "no solid body", pass: false });
  }

  if (stats) {
    checks.push(exact("bodyCount", evidence.bodyCount, stats.bodyCount, false));
    if (evidence.faceCount !== undefined) checks.push(exact("faceCount", evidence.faceCount, stats.faceCount, true));
    if (evidence.edgeCount !== undefined) checks.push(exact("edgeCount", evidence.edgeCount, stats.edgeCount, true));
    if (evidence.vertexCount !== undefined) checks.push(exact("vertexCount", evidence.vertexCount, stats.vertexCount, true));
    if (evidence.faceTypes) {
      for (const [type, n] of Object.entries(evidence.faceTypes)) {
        if (n !== undefined) checks.push(exact(`faceTypes.${type}`, n, stats.faceTypes[type] ?? 0, true));
      }
    }
  }

  return checks;
}

function relative(name: string, expected: number, actual: number, tolerance: number): Check {
  const error = expected === 0 ? Math.abs(actual) : Math.abs(actual - expected) / Math.abs(expected);
  return { name, expected, actual, error, tolerance, pass: Number.isFinite(error) && error <= tolerance };
}

function exact(name: string, expected: number, actual: number, advisory: boolean): Check {
  return { name, expected, actual, pass: expected === actual, ...(advisory ? { advisory } : {}) };
}

const fmtVec = (v: readonly number[]): string => `(${v.map((x) => x.toPrecision(6)).join(", ")})`;

export const hardFailures = (checks: Check[]): Check[] => checks.filter((c) => !c.pass && !c.advisory);
