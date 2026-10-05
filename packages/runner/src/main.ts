/**
 * Build runner: the process that turns a queued build into an Onshape
 * document. Claims builds from Supabase, runs them with the Onshape and LLM
 * keys it holds, writes progress to build_events as it goes (the web app
 * subscribes through Realtime), and stores the report and accepted plan.
 *
 *   npm start -w packages/runner -- [--once] [--poll-ms 2000] [--worker-id name] [--no-behavior] [--env-keys]
 *
 * Env: SUPABASE_URL + SUPABASE_SECRET_KEY (environment or the repo's
 * .dev.vars); the Anthropic key from packages/onshape/.env. Each build runs
 * with the Onshape keys of the user who requested it (onshape_credentials,
 * read through build_onshape_credentials). --env-keys falls back to the keys
 * in packages/onshape/.env when the requester has none: local development
 * only, since those builds then land in that Onshape account.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ClaudePlanner, configForKeys, loadClaudeConfig, loadConfig, OnshapeClient, type OnshapeApi } from "@slop/onshape";
import { defaultPlanner, runBuild, type BuildInput, type RunEvent } from "./run-build.ts";

const { values: args } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    "poll-ms": { type: "string", default: "2000" },
    "worker-id": { type: "string", default: `runner@${hostname()}` },
    "no-behavior": { type: "boolean", default: false },
    "env-keys": { type: "boolean", default: false },
  },
});
const pollMs = Math.max(250, Number(args["poll-ms"]) || 2000);
const workerId = args["worker-id"]!;

// --- config -----------------------------------------------------------------

function readDevVars(): Record<string, string> {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".dev.vars");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

const devVars = readDevVars();
const env = (name: string) => process.env[name] || devVars[name] || undefined;
const supabaseUrl = env("SUPABASE_URL");
const supabaseKey = env("SUPABASE_SECRET_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL / SUPABASE_SECRET_KEY (environment or .dev.vars).");
  process.exit(1);
}

// With --env-keys, fail at startup, not on the first build, if the fallback keys are missing.
const envOnshape = args["env-keys"] ? new OnshapeClient(loadConfig()) : undefined;
const planner = defaultPlanner(loadClaudeConfig, ClaudePlanner);
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

// --- queue -------------------------------------------------------------------

interface BuildRow extends BuildInput {
  project_id: string;
  attempts: number;
}

async function claim(): Promise<BuildRow | null> {
  const { data, error } = await supabase.rpc("claim_build", { p_worker_id: workerId });
  if (error) throw new Error(`claim_build: ${error.message}`);
  const rows = (data ?? []) as BuildRow[];
  return rows[0] ?? null;
}

/** An Onshape client with the keys of the user who requested the build. */
async function onshapeFor(build: BuildRow): Promise<OnshapeApi> {
  const { data, error } = await supabase.rpc("build_onshape_credentials", { p_build_id: build.id });
  if (error) throw new Error(`build_onshape_credentials: ${error.message}`);
  const keys = ((data ?? []) as Array<{ access_key: string; secret_key: string }>)[0];
  if (keys) return new OnshapeClient(configForKeys(keys.access_key, keys.secret_key));
  if (envOnshape) {
    console.log("  no Onshape keys stored for the requester; using packages/onshape/.env (--env-keys)");
    return envOnshape;
  }
  throw new Error("No Onshape API keys stored for the user who requested this build. Add them with PUT /api/me/onshape.");
}

async function process1(sb: SupabaseClient, build: BuildRow): Promise<void> {
  const started = Date.now();
  console.log(`→ build ${build.id} "${build.name}" planner=${build.planner} attempt ${build.attempts}`);
  let seq = 0;

  const emit = async (e: RunEvent) => {
    seq += 1;
    const { error } = await sb.from("build_events").insert({ build_id: build.id, seq, kind: e.kind, payload: e.payload });
    if (error) throw new Error(`build_events: ${error.message}`);
    if (e.kind === "document") {
      await sb
        .from("builds")
        .update({ onshape_document_id: e.payload.did, onshape_workspace_id: e.payload.wid, onshape_element_id: e.payload.eid })
        .eq("id", build.id);
    }
    if (e.kind === "feature") console.log(`  ${e.payload.index as number}/${e.payload.total}: ${e.payload.name} ${e.payload.status} (${e.payload.rung})`);
    if (e.kind === "behavior") console.log(`  behaviour ${e.payload.target} -> ${e.payload.expression}: ${e.payload.status}`);
  };

  let api: OnshapeApi;
  try {
    api = await onshapeFor(build);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await emit({ kind: "finished", payload: { status: "failed", error: message } });
    await sb.from("builds").update({ status: "failed", error: message, finished_at: new Date().toISOString() }).eq("id", build.id);
    console.log(`  ✗ failed: ${message}`);
    return;
  }

  const out = await runBuild(build, { api, planner, emit, ...(args["no-behavior"] ? { behavior: false } : {}) });

  const { error } = await sb
    .from("builds")
    .update({
      status: out.status,
      error: out.error ?? null,
      ir_intent_hash: out.irIntentHash ?? null,
      summary: out.report?.summary ?? null,
      report: out.report ?? null,
      plan: out.report?.plan ?? null,
      onshape_document_id: out.document?.did ?? null,
      onshape_workspace_id: out.document?.wid ?? null,
      onshape_element_id: out.document?.eid ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", build.id);
  if (error) console.error(`  ! couldn't store result for ${build.id}: ${error.message}`);
  console.log(`  ${out.status === "succeeded" ? "✓" : "✗"} ${out.status} in ${((Date.now() - started) / 1000).toFixed(1)} s${out.error ? `: ${out.error.split("\n")[0]}` : ""}`);
}

// --- loop --------------------------------------------------------------------

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping after the current build (Ctrl-C again to abort)…");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`${workerId}: polling every ${pollMs} ms${args.once ? " (once)" : ""}. Ctrl-C to stop.`);
  while (!stopping) {
    let build: BuildRow | null;
    try {
      build = await claim();
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      await sleep(pollMs);
      continue;
    }
    if (!build) {
      if (args.once) break;
      await sleep(pollMs);
      continue;
    }
    try {
      await process1(supabase, build);
    } catch (e) {
      // runBuild never throws; this guards the Supabase writes around it.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`  ! build ${build.id}: ${message}`);
      await supabase.from("builds").update({ status: "failed", error: message, finished_at: new Date().toISOString() }).eq("id", build.id);
    }
    if (args.once) break;
  }
  console.log("Stopped.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
