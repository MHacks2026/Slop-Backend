import type { Parameter, Quantity } from "@slop/ir";
import type { BTParameterBoolean, BTParameterEnum, BTParameterQuantity, BTParameterQueryList, BTParameterString, BTQuery } from "./client/types.ts";

/** A literal like "50 mm", "2.5 in", "90 deg": safe to pass to Onshape unchanged. */
const LITERAL = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*(mm|cm|m|in|ft|yd|deg|rad)\s*$/;

const fmt = (n: number): string => {
  const s = Number(n.toPrecision(12)).toString();
  return s.includes("e") ? n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") : s;
};

/**
 * Onshape expression for a length Quantity. Prefers the source literal (keeps
 * "50 mm" rather than "50.000000 mm"); otherwise formats the SI value in mm.
 * A quantity bound to a parameter becomes a `#variable` reference.
 */
export function lengthExpression(q: Quantity, parameters?: ReadonlyMap<string, Parameter>): string {
  if (q.parameter && parameters?.has(q.parameter)) return `#${variableName(parameters.get(q.parameter)!)}`;
  if (LITERAL.test(q.expr)) return q.expr.trim();
  return `${fmt(q.value * 1000)} mm`;
}

export function angleExpression(q: Quantity, parameters?: ReadonlyMap<string, Parameter>): string {
  if (q.parameter && parameters?.has(q.parameter)) return `#${variableName(parameters.get(q.parameter)!)}`;
  if (LITERAL.test(q.expr)) return q.expr.trim();
  return `${fmt((q.value * 180) / Math.PI)} deg`;
}

export function countExpression(q: Quantity, parameters?: ReadonlyMap<string, Parameter>): string {
  if (q.parameter && parameters?.has(q.parameter)) return `#${variableName(parameters.get(q.parameter)!)}`;
  return String(Math.round(q.value));
}

/** Onshape variable names: letters, digits, underscore; SolidWorks allows more. */
export function variableName(p: Parameter): string {
  const cleaned = p.name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `v_${cleaned}`;
}

// --- parameter constructors ---------------------------------------------------

export const quantity = (parameterId: string, expression: string): BTParameterQuantity => ({
  btType: "BTMParameterQuantity-147",
  parameterId,
  expression,
});
export const enumParam = (parameterId: string, enumName: string, value: string): BTParameterEnum => ({
  btType: "BTMParameterEnum-145",
  parameterId,
  enumName,
  value,
});
export const boolParam = (parameterId: string, value: boolean): BTParameterBoolean => ({
  btType: "BTMParameterBoolean-144",
  parameterId,
  value,
});
export const stringParam = (parameterId: string, value: string): BTParameterString => ({
  btType: "BTMParameterString-149",
  parameterId,
  value,
});
export const queryList = (parameterId: string, queries: BTQuery[]): BTParameterQueryList => ({
  btType: "BTMParameterQueryList-148",
  parameterId,
  queries,
});
export const idQuery = (deterministicIds: string[]): BTQuery => ({ btType: "BTMIndividualQuery-138", deterministicIds });
export const sketchRegionQuery = (featureId: string): BTQuery => ({ btType: "BTMIndividualSketchRegionQuery-140", featureId });
