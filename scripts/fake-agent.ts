// Fake SOLIDWORKS agent for development. Speaks the agent protocol
// (src/agents.ts) against a Worker but answers every extraction with an IR
// file instead of reading SOLIDWORKS, so request -> extraction -> build ->
// runner can be exercised on any OS.
//
//   npm run fake-agent -- --token slop_agent_... [--server http://localhost:8787]
//                         [--ir packages/ir/fixtures/plate.ir.json] [--fail] [--once]
//
// Get a token by pairing: POST /api/agents with a Firebase ID token.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    token: { type: "string" },
    server: { type: "string", default: "http://localhost:8787" },
    ir: { type: "string", default: "packages/ir/fixtures/plate.ir.json" },
    fail: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
  },
});

const token = args.token ?? process.env.SLOP_AGENT_TOKEN;
if (!token) {
  console.error("Give --token slop_agent_... (or set SLOP_AGENT_TOKEN). Pair with POST /api/agents to get one.");
  process.exit(1);
}
const server = args.server!.replace(/\/+$/, "");
const irPath = resolve(args.ir!);
const ir: unknown = JSON.parse(readFileSync(irPath, "utf8"));
const part = basename(irPath).replace(/\.ir\.json$/, ".SLDPRT");

type Job = { id: string; target: { kind: string; path?: string }; behavior: number };

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${server}/api/agent${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`.trim());
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping…");
});

const status = {
  version: "fake-agent",
  solidworks: { running: true, release: "fake", activeDocument: part, documents: [{ title: part, path: `C:\\fake\\${part}` }] },
};

async function extract(job: Job): Promise<void> {
  const what = job.target.kind === "path" ? job.target.path : `the active document (${part})`;
  console.log(`→ extraction ${job.id}: ${what}, behaviour ${job.behavior}`);
  for (const line of ["opening the part", "reading the feature tree", "recording evidence"]) {
    const { status: s } = await call<{ status: string }>(`/extractions/${job.id}/progress`, { line });
    if (s !== "processing") {
      console.log(`  stopped: extraction is ${s}`);
      return;
    }
    await sleep(300);
  }
  if (args.fail) {
    await call(`/extractions/${job.id}/fail`, { error: "fake failure (--fail)" });
    console.log("  ✗ reported a failure (--fail)");
    return;
  }
  const { buildId } = await call<{ buildId: string }>(`/extractions/${job.id}/result`, { ir, report: { fake: true, source: irPath } });
  console.log(`  ✓ IR posted; build ${buildId} queued`);
}

async function main() {
  console.log(`fake agent → ${server}, answering with ${irPath}. Ctrl-C to stop.`);
  while (!stopping) {
    let reply: { pollMs: number; job: Job | null };
    try {
      reply = await call("/poll", status);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      if (e instanceof Error && e.message.includes(" 401")) process.exit(1);
      await sleep(5000);
      continue;
    }
    if (reply.job) {
      try {
        await extract(reply.job);
      } catch (e) {
        console.error(`  ! ${e instanceof Error ? e.message : e}`);
      }
      if (args.once) break;
      continue;
    }
    await sleep(reply.pollMs);
  }
  console.log("Stopped.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
