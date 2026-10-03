import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schema/ir.schema.json" with { type: "json" };
import type { Document, Feature, SketchFeature } from "./types.ts";

export interface Issue {
  /** JSON pointer-ish path into the document. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Schema violations (shape). */
  schema: Issue[];
  /** Referential violations the schema cannot express (ids, order, targets). */
  structure: Issue[];
}

let compiled: ValidateFunction | undefined;
function validator(): ValidateFunction {
  if (!compiled) {
    // strictRequired is off: the schema splits unions into a base (`required`)
    // plus `oneOf` variants that declare the properties, which that lint rejects.
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats.default(ajv);
    compiled = ajv.compile(schema);
  }
  return compiled;
}

/** Shape check only. Use `validateDocument` for the full check. */
export function validateSchema(value: unknown): Issue[] {
  const fn = validator();
  if (fn(value)) return [];
  return (fn.errors ?? []).map(formatAjvError);
}

function formatAjvError(e: ErrorObject): Issue {
  const detail = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : "";
  return { path: e.instancePath || "/", message: `${e.message ?? "invalid"}${detail}` };
}

/**
 * Full validation: schema, then structural rules.
 *
 * Structural rules:
 *  1. Feature ids and parameter ids are unique.
 *  2. A feature may only reference features that precede it (rollback order).
 *  3. `feature-output` refs with role "region" must target a sketch, role
 *     "plane" a plane feature, role "body" a solid-producing feature.
 *  4. Pattern/mirror seeds and `topo.createdBy` must name earlier features.
 *  5. `sketch-entity` refs must name an existing entity of an earlier sketch.
 *  6. Sketch entity ids are unique per sketch; string constraint/dimension
 *     args must name an entity of that sketch or ORIGIN.
 *  7. `Quantity.parameter` must name a declared parameter.
 */
export function validateDocument(value: unknown): ValidationResult {
  const schemaIssues = validateSchema(value);
  if (schemaIssues.length) return { ok: false, schema: schemaIssues, structure: [] };

  const doc = value as Document;
  const structure = checkStructure(doc);
  return { ok: structure.length === 0, schema: [], structure };
}

/** Throws with a readable message if the document is invalid. */
export function assertValidDocument(value: unknown): asserts value is Document {
  const r = validateDocument(value);
  if (r.ok) return;
  const lines = [...r.schema, ...r.structure].map((i) => `  ${i.path}: ${i.message}`);
  throw new Error(`invalid IR document:\n${lines.join("\n")}`);
}

const SOLID_OPS = new Set<Feature["op"]>([
  "extrude",
  "revolve",
  "fillet",
  "chamfer",
  "hole",
  "shell",
  "linearPattern",
  "circularPattern",
  "mirror",
]);

function checkStructure(doc: Document): Issue[] {
  const issues: Issue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  const params = new Set<string>();
  doc.parameters.forEach((p, i) => {
    if (params.has(p.id)) push(`/parameters/${i}/id`, `duplicate parameter id "${p.id}"`);
    params.add(p.id);
  });

  const seen = new Map<string, Feature>();
  const sketchEntities = new Map<string, Set<string>>();

  doc.partStudio.features.forEach((f, i) => {
    const base = `/partStudio/features/${i}`;
    if (seen.has(f.id)) push(`${base}/id`, `duplicate feature id "${f.id}"`);

    if (f.op === "sketch") checkSketch(f, base, push);

    // Walk the intent layer for references to other features and parameters.
    walk(stripDerived(f), base, (node, path) => {
      if (!isRecord(node)) return;

      if (node.kind === "feature-output" || node.kind === "topo" || node.kind === "sketch-entity") {
        const targetId = (node.kind === "topo" ? node.createdBy : node.kind === "sketch-entity" ? node.sketch : node.feature) as
          | string
          | undefined;
        if (targetId === undefined) return;
        const target = seen.get(targetId);
        if (!target) {
          push(path, `references feature "${targetId}" which does not precede "${f.id}"`);
          return;
        }
        if (node.kind === "feature-output") {
          const role = node.role as string;
          if (role === "region" && target.op !== "sketch") push(path, `role "region" must target a sketch, got "${target.op}"`);
          if (role === "plane" && target.op !== "plane") push(path, `role "plane" must target a plane feature, got "${target.op}"`);
          if (role === "body" && !SOLID_OPS.has(target.op)) push(path, `role "body" must target a solid feature, got "${target.op}"`);
        }
        if (node.kind === "sketch-entity") {
          const ents = sketchEntities.get(targetId);
          if (!ents?.has(node.entity as string)) push(path, `sketch "${targetId}" has no entity "${String(node.entity)}"`);
        }
      }

      if (typeof node.parameter === "string" && "expr" in node && !params.has(node.parameter)) {
        push(`${path}/parameter`, `unknown parameter "${node.parameter}"`);
      }
    });

    if ("seeds" in f) {
      (f.seeds as string[]).forEach((s, j) => {
        if (!seen.has(s)) push(`${base}/seeds/${j}`, `seed "${s}" does not precede "${f.id}"`);
      });
    }

    seen.set(f.id, f);
    if (f.op === "sketch") sketchEntities.set(f.id, new Set(f.entities.map((e) => e.id)));
  });

  return issues;
}

function checkSketch(s: SketchFeature, base: string, push: (path: string, message: string) => void): void {
  const ids = new Set<string>();
  s.entities.forEach((e, i) => {
    if (ids.has(e.id)) push(`${base}/entities/${i}/id`, `duplicate sketch entity id "${e.id}"`);
    ids.add(e.id);
  });

  const checkArg = (arg: unknown, path: string) => {
    if (typeof arg !== "string") return; // Ref: handled by the generic walk
    if (arg === "ORIGIN") return;
    const entity = arg.split(".")[0]!;
    if (!ids.has(entity)) push(path, `unknown sketch entity "${entity}"`);
  };
  s.constraints.forEach((c, i) => c.args.forEach((a, j) => checkArg(a, `${base}/constraints/${i}/args/${j}`)));
  s.dimensions.forEach((d, i) => d.args.forEach((a, j) => checkArg(a, `${base}/dimensions/${i}/args/${j}`)));
}

function stripDerived(f: Feature): unknown {
  const { evidence: _e, ext: _x, ...intent } = f;
  return intent;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(node: unknown, path: string, visit: (node: unknown, path: string) => void): void {
  visit(node, path);
  if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${path}/${i}`, visit));
  else if (isRecord(node)) for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`, visit);
}
