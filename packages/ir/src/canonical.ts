import type { Document, PartStudio } from "./schema/document";
import type { Feature } from "./schema/features";
import type { Id } from "./schema/primitives";

/**
 * Deterministic, content-addressed serialization (architecture doc, section 5).
 *
 * Canonical form: object keys sorted, `undefined` members dropped, no whitespace,
 * numbers rounded to a fixed number of significant digits with -0 folded to 0.
 * Two IR values that mean the same thing serialize to the same bytes and hash
 * to the same id. Hashes are sha256 hex, computed with Web Crypto so they work
 * in Node and in Cloudflare Workers.
 */

export interface CanonicalOptions {
  /** Significant digits kept for numbers. Default 12, which is well below double precision noise. */
  precision?: number;
}

const DEFAULT_PRECISION = 12;

export function canonicalize(value: unknown, opts: CanonicalOptions = {}): unknown {
  const precision = opts.precision ?? DEFAULT_PRECISION;
  return walk(value, precision, "$");
}

function walk(value: unknown, precision: number, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return canonicalNumber(value, precision, path);
    case "undefined":
      throw new Error(`canonicalize: undefined is not allowed at ${path}`);
    case "object":
      break;
    default:
      throw new Error(`canonicalize: unsupported ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, precision, `${path}[${i}]`));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`canonicalize: non-plain object at ${path}`);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = walk(v, precision, `${path}.${key}`);
  }
  return out;
}

export function canonicalNumber(n: number, precision = DEFAULT_PRECISION, path = "$"): number {
  if (!Number.isFinite(n)) throw new Error(`canonicalize: non-finite number at ${path}`);
  const rounded = Number(n.toPrecision(precision));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Canonical JSON text of any IR value. */
export function canonicalJson(value: unknown, opts?: CanonicalOptions): string {
  return JSON.stringify(canonicalize(value, opts));
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 of the canonical JSON of a value. */
export function hashValue(value: unknown, opts?: CanonicalOptions): Promise<string> {
  return sha256Hex(canonicalJson(value, opts));
}

export interface PartStudioHashes {
  hash: string;
  features: Record<Id, string>;
}

export interface DocumentHashes {
  /** Hash of the intent layer of the whole document. */
  document: string;
  parameters: string;
  configurations: string;
  partStudios: Record<Id, PartStudioHashes>;
  assemblies: Record<Id, string>;
}

/** Intent-only view of a feature: translator output (`fidelity`) is not intent. */
export function featureIntent(feature: Feature): Omit<Feature, "fidelity"> {
  const { fidelity: _fidelity, ...intent } = feature;
  return intent;
}

/**
 * Merkle hashes of the intent layer. Excludes the evidence layer (regenerable),
 * `source` (provenance of one extraction), the document `id`, and every
 * feature's `fidelity`. Two extractions of the same model from the same file
 * therefore hash the same, and so do a model and its re-import.
 */
export async function hashDocument(doc: Document, opts?: CanonicalOptions): Promise<DocumentHashes> {
  const partStudios: Record<Id, PartStudioHashes> = {};
  const partStudioHashes: string[] = [];
  for (const ps of doc.partStudios) {
    const h = await hashPartStudio(ps, opts);
    partStudios[ps.id] = h;
    partStudioHashes.push(h.hash);
  }

  const assemblies: Record<Id, string> = {};
  const assemblyHashes: string[] = [];
  for (const asm of doc.assemblies) {
    const h = await hashValue(asm, opts);
    assemblies[asm.id] = h;
    assemblyHashes.push(h);
  }

  const parameters = await hashValue(doc.parameters, opts);
  const configurations = await hashValue(doc.configurations, opts);

  const document = await hashValue(
    {
      irVersion: doc.irVersion,
      name: doc.name,
      units: doc.units,
      activeConfiguration: doc.activeConfiguration,
      properties: doc.properties,
      ext: doc.ext,
      parameters,
      configurations,
      partStudios: partStudioHashes,
      assemblies: assemblyHashes,
    },
    opts,
  );

  return { document, parameters, configurations, partStudios, assemblies };
}

export async function hashPartStudio(ps: PartStudio, opts?: CanonicalOptions): Promise<PartStudioHashes> {
  const features: Record<Id, string> = {};
  const featureHashes: string[] = [];
  for (const f of ps.features) {
    const h = await hashValue(featureIntent(f), opts);
    features[f.id] = h;
    featureHashes.push(h);
  }
  const { evidence: _evidence, features: _features, ...rest } = ps;
  const hash = await hashValue({ ...rest, features: featureHashes }, opts);
  return { hash, features };
}
