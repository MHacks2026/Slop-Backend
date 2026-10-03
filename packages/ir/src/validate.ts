import { z } from "zod";
import { Document } from "./schema/document";
import type { Assembly } from "./schema/assembly";
import type { Feature, SketchFeature } from "./schema/features";
import type { Id } from "./schema/primitives";
import type { Ref } from "./schema/ref";
import type { SketchEntity } from "./schema/sketch";

/** Parse untrusted JSON into a Document. Throws with a readable message on failure. */
export function parseDocument(input: unknown): Document {
  const result = Document.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid IR document:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function safeParseDocument(input: unknown): z.ZodSafeParseResult<Document> {
  return Document.safeParse(input);
}

export interface IntegrityIssue {
  code: IntegrityCode;
  /** JSON-pointer-like path to the offending node. */
  path: string;
  message: string;
}

export type IntegrityCode =
  | "duplicate-id"
  | "unknown-feature"
  | "forward-reference"
  | "unknown-sketch-entity"
  | "invalid-sub-point"
  | "unknown-external-ref"
  | "wrong-feature-kind"
  | "unknown-parameter"
  | "unknown-dimension"
  | "unknown-configuration"
  | "unknown-component"
  | "unknown-instance"
  | "evidence-mismatch";

/**
 * Referential checks the type system cannot express: ids are unique, every
 * reference points at something that exists, and features only reference
 * features that precede them in rollback order.
 */
export function checkIntegrity(doc: Document): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const push = (code: IntegrityCode, path: string, message: string) => issues.push({ code, path, message });

  const parameterIds = uniqueIds(doc.parameters, "/parameters", push);
  const configurationIds = uniqueIds(doc.configurations, "/configurations", push);
  const partStudioIds = uniqueIds(doc.partStudios, "/partStudios", push);
  const assemblyIds = uniqueIds(doc.assemblies, "/assemblies", push);

  // Dimension names are document-global ("D1@Sketch1"), as are named feature quantities.
  const dimensionIds = new Set<Id>();
  const quantityNames = new Set<Id>();

  doc.partStudios.forEach((ps, psIndex) => {
    const base = `/partStudios/${psIndex}`;
    const featureIndex = new Map<Id, number>();
    const featureById = new Map<Id, Feature>();
    ps.features.forEach((f, i) => {
      if (featureIndex.has(f.id)) push("duplicate-id", `${base}/features/${i}/id`, `duplicate feature id "${f.id}"`);
      featureIndex.set(f.id, i);
      featureById.set(f.id, f);
    });

    ps.features.forEach((f, i) => {
      const fpath = `${base}/features/${i}`;
      const requireEarlier = (target: Id, path: string) => {
        const j = featureIndex.get(target);
        if (j === undefined) {
          push("unknown-feature", path, `feature "${target}" does not exist in part studio "${ps.id}"`);
          return undefined;
        }
        if (j >= i) {
          push("forward-reference", path, `feature "${f.id}" references "${target}", which does not precede it`);
        }
        return featureById.get(target);
      };

      f.parents?.forEach((p, k) => requireEarlier(p, `${fpath}/parents/${k}`));

      forEachRef(f, fpath, (ref, path) => checkRef(ref, path, requireEarlier, push));

      if (f.op === "sketch") checkSketch(f, fpath, dimensionIds, push);
      if (f.op === "hole") {
        const target = requireEarlier(f.positionSketch, `${fpath}/positionSketch`);
        if (target && target.op !== "sketch") {
          push("wrong-feature-kind", `${fpath}/positionSketch`, `positionSketch "${f.positionSketch}" is not a sketch`);
        }
      }
      if (f.op === "linearPattern" || f.op === "circularPattern" || f.op === "mirror") {
        f.seedFeatures.forEach((s, k) => requireEarlier(s, `${fpath}/seedFeatures/${k}`));
      }

      forEachQuantityName(f, (name) => quantityNames.add(name));
    });

    if (ps.evidence) {
      for (const [key, ev] of Object.entries(ps.evidence)) {
        const path = `${base}/evidence/${key}`;
        if (!featureIndex.has(key)) push("unknown-feature", path, `evidence for unknown feature "${key}"`);
        if (ev.feature !== key) push("evidence-mismatch", `${path}/feature`, `evidence key "${key}" does not match feature "${ev.feature}"`);
      }
    }
  });

  doc.parameters.forEach((p, i) => {
    if (p.target !== undefined && !dimensionIds.has(p.target) && !quantityNames.has(p.target)) {
      push("unknown-dimension", `/parameters/${i}/target`, `equation target "${p.target}" is not a dimension or named quantity`);
    }
  });

  doc.partStudios.forEach((ps, psIndex) => {
    ps.features.forEach((f, i) => {
      if (f.op !== "sketch") return;
      f.dimensions.forEach((d, k) => {
        if (d.parameter !== undefined && !parameterIds.has(d.parameter)) {
          push("unknown-parameter", `/partStudios/${psIndex}/features/${i}/dimensions/${k}/parameter`, `unknown parameter "${d.parameter}"`);
        }
      });
    });
  });

  const allFeatureIds = new Set(doc.partStudios.flatMap((ps) => ps.features.map((f) => f.id)));
  doc.configurations.forEach((c, i) => {
    const cpath = `/configurations/${i}`;
    if (c.parent !== undefined && !configurationIds.has(c.parent)) {
      push("unknown-configuration", `${cpath}/parent`, `unknown parent configuration "${c.parent}"`);
    }
    c.overrides.forEach((o, k) => {
      const opath = `${cpath}/overrides/${k}`;
      if (o.kind === "parameter" && !parameterIds.has(o.parameter)) push("unknown-parameter", opath, `unknown parameter "${o.parameter}"`);
      if (o.kind === "dimension" && !dimensionIds.has(o.dimension) && !quantityNames.has(o.dimension)) {
        push("unknown-dimension", opath, `unknown dimension "${o.dimension}"`);
      }
      if (o.kind === "suppression" && !allFeatureIds.has(o.feature)) push("unknown-feature", opath, `unknown feature "${o.feature}"`);
    });
  });
  if (doc.activeConfiguration !== undefined && !configurationIds.has(doc.activeConfiguration)) {
    push("unknown-configuration", "/activeConfiguration", `unknown configuration "${doc.activeConfiguration}"`);
  }

  const assemblyById = new Map(doc.assemblies.map((a) => [a.id, a]));
  doc.assemblies.forEach((asm, i) => {
    const apath = `/assemblies/${i}`;
    const instanceIds = uniqueIds(asm.instances, `${apath}/instances`, push);
    asm.instances.forEach((inst, k) => {
      const c = inst.component;
      if (c.kind === "partStudio" && !partStudioIds.has(c.partStudio)) {
        push("unknown-component", `${apath}/instances/${k}/component`, `unknown part studio "${c.partStudio}"`);
      }
      if (c.kind === "assembly" && !assemblyIds.has(c.assembly)) {
        push("unknown-component", `${apath}/instances/${k}/component`, `unknown assembly "${c.assembly}"`);
      }
    });
    asm.mates.forEach((m, k) => {
      m.entities.forEach((e, j) => {
        const path = `${apath}/mates/${k}/entities/${j}/instancePath`;
        if (!resolveInstancePath(asm, e.instancePath, assemblyById)) {
          push("unknown-instance", path, `instance path [${e.instancePath.join(" > ")}] does not resolve`);
        }
      });
    });
    void instanceIds;
  });

  return issues;
}

