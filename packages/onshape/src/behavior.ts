/**
 * Level 3 validation (architecture doc §9): behaviour under change.
 *
 * Geometry checks prove the migrated model is the right dead solid. This
 * proves the history reacts to edits the way the source did: change one
 * driving dimension in Onshape through the feature update endpoint,
 * regenerate, and compare the result with what the source produced for the
 * same change. A hole placed at fixed coordinates instead of dimensioned to
 * an edge passes every Level 1 check and fails here.
 *
 * Each test restores the original expression afterwards and re-measures, so
 * the document is left as built and the restore itself is verified.
 */
import type { Evidence } from "@slop/ir";
import type { OnshapeApi } from "./client/api.ts";
import type { BTMSketch, BTParameterQuantity, BTSketchConstraint, DocumentRef, FeatureListResponse, MassPropertiesBody } from "./client/types.ts";
import { queryBodyStats, type BodyStats } from "./fs/topology.ts";
import type { BehaviorTest } from "./plan/types.ts";
import { safeId } from "./sketch/compose.ts";
import { DEFAULT_TOLERANCES, hardFailures, level1Checks, type Check, type Tolerances } from "./validate.ts";

/** A behaviour test, with the source-side evidence for it when the extractor recorded one. */
export interface BehaviorCase extends BehaviorTest {
  evidence?: Evidence;
}

export type BehaviorStatus =
  /** Regenerated and every Level 1 check against the source evidence passed. */
  | "passed"
  /** Regenerated, but a check against the source evidence failed: intent was lost. */
  | "failed"
  /** A feature went into error after the change: a reference did not survive. */
  | "regenerationFailed"
  /** Regenerated, but no source evidence exists for this perturbation, so nothing was compared. */
  | "unverified"
  /** The target could not be edited in Onshape (not a sketch dimension the build wrote). */
  | "unsupported";

export interface BehaviorResult {
  target: string;
  /** Normalised expression actually written, e.g. "55 mm". */
  expression: string;
  expectation: string;
  /** True when source evidence existed and was compared. */
  verified: boolean;
  status: BehaviorStatus;
  /** Onshape sketch feature that holds the dimension. */
  onshapeFeatureId?: string;
  originalExpression?: string;
  /** Names of features in ERROR after the change. */
  featureErrors: string[];
  /** Level 1 checks against the source evidence for this perturbation. */
  checks: Check[];
  /** True when the original expression was written back and the nominal model re-verified. */
  restored: boolean;
  /** Level 1 checks against the nominal evidence after restoring. */
  restoreChecks: Check[];
  error?: string;
}

export interface BehaviorOptions {
  tolerances?: Tolerances;
  bodyStats?: boolean;
  log?: (line: string) => void;
  /** Called as each test finishes, for streaming progress. */
  onResult?: (result: BehaviorResult, index: number) => void;
  /**
   * "absolute" (default): the perturbed Onshape model must match the source
   * evidence for the same change. "delta": the *change* from nominal must
   * match the source's change, which tolerates a constant offset left by an
   * approximated feature (rung 4) while still catching a hole that does not
   * follow its edge.
   */
  mode?: "absolute" | "delta";
}

export async function runBehaviorTests(
  api: OnshapeApi,
  ref: DocumentRef,
  cases: BehaviorCase[],
  nominal: Evidence | undefined,
  options: BehaviorOptions = {},
): Promise<BehaviorResult[]> {
  const results: BehaviorResult[] = [];
  // Delta mode needs the Onshape model's own nominal measurement as the baseline.
  let baseline: Evidence | undefined;
  if (options.mode === "delta" && nominal && cases.length) {
    const mass = await api.massProperties(ref);
    const stats = options.bodyStats === false ? undefined : await queryBodyStats(api, ref);
    baseline = measuredEvidence(nominal, mass, stats);
  }
  for (const [i, c] of cases.entries()) {
    const r = await runOne(api, ref, c, nominal, options, baseline);
    results.push(r);
    options.onResult?.(r, i);
  }
  return results;
}

/** What Onshape reports now, in Evidence form, so it can serve as a baseline. */
export function measuredEvidence(like: Evidence, mass: MassPropertiesBody | undefined, stats: BodyStats | undefined): Evidence | undefined {
  if (!mass) return undefined;
  const centroid = mass.hasMass && mass.centroid.length >= 3 ? (mass.centroid.slice(0, 3) as [number, number, number]) : stats?.centroid;
  return {
    bodyCount: stats?.bodyCount ?? like.bodyCount,
    volume: mass.volume[0] ?? like.volume,
    area: mass.periphery[0] ?? like.area,
    ...(centroid ? { centerOfMass: centroid } : {}),
    ...(stats ? { faceCount: stats.faceCount, edgeCount: stats.edgeCount, vertexCount: stats.vertexCount, faceTypes: stats.faceTypes } : {}),
  };
}

/** Expected Onshape evidence for a change: the Onshape baseline shifted by the source's own change. */
export function shifted(sourceNominal: Evidence, sourceChanged: Evidence, onshapeBaseline: Evidence): Evidence {
  const com =
    sourceNominal.centerOfMass && sourceChanged.centerOfMass && onshapeBaseline.centerOfMass
      ? (onshapeBaseline.centerOfMass.map((v, i) => v + sourceChanged.centerOfMass![i]! - sourceNominal.centerOfMass![i]!) as [number, number, number])
      : undefined;
  return {
    ...sourceChanged,
    volume: onshapeBaseline.volume + sourceChanged.volume - sourceNominal.volume,
    area: onshapeBaseline.area + sourceChanged.area - sourceNominal.area,
    ...(com ? { centerOfMass: com } : {}),
  };
}

