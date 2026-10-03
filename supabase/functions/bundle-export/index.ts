// bundle-export: zips the converted parts of an export once every conversion
// job has finished, or marks the export failed when any job failed.
//
// Called by the database (migration 0003, via pg_net) with either
//   { "export_id": "<uuid>" }
// or a database-webhook-style payload
//   { "type": "UPDATE", "table": "conversion_jobs" | "exports", "record": {...}, "old_record": {...} }
// Authenticated with the x-webhook-secret header (EXPORT_WEBHOOK_SECRET);
// JWT verification is off for this function (supabase/config.toml).
//
// Zip output: cad-derived/{project_id}/exports/{export_id}.zip

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { zipSync, type Zippable } from "fflate";

const DERIVED_BUCKET = "cad-derived";
const DOWNLOAD_CONCURRENCY = 6;
// Formats that are already compressed are stored as-is to save CPU time.
const STORED_EXTENSIONS = new Set(["3mf", "glb", "f3d", "zip"]);

type JobStatus = "queued" | "processing" | "succeeded" | "failed" | "canceled";

type ExportRecord = {
  id: string;
  project_id: string;
  status: JobStatus;
  target_format: string;
  format: { extension: string } | null;
};

type ExportItem = {
  path: string;
  job: { id: string; status: JobStatus; error: string | null; output_storage_path: string | null } | null;
};

type Outcome = { export_id: string; result: string };

// ---------------------------------------------------------------------------
// Zip layout. KEEP IDENTICAL to Slop-Frontend/src/lib/exports.ts
// (zipEntryName / assignZipEntryPaths, unit-tested there).
// ---------------------------------------------------------------------------

/** "chassis/rails/left.step" + "stl" -> "chassis/rails/left.stl". Adds the extension when there is none. */
export function zipEntryName(path: string, extension: string): string {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? "";
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  parts.push(`${stem}.${extension}`);
  return parts.join("/");
}

/**
 * Zip entry path for every item path. Names that collide after the extension
 * change (case-insensitively, for Windows/macOS) get " (2)", " (3)"... in
 * sorted path order, so the result is deterministic.
 */