function uniqueIds(items: { id: Id }[], base: string, push: (c: IntegrityCode, p: string, m: string) => void): Set<Id> {
  const seen = new Set<Id>();
  items.forEach((it, i) => {
    if (seen.has(it.id)) push("duplicate-id", `${base}/${i}/id`, `duplicate id "${it.id}"`);
    seen.add(it.id);
  });
  return seen;
}

function checkRef(
  ref: Ref,
  path: string,
  requireEarlier: (target: Id, path: string) => Feature | undefined,
  push: (c: IntegrityCode, p: string, m: string) => void,
): void {
  if (ref.kind === "datum") {
    if (ref.feature !== undefined) requireEarlier(ref.feature, `${path}/feature`);
    return;
  }
  if (ref.kind === "topo") {
    if (ref.createdBy !== undefined) requireEarlier(ref.createdBy, `${path}/createdBy`);
    return;
  }
  const target = requireEarlier(ref.feature, `${path}/feature`);
  if (!target) return;
  if (ref.role === "region" || ref.role === "sketchEntity") {
    if (target.op !== "sketch") {
      push("wrong-feature-kind", path, `role "${ref.role}" needs a sketch, but "${ref.feature}" is a ${target.op}`);
      return;
    }
    if (ref.role === "sketchEntity") {
      if (ref.entity === undefined) {
        push("unknown-sketch-entity", `${path}/entity`, `role "sketchEntity" requires an entity id`);
      } else if (!target.entities.some((e) => e.id === ref.entity)) {
        push("unknown-sketch-entity", `${path}/entity`, `sketch "${ref.feature}" has no entity "${ref.entity}"`);
      }
    }
  }
  if (ref.role === "plane" && target.op !== "plane" && target.op !== "sketch") {
    push("wrong-feature-kind", path, `role "plane" needs a plane or sketch feature, but "${ref.feature}" is a ${target.op}`);
  }
  if (ref.role === "axis" && target.op !== "axis" && target.op !== "sketch") {
    push("wrong-feature-kind", path, `role "axis" needs an axis or sketch feature, but "${ref.feature}" is a ${target.op}`);
  }
}

