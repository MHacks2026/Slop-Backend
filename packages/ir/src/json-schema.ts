import { z } from "zod";
import { Document } from "./schema/document";
import { IR_VERSION } from "./schema/primitives";

export const IR_SCHEMA_ID = `https://slop.dev/schemas/ir/${IR_VERSION}/ir.schema.json`;

/**
 * JSON Schema (draft 2020-12) for a Document, generated from the Zod
 * definition. Consumers: the C# extractor (via quicktype or NJsonSchema),
 * the LLM translator (structured output), and any non-TypeScript tool.
 * Every node with a `meta({ id })` becomes a named entry in `$defs`.
 */
export function buildJsonSchema(): Record<string, unknown> {
  // `reused: "inline"` keeps only nodes with a meta id in $defs; "ref" would also
  // extract every shared primitive as an anonymous __schemaN entry.
  const schema = z.toJSONSchema(Document, {
    target: "draft-2020-12",
    reused: "inline",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return { $id: IR_SCHEMA_ID, ...schema };
}
