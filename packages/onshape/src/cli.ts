#!/usr/bin/env node
/**
 * Phase 0 CLI. Needs packages/onshape/.env (see .env.example).
 *
 *   npm run cli -- build <ir.json> [--planner rules|claude|replay] [--plan accepted.json] [--name N] [--out report.json] [--continue] [--target did/wid/eid] [--max-attempts N]
 *   npm run cli -- readback <did> <wid> <eid> [--out features.json]
 *   npm run cli -- planes <did> <wid> <eid>
 *   npm run cli -- massprops <did> <wid> <eid>
 *   npm run cli -- topology <did> <wid> <eid> <featureId> [face|edge|vertex]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assertValidDocument, hashDocument } from "@slop/ir";
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
    console.error("usage: build | readback | planes | massprops | topology (see header of src/cli.ts)");
    process.exitCode = 2;
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
      const report = await buildDocument(ir, client, {
        planner: plannerFor(hashDocument(ir).intent),
        ...(values.name ? { name: values.name } : {}),
        ...(target ? { target } : {}),
        ...(values["max-attempts"] ? { maxAttempts: Number(values["max-attempts"]) } : {}),
        stopOnDivergence: !values.continue,
        bodyStats: !values["no-stats"],
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
