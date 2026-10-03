import type { EdgeSignature, FaceSignature, TopoRef, Vec3, VertexSignature } from "@slop/ir";
import type { Candidate } from "./fs/topology.ts";
import { dist, dot, normalize, norm, sub } from "./geometry.ts";

export type ResolverName = "semantic" | "signature" | "probe";

export interface Resolution {
  id: string;
  resolver: ResolverName;
  /** Score of the winner in [0, 1]. 1 = exact. */
  confidence: number;
  /** Score of the best losing candidate, if any. */
  runnerUp?: number;
  candidates: number;
  candidate: Candidate;
}

export class ResolveError extends Error {
  constructor(
    message: string,
    public readonly scores: Array<{ id: string; score: number }> = [],
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

export interface ResolveOptions {
  /** Length tolerance (m). A deviation of exactly `tol` scores 0.5. */
  tol?: number;
  /** Angular tolerance (rad). */
  angTol?: number;
  /** Winner must score at least this. */
  accept?: number;
  /** Runner-up must score at most this. */
  reject?: number;
}

const DEFAULTS: Required<ResolveOptions> = { tol: 1e-6, angTol: 1e-6, accept: 0.5, reject: 0.1 };

export interface RankedCandidate {
  candidate: Candidate;
  score: number;
  resolver: ResolverName;
}

export type Decision =
  | { kind: "unique"; resolution: Resolution; ranked: RankedCandidate[] }
  /** Several candidates score alike. The translator picks (architecture doc §8). */
  | { kind: "tie"; ranked: RankedCandidate[] }
  | { kind: "none"; ranked: RankedCandidate[]; reason: string };

/**
 * Score every candidate against `ref` and say whether one wins outright.
 * Candidates are already scoped to `ref.createdBy` by the caller (the
 * semantic step of the cascade); this runs the signature and probe steps.
 *
 * "unique" requires exactly one candidate above `accept` with the runner-up
 * below `reject`. Anything else is a tie or a miss and is returned as data,
 * never guessed: in the LLM path the translator chooses from the ranking,
 * in the rules path `resolveTopo` throws.
 */
export function rankCandidates(ref: TopoRef, candidates: Candidate[], options: ResolveOptions = {}): Decision {
  const o = { ...DEFAULTS, ...options };
  const pool = candidates.filter((c) => c.entity === ref.entity);
  if (pool.length === 0) return { kind: "none", ranked: [], reason: `no ${ref.entity} candidates for ${describe(ref)}` };

  let ranked: RankedCandidate[];
  if (ref.signature) {
    ranked = pool.map((c) => ({ candidate: c, score: scoreSignature(ref, c, o), resolver: "signature" as const }));
  } else if (ref.probe) {
    const probe = ref.probe;
    ranked = pool.map((c) => ({ candidate: c, score: lengthScore(probeDistance(probe, c), o.tol * 100), resolver: "probe" as const }));
  } else {
    ranked = pool.map((c) => ({ candidate: c, score: pool.length === 1 ? 1 : 0.5, resolver: "semantic" as const }));
  }
  ranked.sort((a, b) => b.score - a.score);

  // Signature inconclusive but a probe exists: let the probe break the tie.
  const best = ranked[0]!;
  const second = ranked[1];
  if (ref.signature && ref.probe && (best.score < o.accept || (second && second.score > o.reject))) {
    const probe = ref.probe;
    const byProbe = pool
      .map((c) => ({ candidate: c, score: lengthScore(probeDistance(probe, c), o.tol * 100), resolver: "probe" as const }))
      .sort((a, b) => b.score - a.score);
    return decide(byProbe, o, ref);
  }
  return decide(ranked, o, ref);
}

function decide(ranked: RankedCandidate[], o: Required<ResolveOptions>, ref: TopoRef): Decision {
  const best = ranked[0]!;
  const second = ranked[1];
  if (best.score < o.accept) return { kind: "none", ranked, reason: `no candidate matches ${describe(ref)} (best score ${best.score.toFixed(3)})` };
  if (second && second.score > o.reject) return { kind: "tie", ranked };
  return {
    kind: "unique",
    ranked,
    resolution: {
      id: best.candidate.id,
      resolver: best.resolver,
      confidence: best.score,
      ...(second ? { runnerUp: second.score } : {}),
      candidates: ranked.length,
      candidate: best.candidate,
    },
  };
}

/** Rules-path convenience: the unique winner, or a ResolveError for ties and misses. */
export function resolveTopo(ref: TopoRef, candidates: Candidate[], options: ResolveOptions = {}): Resolution {
  const d = rankCandidates(ref, candidates, options);
  if (d.kind === "unique") return d.resolution;
  const scores = d.ranked.map((r) => ({ id: r.candidate.id, score: r.score }));
  if (d.kind === "tie") throw new ResolveError(`ambiguous: ${d.ranked.filter((r) => r.score > (options.reject ?? DEFAULTS.reject)).length} candidates tie for ${describe(ref)}`, scores);
  throw new ResolveError(d.reason, scores);
}

// --- scoring -----------------------------------------------------------------

/** 1 at zero deviation, 0.5 at `tol`, -> 0 beyond. */
const lengthScore = (d: number, tol: number): number => 1 / (1 + (d / tol) ** 2);
const angleScore = (a: Vec3, b: Vec3, tol: number, allowFlip: boolean): number => {
  const c = dot(normalize(a), normalize(b));
  const ang = Math.acos(Math.min(1, Math.max(-1, allowFlip ? Math.abs(c) : c)));
  return lengthScore(ang, tol);
};

function scoreSignature(ref: TopoRef, c: Candidate, o: Required<ResolveOptions>): number {
  const sig = ref.signature!;
  const parts: number[] = [];
  const typeOf = "surface" in sig ? sig.surface : "curve" in sig ? sig.curve : "vertex";
  if (ref.entity !== "vertex" && c.type !== typeOf) return 0;

  if (ref.entity === "face") {
    const s = sig as FaceSignature;
    if (s.normal && c.normal) parts.push(angleScore(s.normal, c.normal, o.angTol, false));
    if (s.normal && s.offset !== undefined && c.origin) parts.push(lengthScore(Math.abs(dot(c.origin, normalize(s.normal)) - s.offset), o.tol));
    if (s.axis && c.axis) parts.push(angleScore(s.axis, c.axis, o.angTol, true));
    if (s.radius !== undefined && c.radius !== undefined) parts.push(lengthScore(Math.abs(s.radius - c.radius), o.tol));
    if (s.axisPoint && c.axis && c.origin) parts.push(lengthScore(axisDistance(s.axisPoint, c.origin, c.axis), o.tol));
    if (s.centroid && c.centroid) parts.push(lengthScore(dist(s.centroid, c.centroid), o.tol * 10));
    if (s.area !== undefined && c.area !== undefined) parts.push(lengthScore(Math.abs(s.area - c.area) / Math.max(s.area, 1e-12), 1e-6));
  } else if (ref.entity === "edge") {
    const s = sig as EdgeSignature;
    if (s.radius !== undefined && c.radius !== undefined) parts.push(lengthScore(Math.abs(s.radius - c.radius), o.tol));
    if (s.center && c.center) parts.push(lengthScore(dist(s.center, c.center), o.tol));
    if (s.midpoint && c.midpoint) parts.push(lengthScore(dist(s.midpoint, c.midpoint), o.tol * 10));
    if (s.length !== undefined && c.length !== undefined) parts.push(lengthScore(Math.abs(s.length - c.length), o.tol));
    if (s.direction && c.direction) parts.push(angleScore(s.direction, c.direction, o.angTol, true));
  } else {
    const s = sig as VertexSignature;
    if (c.point) parts.push(lengthScore(dist(s.point, c.point), o.tol));
  }

  if (parts.length === 0) return 0;
  return Math.min(...parts);
}

function axisDistance(p: Vec3, origin: Vec3, axis: Vec3): number {
  const d = sub(p, origin);
  const a = normalize(axis);
  const along = dot(d, a);
  return norm(sub(d, [a[0] * along, a[1] * along, a[2] * along]));
}

function probeDistance(probe: Vec3, c: Candidate): number {
  switch (c.type) {
    case "plane":
      return c.origin && c.normal ? Math.abs(dot(sub(probe, c.origin), normalize(c.normal))) : Infinity;
    case "cylinder":
      return c.origin && c.axis && c.radius !== undefined ? Math.abs(axisDistance(probe, c.origin, c.axis) - c.radius) : Infinity;
    case "circle":
      if (!c.center || !c.axis || c.radius === undefined) return Infinity;
      return Math.hypot(axisDistance(probe, c.center, c.axis) - c.radius, dot(sub(probe, c.center), normalize(c.axis)));
    case "line":
      return c.origin && c.direction ? axisDistance(probe, c.origin, c.direction) : Infinity;
    case "vertex":
      return c.point ? dist(probe, c.point) : Infinity;
    default: {
      const p = c.midpoint ?? c.centroid ?? c.point;
      return p ? dist(probe, p) : Infinity;
    }
  }
}

function describe(ref: TopoRef): string {
  return `${ref.entity}${ref.createdBy ? ` created by ${ref.createdBy}` : ""}${ref.role ? ` (${ref.role})` : ""}`;
}
