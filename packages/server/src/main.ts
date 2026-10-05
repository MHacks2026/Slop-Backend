/**
 * Studio server: run it on the machine that has SolidWorks, then open the web
 * app (Slop-Frontend). Signed-in CAD Hub users paste a document link; their
 * Onshape keys come from their account (saved at sign-up through the
 * Worker's PUT /api/me/onshape), read here with the Supabase service role.
 *
 *   npm run studio -- [--port 8788] [--host 127.0.0.1]
 *
 * Env (environment or the repo's .dev.vars): SUPABASE_URL, SUPABASE_SECRET_KEY
 * and FIREBASE_PROJECT_ID for accounts; packages/onshape/.env for
 * ANTHROPIC_API_KEY / ANTHROPIC_MODEL (Claude planner), ONSHAPE_AUTH_SCHEME
 * (basic | hmac), ONSHAPE_API_VERSION (v10); SLOP_EXTRACTOR (path to
 * SlopExtractor.exe).
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudePlanner, loadClaudeConfig, loadEnvFiles } from "@slop/onshape";
import { defaultPlanner } from "@slop/runner";
import { firebaseSupabaseAccounts, type Accounts } from "./accounts.ts";
import { createApp } from "./app.ts";
import { StudioClient } from "./onshape.ts";
import { Runs } from "./runs.ts";
import { Sources } from "./sources.ts";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT ?? "8788" },
    host: { type: "string", default: "127.0.0.1" },
  },
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
loadEnvFiles();

// .dev.vars is the Worker's secrets file; the runner reads it the same way.
function readDevVars(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(ROOT, ".dev.vars"), "utf8");
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
const supabaseSecretKey = env("SUPABASE_SECRET_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY");
const firebaseProjectId = env("FIREBASE_PROJECT_ID");
const accounts: Accounts | undefined =
  supabaseUrl && supabaseSecretKey && firebaseProjectId ? firebaseSupabaseAccounts({ supabaseUrl, supabaseSecretKey, firebaseProjectId }) : undefined;

let claude: { available: boolean; model?: string } = { available: false };
try {
  claude = { available: true, model: loadClaudeConfig().model };
} catch {
  /* rules planner only */
}

const authScheme = process.env.ONSHAPE_AUTH_SCHEME === "hmac" ? "hmac" : "basic";
const apiVersion = process.env.ONSHAPE_API_VERSION ?? "v10";
const connect = (cfg: ConstructorParameters<typeof StudioClient>[0]) => new StudioClient(cfg);

const sources = new Sources({
  samplesDir: join(ROOT, "packages", "ir", "fixtures"),
  extractor: {
    exe: process.env.SLOP_EXTRACTOR ?? join(ROOT, "extractors", "solidworks", "bin", "Release", "net48", "SlopExtractor.exe"),
    outDir: join(ROOT, "out", "studio"),
  },
});

const runs = new Runs({
  connect,
  planner: defaultPlanner(loadClaudeConfig, ClaudePlanner),
  authScheme,
  apiVersion,
  recordDir: join(ROOT, "out", "studio", "recordings"),
  log: (line) => console.log(line),
});

const app = createApp({ sources, runs, connect, authScheme, apiVersion, claude, ...(accounts ? { accounts } : {}) });
const port = Number(args.port);
const server = createServer(app);

server.listen(port, args.host, () => {
  console.log(`Slop studio server on http://${args.host === "0.0.0.0" ? "localhost" : args.host}:${port}`);
  if (args.host === "0.0.0.0") {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) console.log(`  on your network: http://${a.address}:${port}`);
    }
  }
  console.log(`  accounts: ${accounts ? `Firebase project ${firebaseProjectId}, Onshape keys from Supabase` : "not configured: migrations need SUPABASE_URL, SUPABASE_SECRET_KEY, FIREBASE_PROJECT_ID (.dev.vars)"}`);
  if (supabaseSecretKey?.startsWith("sb_publishable_")) console.log("  ! SUPABASE_SECRET_KEY is a publishable key; reading Onshape keys needs the secret key (sb_secret_…)");
  console.log(`  planner: ${claude.available ? `claude (${claude.model}) or rules` : "rules only (no ANTHROPIC_API_KEY)"}`);
  console.log(`  SolidWorks extractor: ${sources.extractorAvailable ? "ready" : "not available on this machine"}`);
  console.log(`  samples: ${sources.list().map((s) => s.name).join(", ") || "none"}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use. Is the studio server already running? (--port to pick another)` : err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nStopping.");
  process.exit(0);
});
