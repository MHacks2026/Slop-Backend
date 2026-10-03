import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJsonSchema } from "../src/json-schema";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../schema/ir.schema.json");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(buildJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