export function assignZipEntryPaths(paths: readonly string[], extension: string): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const path of sorted) {
    const name = zipEntryName(path, extension);
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = `${name.slice(0, -(extension.length + 1))} (${n}).${extension}`;
    }
    taken.add(candidate.toLowerCase());
    result.set(path, candidate);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function markFailed(db: SupabaseClient, exportId: string, fromStatuses: JobStatus[], message: string) {
  const { error } = await db
    .from("exports")
    .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
    .eq("id", exportId)
    .in("status", fromStatuses);
  if (error) console.error(`bundle-export: marking ${exportId} failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Which exports does a payload concern?
// ---------------------------------------------------------------------------

type Payload = {
  export_id?: unknown;
  type?: unknown;
  table?: unknown;
  record?: { id?: unknown } | null;
};

async function exportIdsFor(db: SupabaseClient, payload: Payload): Promise<string[]> {
  if (typeof payload.export_id === "string") return [payload.export_id];
  const id = payload.record?.id;
  if (typeof id !== "string") return [];
  if (payload.table === "exports") return [id];
  if (payload.table === "conversion_jobs") {
    const { data, error } = await db
      .from("export_items")
      .select("export_id, exports!inner(status)")
      .eq("conversion_job_id", id)
      .eq("exports.status", "queued");
    if (error) throw new Error(`Finding exports for job ${id}: ${error.message}`);
    return [...new Set((data as { export_id: string }[]).map((r) => r.export_id))];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Process one export
// ---------------------------------------------------------------------------

async function processExport(db: SupabaseClient, exportId: string): Promise<string> {
  const { data: exp, error: expError } = await db
    .from("exports")
    .select("id, project_id, status, target_format, format:target_formats(extension)")
    .eq("id", exportId)
    .maybeSingle<ExportRecord>();
  if (expError) throw new Error(`Loading export: ${expError.message}`);
  if (!exp) return "not found";
  // 'processing' means another invocation is bundling it right now.
  if (exp.status !== "queued") return `skipped (${exp.status})`;

  const { data: itemRows, error: itemsError } = await db
    .from("export_items")
    .select("path, job:conversion_jobs(id, status, error, output_storage_path)")
    .eq("export_id", exportId);
  if (itemsError) throw new Error(`Loading export items: ${itemsError.message}`);
  const items = (itemRows ?? []) as unknown as ExportItem[];
  if (items.length === 0) {
    await markFailed(db, exportId, ["queued"], "The export has no parts.");
    return "failed (empty)";
  }

  const failed = items.filter((i) => !i.job || i.job.status === "failed" || i.job.status === "canceled");
  if (failed.length > 0) {
    const lines = failed
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((i) => `${i.path}: ${i.job?.error ?? (i.job ? i.job.status : "conversion job missing")}`);
    const noun = items.length === 1 ? "part" : "parts";
    await markFailed(db, exportId, ["queued"], `${failed.length} of ${items.length} ${noun} failed to convert.\n${lines.join("\n")}`);
    return "failed (conversion)";
  }

  if (!items.every((i) => i.job?.status === "succeeded")) return "waiting";

  // Claim the export so concurrent invocations don't bundle it twice.
  const { data: claimed, error: claimError } = await db
    .from("exports")
    .update({ status: "processing" })
    .eq("id", exportId)
    .eq("status", "queued")
    .select("id");
  if (claimError) throw new Error(`Claiming export: ${claimError.message}`);
  if (!claimed || claimed.length === 0) return "claimed elsewhere";

  try {
    const extension = exp.format?.extension ?? exp.target_format;
    const entryPaths = assignZipEntryPaths(items.map((i) => i.path), extension);
    const level = STORED_EXTENSIONS.has(extension.toLowerCase()) ? 0 : 1;

    const files = await mapLimit(items, DOWNLOAD_CONCURRENCY, async (item) => {
      const source = item.job?.output_storage_path;
      if (!source) throw new Error(`${item.path}: conversion output is missing`);
      const { data, error } = await db.storage.from(DERIVED_BUCKET).download(source);
      if (error) throw new Error(`${item.path}: downloading ${source} failed: ${error.message}`);
      return { name: entryPaths.get(item.path)!, bytes: new Uint8Array(await data.arrayBuffer()) };
    });

    const zippable: Zippable = {};
    for (const f of files) zippable[f.name] = [f.bytes, { level }];
    const zip = zipSync(zippable);

    const outputPath = `${exp.project_id}/exports/${exportId}.zip`;
    const { error: uploadError } = await db.storage
      .from(DERIVED_BUCKET)
      .upload(outputPath, zip, { upsert: true, contentType: "application/zip" });
    if (uploadError) throw new Error(`Uploading zip: ${uploadError.message}`);

    const { error: doneError } = await db
      .from("exports")
      .update({ status: "succeeded", output_storage_path: outputPath, error: null, finished_at: new Date().toISOString() })
      .eq("id", exportId)
      .eq("status", "processing");
    if (doneError) throw new Error(`Finishing export: ${doneError.message}`);
    return `succeeded (${files.length} files, ${zip.byteLength} bytes)`;
  } catch (e) {
    await markFailed(db, exportId, ["processing"], `Bundling failed: ${errorText(e)}`);
    return `failed (${errorText(e)})`;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const secret = Deno.env.get("EXPORT_WEBHOOK_SECRET");
  if (!secret) return json({ error: "EXPORT_WEBHOOK_SECRET is not configured" }, 500);
  if (!timingSafeEqual(req.headers.get("x-webhook-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL");
  // Supabase injects the service role key; newer projects call it the secret key.
  const key = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Supabase credentials are not configured" }, 500);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let ids: string[];
  try {
    ids = await exportIdsFor(db, payload);
  } catch (e) {
    console.error(`bundle-export: ${errorText(e)}`);
    return json({ error: errorText(e) }, 500);
  }

  const outcomes: Outcome[] = [];
  for (const id of ids) {
    try {
      outcomes.push({ export_id: id, result: await processExport(db, id) });
    } catch (e) {
      // Infrastructure errors before bundling started: fail the export so it
      // doesn't hang in 'queued' forever.
      await markFailed(db, id, ["queued"], errorText(e));
      outcomes.push({ export_id: id, result: `error (${errorText(e)})` });
    }
  }
  console.log(`bundle-export: ${JSON.stringify(outcomes)}`);
  return json({ processed: outcomes });
});
