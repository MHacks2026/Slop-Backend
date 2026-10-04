#!/usr/bin/env node
/**
 * Phase 0 CLI. Needs packages/onshape/.env (see .env.example), except `plan`.
 *
 *   npm run cli -- plan <ir.json>      offline: what the direct proposers would emit per feature, or why they refuse
 *   npm run cli -- build <ir.json> [--planner rules|claude|replay] [--plan accepted.json] [--name N] [--out report.json] [--continue] [--target did/wid/eid [--replace]] [--max-attempts N] [--no-behavior]
 *   npm run cli -- readback <did> <wid> <eid> [--out features.json]
 *   npm run cli -- planes <did> <wid> <eid>
 *   npm run cli -- massprops <did> <wid> <eid>
 *   npm run cli -- topology <did> <wid> <eid> <featureId> [face|edge|vertex]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assertValidDocument, hashDocument, type Document } from "@slop/ir";
import { buildDocument, DATUM_REMAP } from "./builder.ts";
import { OnshapeClient } from "./client/client.ts";
import type { DocumentRef } from "./client/types.ts";
import { loadClaudeConfig, loadConfig } from "./env.ts";
import { queryTopology } from "./fs/topology.ts";
import type { BuildPlan } from "./plan/types.ts";
import { ClaudePlanner } from "./planner/claude.ts";
import { ReplayPlanner } from "./planner/replay.ts";
import { RulePlanner } from "./planner/rules.ts";
import type { Planner } from "./planner/types.ts";
import { proposeDirect } from "./proposers/index.ts";
import { renderMarkdown } from "./report.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    out: { type: "string" },
    continue: { type: "boolean", default: false },
    target: { type: "string" },
    "no-stats": { type: "boolean", default: false },
    planner: { type: "string", default: "rules" },
    plan: { type: "string" },
    "max-attempts": { type: "string" },
    /** Skip the Level 3 behaviour tests after the build (each costs a few API calls). */
    "no-behavior": { type: "boolean", default: false },
    /** With --target: delete the Part Studio's existing features first, so a rebuild does not stack on a previous one. */
    replace: { type: "boolean", default: false },
  },
});

const [command, ...args] = positionals;

function ref(a: string[]): DocumentRef {
  const [did, wid, eid] = a;
  if (!did || !wid || !eid) throw new Error("expected <did> <wid> <eid>");
  return { did, wid, eid };
}

function plannerFor(irHash: string): Planner {
  switch (values.planner) {
    case "rules":
      return new RulePlanner();
    case "claude": {
      const cfg = loadClaudeConfig();
      return new ClaudePlanner({ apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl });
    }
    case "replay": {
      if (!values.plan) throw new Error("replay planner needs --plan <accepted.json>");
      const plan = JSON.parse(readFileSync(values.plan, "utf8")) as BuildPlan;
      return new ReplayPlanner(plan, irHash);
    }
    default:
      throw new Error(`unknown --planner ${values.planner} (rules | claude | replay)`);
  }
}

