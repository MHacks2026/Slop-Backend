import { createHash } from "node:crypto";
import type { Document, Feature, Parameter } from "./types.ts";

/**
 * Deterministic, content-addressed serialization (architecture doc §5, §10).
 *
 * Rules:
 * - Object keys sorted lexicographically (code-point order) at every level.
 * - Arrays keep their order (order is meaning: features, args, control points).
 * - `undefined` properties are dropped; `null` is kept.
 * - Numbers are rounded to 15 significant digits so that kernel noise in the
 *   last bits does not change a hash. Integers print without a fraction.
 *   -0 prints as 0. NaN and infinities are rejected.
 * - No whitespace.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return serializeNumber(v);
    case "object": {
      if (Array.isArray(v)) {
        return "[" + v.map((x) => serialize(x === undefined ? null : x)).join(",") + "]";
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareCodePoints);
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") + "}";
    }
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof v}`);
  }
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`non-finite number in IR: ${n}`);
  if (Object.is(n, -0)) return "0";
  if (Number.isInteger(n)) return n.toString();
  // 15 significant digits is below double precision (~15.95), so this is a
  // stable round-trip: Number(x.toPrecision(15)) is idempotent.
  const rounded = Number(n.toPrecision(15));
  return Object.is(rounded, -0) ? "0" : rounded.toString();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of any IR node, as serialized. */
export function hashNode(value: unknown): string {
  return sha256(canonicalize(value));
}

/** The intent layer of a feature: everything except derived evidence. */
export function intentOf<F extends Feature>(feature: F): Omit<F, "evidence"> {
  const { evidence: _evidence, ...intent } = feature;
  return intent;
}

export function hashFeature(feature: Feature): string {
  return hashNode(intentOf(feature));
}

export function hashParameter(parameter: Parameter): string {
  return hashNode(parameter);
}

export interface DocumentHashes {
  /** Merkle root over parameters and features. Excludes `source` and all evidence. */
  intent: string;
  parameters: Record<string, string>;
  features: Record<string, string>;
}

/**
 * Content hashes for a document. `intent` is what two commits compare: two
 * extractions of the same design from different files hash identically.
 */
export function hashDocument(doc: Document): DocumentHashes {
  const parameters: Record<string, string> = {};
  for (const p of doc.parameters) parameters[p.id] = hashParameter(p);

  const features: Record<string, string> = {};
  for (const f of doc.partStudio.features) features[f.id] = hashFeature(f);

  const intent = hashNode({
    irVersion: doc.irVersion,
    parameters: doc.parameters.map((p) => parameters[p.id]),
    partStudio: {
      id: doc.partStudio.id,
      name: doc.partStudio.name,
      features: doc.partStudio.features.map((f) => features[f.id]),
    },
  });

  return { intent, parameters, features };
}
