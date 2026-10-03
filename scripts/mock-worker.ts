// Mock conversion worker for local development. Claims queued conversion
// jobs and "converts" them by copying the source STEP unchanged to the
// derived output path, so the export flow can be exercised end to end.
//
//   npm run mock-worker -- [--fail-rate 0.1] [--delay 1000] [--once]
//
// Uses SUPABASE_URL + SUPABASE_SECRET_KEY (service role) from the
// environment, falling back to .dev.vars.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const WORKER_ID = "mock-worker";
const IDLE_POLL_MS = 2_000;
const SOURCE_BUCKET = "cad-source";
const DERIVED_BUCKET = "cad-derived";

type Job = {
  id: string;
  project_id: string;
  blob_id: string;
  target_format: string;
  attempts: number;
};
type Format = { code: string; extension: string };
type BlobRow = { sha256: string; storage_path: string };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readDevVars(): Record<string, string> {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars");
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
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

const devVars = readDevVars();
const env = (name: string) => process.env[name] || devVars[name] || undefined;

const url = env("SUPABASE_URL");
const key = env("SUPABASE_SECRET_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SECRET_KEY (set them in the environment or .dev.vars).");
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    "fail-rate": { type: "string", default: "0" },
    delay: { type: "string", default: "500" },
    once: { type: "boolean", default: false },
  },
});
const failRate = Number(args["fail-rate"]);
const delayMs = Number(args.delay);
if (!(failRate >= 0 && failRate <= 1)) {
  console.error("--fail-rate must be between 0 and 1");
  process.exit(1);
}
if (!(delayMs >= 0)) {
  console.error("--delay must be a non-negative number of milliseconds");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------------------
// Shutdown: first Ctrl-C finishes the current job, second requeues it and exits.
// ---------------------------------------------------------------------------

let stopping = false;
let current: Job | null = null;
let wake: (() => void) | null = null;

process.on("SIGINT", () => {
  if (!stopping) {
    stopping = true;
    console.log(current ? "\nStopping after the current job (Ctrl-C again to abort it)…" : "\nStopping…");
    wake?.();
    return;
  }
  const job = current;
  if (!job) process.exit(130);
  console.log(`\nRequeueing ${job.id} and exiting.`);
  void supabase
    .from("conversion_jobs")
    .update({ status: "queued", started_at: null, worker_id: null })
    .eq("id", job.id)
    .eq("status", "processing")
    .then(() => process.exit(130));
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
    wake = done;
  });
}

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

async function loadFormats(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("target_formats").select("code, extension").eq("enabled", true);
  if (error) throw new Error(`Loading target formats: ${error.message}`);
  const rows: Format[] = data;
  return new Map(rows.map((f) => [f.code, f.extension]));
}

async function claim(formats: string[]): Promise<Job | null> {
  const { data, error } = await supabase.rpc("claim_conversion_job", { p_formats: formats, p_worker_id: WORKER_ID });
  if (error) throw new Error(`claim_conversion_job: ${error.message}`);
  const rows: Job[] = data ?? [];
  return rows[0] ?? null;
}

async function convert(job: Job, extension: string): Promise<{ path: string; size: number }> {
  const { data: blobData, error: blobError } = await supabase
    .from("file_blobs")
    .select("sha256, storage_path")
    .eq("id", job.blob_id)
    .single();
  if (blobError) throw new Error(`Loading blob ${job.blob_id}: ${blobError.message}`);
  const blob: BlobRow = blobData;

  const { data: source, error: downloadError } = await supabase.storage.from(SOURCE_BUCKET).download(blob.storage_path);
  if (downloadError) throw new Error(`Downloading ${blob.storage_path}: ${downloadError.message}`);

  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  if (Math.random() < failRate) throw new Error("Simulated conversion failure (mock worker --fail-rate)");

  const bytes = new Uint8Array(await source.arrayBuffer());
  const path = `${job.project_id}/${blob.sha256}/${job.target_format}.${extension}`;
  const { error: uploadError } = await supabase.storage
    .from(DERIVED_BUCKET)
    .upload(path, bytes, { upsert: true, contentType: "application/octet-stream" });
  if (uploadError) throw new Error(`Uploading ${path}: ${uploadError.message}`);
  return { path, size: bytes.byteLength };
}

async function finish(job: Job, patch: Record<string, unknown>) {
  const { error } = await supabase
    .from("conversion_jobs")
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq("id", job.id);
  if (error) console.error(`  ! couldn't update job ${job.id}: ${error.message}`);
}

async function processJob(job: Job, formats: Map<string, string>) {
  const started = Date.now();
  console.log(`→ ${job.id} ${job.target_format} (attempt ${job.attempts})`);
  try {
    const extension = formats.get(job.target_format);
    if (!extension) throw new Error(`Unknown or disabled format ${job.target_format}`);
    const output = await convert(job, extension);
    await finish(job, {
      status: "succeeded",
      output_storage_path: output.path,
      output_size_bytes: output.size,
      error: null,
    });
    console.log(`  ✓ ${output.path} (${output.size} bytes, ${Date.now() - started} ms)`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finish(job, { status: "failed", error: message });
    console.log(`  ✗ ${message}`);
  }
}

async function main() {
  let formats = await loadFormats();
  let formatsLoadedAt = Date.now();
  console.log(`${WORKER_ID}: claiming ${[...formats.keys()].join(", ")}; fail rate ${failRate}, delay ${delayMs} ms. Ctrl-C to stop.`);

  while (!stopping) {
    if (Date.now() - formatsLoadedAt > 60_000) {
      formats = await loadFormats();
      formatsLoadedAt = Date.now();
    }

    let job: Job | null;
    try {
      job = await claim([...formats.keys()]);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      await sleep(IDLE_POLL_MS);
      continue;
    }

    if (!job) {
      if (args.once) break;
      await sleep(IDLE_POLL_MS);
      continue;
    }

    current = job;
    await processJob(job, formats);
    current = null;
  }
  console.log("Stopped.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