async function main(): Promise<void> {
  if (!command) {
    console.error("usage: plan | build | readback | planes | massprops | topology (see header of src/cli.ts)");
    process.exitCode = 2;
    return;
  }

  // `plan` needs no Onshape credentials: it only asks the direct proposers what they would do.
  if (command === "plan") {
    const file = args[0];
    if (!file) throw new Error("plan: expected path to an IR JSON file");
    const ir = JSON.parse(readFileSync(file, "utf8"));
    assertValidDocument(ir);
    process.exitCode = planDryRun(ir) ? 0 : 1;
    return;
  }

  const client = new OnshapeClient(loadConfig());

  switch (command) {
    case "build": {
      const file = args[0];
      if (!file) throw new Error("build: expected path to an IR JSON file");
      const ir = JSON.parse(readFileSync(file, "utf8"));
      assertValidDocument(ir);
      const target = values.target ? ref(values.target.split("/")) : undefined;
      if (target && values.replace) {
        const existing = (await client.getFeatures(target)).features.filter((f) => f.featureId);
        console.error(`--replace: deleting ${existing.length} existing feature(s) in the target Part Studio`);
        for (const f of [...existing].reverse()) await client.deleteFeature(target, f.featureId!);
      }
      const report = await buildDocument(ir, client, {
        planner: plannerFor(hashDocument(ir).intent),
        ...(values.name ? { name: values.name } : {}),
        ...(target ? { target } : {}),
        ...(values["max-attempts"] ? { maxAttempts: Number(values["max-attempts"]) } : {}),
        stopOnDivergence: !values.continue,
        bodyStats: !values["no-stats"],
        behavior: !values["no-behavior"],
        log: (l) => console.error(l),
      });
      if (values.out) {
        writeFileSync(values.out, JSON.stringify(report, null, 2));
        writeFileSync(values.out.replace(/\.json$/, "") + ".md", renderMarkdown(report));
        writeFileSync(values.out.replace(/\.json$/, "") + ".plan.json", JSON.stringify(report.plan, null, 2));
        console.error(`wrote ${values.out} and the accepted plan`);
      }
      console.log(renderMarkdown(report));
      console.error(`API calls by endpoint: ${JSON.stringify(client.http.stats.byPath, null, 2)}`);
      if (report.summary.failed) process.exitCode = 1;
      return;
    }

    case "readback": {
      const features = await client.getFeatures(ref(args));
      const text = JSON.stringify(features, null, 2);
      if (values.out) writeFileSync(values.out, text);
      else console.log(text);
      return;
    }

    case "planes": {
      const r = ref(args);
      for (const name of ["Top", "Front", "Right"]) {
        const faces = await queryTopology(client, r, name, "face");
        console.log(name, JSON.stringify(faces));
      }
      console.log("Origin", JSON.stringify(await queryTopology(client, r, "Origin", "vertex")));
      console.log("remap (SolidWorks -> Onshape):", JSON.stringify(DATUM_REMAP));
      return;
    }

    case "massprops": {
      console.log(JSON.stringify(await client.massProperties(ref(args)), null, 2));
      return;
    }

    case "topology": {
      const r = ref(args);
      const featureId = args[3];
      if (!featureId) throw new Error("topology: expected <featureId>");
      const entity = (args[4] ?? "face") as "face" | "edge" | "vertex";
      console.log(JSON.stringify(await queryTopology(client, r, featureId, entity), null, 2));
      return;
    }

    default:
      throw new Error(`unknown command "${command}"`);
  }
}

/**
 * Offline mappability check: what the direct proposers would emit for each
 * feature, or why they refuse. Selections are not resolved (that needs
 * Onshape), so this says "has a mapping", not "will build".
 */
function planDryRun(ir: Document): boolean {
  const ctx = {
    ir,
    onshapeId: () => undefined,
    sketchFrame: () => undefined,
    datumFrame: async () => ({ origin: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0] }),
    listTopology: async () => [],
    opsFor: () => [],
  } as unknown as import("./plan/executor.ts").StepContext;
  const parameters = new Map(ir.parameters.map((p) => [p.id, p]));
  let refused = 0;
  console.log(`${ir.partStudio.name}: ${ir.partStudio.features.length} features, ${ir.parameters.length} parameters${ir.behaviorEvidence?.length ? `, ${ir.behaviorEvidence.length} behaviour cases` : ""}`);
  for (const f of ir.partStudio.features) {
    const notes = f.fidelity.notes ? `  [source: ${f.fidelity.notes}]` : "";
    if (f.suppressed) {
      console.log(`  ${f.id.padEnd(4)} ${f.src.name.padEnd(28)} ${f.op.padEnd(16)} suppressed in source; skipped${notes}`);
      continue;
    }
    try {
      const ops = proposeDirect(f, ctx, parameters);
      const what = ops.map((o) => (o.op === "createSketch" ? `sketch(${o.entities.length} entities, ${o.constraints.length} constraints, ${o.dimensions.length} dims)` : o.op === "createFeature" ? o.featureType : o.op)).join(" + ");
      const order = ["exact", "composite", "featurescript", "approximated", "geometry", "dropped"];
      const rung = ops.map((o) => o.rung).reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "exact" as (typeof ops)[number]["rung"]);
      console.log(`  ${f.id.padEnd(4)} ${f.src.name.padEnd(28)} ${f.op.padEnd(16)} -> ${what} [${rung}]${notes}`);
    } catch (err) {
      refused++;
      console.log(`  ${f.id.padEnd(4)} ${f.src.name.padEnd(28)} ${f.op.padEnd(16)} !! ${err instanceof Error ? err.message : String(err)}${notes}`);
    }
  }
  console.log(refused ? `${refused} feature(s) have no direct mapping; the LLM planner would have to handle them.` : "every feature has a direct mapping.");
  return refused === 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