async function runOne(
  api: OnshapeApi,
  ref: DocumentRef,
  c: BehaviorCase,
  nominal: Evidence | undefined,
  options: BehaviorOptions,
  baseline: Evidence | undefined,
): Promise<BehaviorResult> {
  const log = options.log ?? (() => {});
  const tol = options.tolerances ?? DEFAULT_TOLERANCES;
  const expression = normalizeExpression(c.expression);
  const result: BehaviorResult = {
    target: c.target,
    expression,
    expectation: c.expectation,
    verified: c.evidence !== undefined,
    status: "unsupported",
    featureErrors: [],
    checks: [],
    restored: false,
    restoreChecks: [],
  };

  const list = await api.getFeatures(ref);
  const found = locateDimension(list, c.target);
  if ("error" in found) {
    result.error = found.error;
    log(`behaviour ${c.target}: unsupported (${found.error})`);
    return result;
  }
  const { sketch, constraint, quantity } = found;
  const original = quantity.expression;
  result.onshapeFeatureId = sketch.featureId!;
  result.originalExpression = original;
  log(`behaviour ${c.target}: ${original} -> ${expression}`);

  const measure = async (evidence: Evidence): Promise<Check[]> => {
    const mass = await api.massProperties(ref);
    const stats = options.bodyStats === false ? undefined : await queryBodyStats(api, ref);
    return level1Checks(evidence, mass, stats, tol);
  };

  try {
    await api.updateFeature(ref, sketch.featureId!, withExpression(sketch, constraint.entityId, expression));
    result.featureErrors = featureErrors(await api.getFeatures(ref));
    if (result.featureErrors.length) {
      result.status = "regenerationFailed";
    } else if (c.evidence) {
      const expected = options.mode === "delta" && nominal && baseline ? shifted(nominal, c.evidence, baseline) : c.evidence;
      result.checks = await measure(expected);
      result.status = hardFailures(result.checks).length ? "failed" : "passed";
    } else {
      result.status = "unverified";
    }
  } catch (err) {
    result.status = "failed";
    result.error = messageOf(err);
  }

  // Always put the model back, and prove it (against Onshape's own nominal in delta mode).
  try {
    await api.updateFeature(ref, sketch.featureId!, withExpression(sketch, constraint.entityId, original));
    const errors = featureErrors(await api.getFeatures(ref));
    const restoreTarget = options.mode === "delta" ? baseline ?? nominal : nominal;
    if (errors.length === 0 && restoreTarget) result.restoreChecks = await measure(restoreTarget);
    result.restored = errors.length === 0 && hardFailures(result.restoreChecks).length === 0;
    if (!result.restored) result.error = [result.error, `restore left the model different from nominal: ${errors.join(", ") || hardFailures(result.restoreChecks).map((k) => k.name).join(", ")}`].filter(Boolean).join("; ");
  } catch (err) {
    result.restored = false;
    result.error = [result.error, `restore failed: ${messageOf(err)}`].filter(Boolean).join("; ");
  }

  const failing = hardFailures(result.checks).map((k) => `${k.name} expected ${k.expected} got ${k.actual}`);
  log(`behaviour ${c.target}: ${result.status}${failing.length ? ` (${failing.join("; ")})` : ""}${result.restored ? ", restored" : ", NOT restored"}`);
  return result;
}

/** "D1@Sketch1 = 60 mm" and "60 mm" both mean the expression "60 mm". */
export function normalizeExpression(expression: string): string {
  const i = expression.lastIndexOf("=");
  return (i >= 0 ? expression.slice(i + 1) : expression).trim();
}

interface Located {
  sketch: BTMSketch;
  constraint: BTSketchConstraint;
  quantity: BTParameterQuantity;
}

/**
 * The Onshape sketch constraint that carries an IR dimension. The composer
 * names dimension constraints "<planOpId>.<safeId(dimensionId)>", so the
 * dimension is found by its suffix without knowing which plan op wrote it.
 */
export function locateDimension(list: FeatureListResponse, target: string): Located | { error: string } {
  const suffix = `.${safeId(target)}`;
  const matches: Located[] = [];
  for (const f of list.features) {
    if (f.btType !== "BTMSketch-151") continue;
    for (const c of f.constraints) {
      if (c.entityId !== suffix.slice(1) && !c.entityId.endsWith(suffix)) continue;
      const q = c.parameters.find((p): p is BTParameterQuantity => p.btType === "BTMParameterQuantity-147");
      if (q) matches.push({ sketch: f, constraint: c, quantity: q });
    }
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return { error: `no Onshape sketch dimension found for "${target}" (global variables are not perturbed yet; a skipped dimension cannot be tested)` };
  return { error: `"${target}" matches ${matches.length} sketch constraints` };
}

/** A copy of the sketch with one dimension's expression replaced. */
function withExpression(sketch: BTMSketch, entityId: string, expression: string): BTMSketch {
  const copy = structuredClone(sketch);
  const c = copy.constraints.find((k) => k.entityId === entityId)!;
  const q = c.parameters.find((p): p is BTParameterQuantity => p.btType === "BTMParameterQuantity-147")!;
  q.expression = expression;
  return copy;
}

/** Names of features whose regeneration status is ERROR. */
export function featureErrors(list: FeatureListResponse): string[] {
  const states = list.featureStates ?? {};
  return Object.entries(states)
    .filter(([, s]) => s.featureStatus === "ERROR")
    .map(([id]) => list.features.find((f) => f.featureId === id)?.name ?? id);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