const SUB_POINTS: Record<SketchEntity["type"], readonly string[]> = {
  point: [],
  line: ["start", "end", "mid"],
  arc: ["start", "end", "center", "mid"],
  circle: ["center"],
  ellipse: ["center"],
  spline: ["start", "end"],
  other: ["start", "end", "center", "mid"],
};

function checkSketch(
  f: SketchFeature,
  fpath: string,
  dimensionIds: Set<Id>,
  push: (c: IntegrityCode, p: string, m: string) => void,
): void {
  const entities = new Map<string, SketchEntity>();
  f.entities.forEach((e, i) => {
    if (entities.has(e.id)) push("duplicate-id", `${fpath}/entities/${i}/id`, `duplicate sketch entity id "${e.id}"`);
    entities.set(e.id, e);
  });
  const external = new Set(Object.keys(f.externalRefs ?? {}));

  const checkArg = (arg: string, path: string) => {
    if (arg === "ORIGIN") return;
    if (arg.startsWith("ext:")) {
      if (!external.has(arg.slice(4))) push("unknown-external-ref", path, `sketch "${f.id}" has no external ref "${arg.slice(4)}"`);
      return;
    }
    const [id, sub] = arg.split(".");
    const entity = entities.get(id!);
    if (!entity) {
      push("unknown-sketch-entity", path, `sketch "${f.id}" has no entity "${id}"`);
      return;
    }
    if (sub !== undefined && !SUB_POINTS[entity.type].includes(sub)) {
      push("invalid-sub-point", path, `"${sub}" is not a point of a ${entity.type}`);
    }
  };

  f.constraints.forEach((c, i) => c.args.forEach((a, k) => checkArg(a, `${fpath}/constraints/${i}/args/${k}`)));
  f.dimensions.forEach((d, i) => {
    if (dimensionIds.has(d.id)) push("duplicate-id", `${fpath}/dimensions/${i}/id`, `duplicate dimension id "${d.id}"`);
    dimensionIds.add(d.id);
    d.args.forEach((a, k) => checkArg(a, `${fpath}/dimensions/${i}/args/${k}`));
  });
}

function resolveInstancePath(asm: Assembly, path: Id[], assemblies: Map<Id, Assembly>): boolean {
  let current: Assembly | undefined = asm;
  for (let i = 0; i < path.length; i++) {
    if (!current) return false;
    const inst = current.instances.find((x) => x.id === path[i]);
    if (!inst) return false;
    if (i === path.length - 1) return true;
    if (inst.component.kind !== "assembly") return false;
    current = assemblies.get(inst.component.assembly);
  }
  return false;
}

const REF_KINDS = new Set(["datum", "feature-output", "topo"]);

/** Visit every Ref inside a feature, skipping vendor `ext` payloads. */
export function forEachRef(node: unknown, path: string, visit: (ref: Ref, path: string) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => forEachRef(v, `${path}/${i}`, visit));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.kind === "string" && REF_KINDS.has(obj.kind)) {
    visit(obj as Ref, path);
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "ext") continue;
    forEachRef(value, `${path}/${key}`, visit);
  }
}

/** Visit every named Quantity inside a feature (feature-level dimensions such as "D1@Boss-Extrude1"). */
export function forEachQuantityName(node: unknown, visit: (name: Id) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v) => forEachQuantityName(v, visit));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.expr === "string" && typeof obj.value === "number" && typeof obj.name === "string") {
    visit(obj.name);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "ext") continue;
    forEachQuantityName(value, visit);
  }
}
