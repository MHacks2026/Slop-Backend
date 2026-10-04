#!/usr/bin/env node
/**
 * Check IR documents against the schema and the structural rules, e.g. the
 * output of the SOLIDWORKS extractor before building it in Onshape.
 *
 *   npm run validate -w @slop/ir -- <file.ir.json>...
 *
 * Prints the issues, or the feature count and intent hash of a valid document.
 * Exits 1 if any document is invalid.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashDocument } from "./canonical.ts";
import type { Document } from "./types.ts";
import { validateDocument } from "./validate.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: validate <file.ir.json>...");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  let value: unknown;
  try {
    // `npm run -w` starts in the package folder; resolve against where npm was invoked.
    value = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8"));
  } catch (err) {
    console.log(`${file}: cannot read: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
    continue;
  }
  const r = validateDocument(value);
  if (!r.ok) {
    failed++;
    console.log(`${file}: INVALID`);
    for (const i of [...r.schema, ...r.structure]) console.log(`  ${i.path}: ${i.message}`);
    continue;
  }
  const doc = value as Document;
  const ops = new Map<string, number>();
  for (const f of doc.partStudio.features) ops.set(f.op, (ops.get(f.op) ?? 0) + 1);
  const summary = [...ops].map(([op, n]) => `${n} ${op}`).join(", ");
  console.log(`${file}: ok, ${doc.partStudio.features.length} features (${summary}), intent ${hashDocument(doc).intent.slice(0, 12)}`);
}
process.exitCode = failed ? 1 : 0;
