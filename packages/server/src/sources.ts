/**
 * Where a migration's IR comes from: the part open in SolidWorks (through the
 * extractor), a sample from packages/ir/fixtures, or an IR file the user
 * uploads. Every source is validated before it can be built.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { validateDocument, type Document } from "@slop/ir";

export interface SourceInfo {
  id: string;
  kind: "sample" | "solidworks" | "upload";
  name: string;
  fileName?: string;
  featureCount: number;
  /** Feature count per op, e.g. { sketch: 4, extrude: 2 }. */
  ops: Record<string, number>;
  /** Level 3 cases the extractor measured in SolidWorks. */
  behaviorCases: number;
  extractedAt?: string;
  /** From the extractor's report: tree nodes SolidWorks has that the IR does not carry. */
  notCarried?: Array<{ name: string; type?: string; status: string; reason?: string }>;
  warnings?: string[];
}

export interface Source {
  info: SourceInfo;
  ir: Document;
}

export class SourceError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface ExtractorConfig {
  /** SlopExtractor.exe */
  exe: string;
  /** Where extractions are written (one folder each). */
  outDir: string;
  timeoutMs?: number;
}

export class Sources {
  private readonly items = new Map<string, Source>();
  private extracting = false;

  constructor(private readonly opts: { samplesDir: string; extractor?: ExtractorConfig }) {
    this.loadSamples();
  }

  get extractorAvailable(): boolean {
    return !!this.opts.extractor && process.platform === "win32" && existsSync(this.opts.extractor.exe);
  }

  /** Samples first, then this session's extractions and uploads, newest first. */
  list(): SourceInfo[] {
    const all = [...this.items.values()].map((s) => s.info);
    return [...all.filter((s) => s.kind === "sample"), ...all.filter((s) => s.kind !== "sample").reverse()];
  }

  get(id: string): Source | undefined {
    return this.items.get(id);
  }

  addUpload(ir: unknown, fileName?: string): Source {
    const doc = checkIr(ir);
    return this.add({ kind: "upload", ir: doc, ...(fileName ? { fileName } : {}) });
  }

  /** Runs `SlopExtractor extract --active` against the SolidWorks session on this machine. */
  async extractActive(options: { behavior?: number } = {}): Promise<{ source: Source; log: string[] }> {
    const ex = this.opts.extractor;
    if (!ex || !this.extractorAvailable) {
      throw new SourceError("The SolidWorks extractor isn't available on this machine. Build it with `dotnet build extractors/solidworks -c Release` on the Windows machine that has SolidWorks.", 501);
    }
    if (this.extracting) throw new SourceError("Already reading a part from SolidWorks.", 409);
    this.extracting = true;
    try {
      const dir = join(ex.outDir, `extract-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(dir, { recursive: true });
      const args = ["extract", "--active", "--out", dir];
      if (options.behavior && options.behavior > 0) args.push("--behavior", String(Math.min(Math.floor(options.behavior), 20)));
      const { code, lines } = await run(ex.exe, args, ex.timeoutMs ?? 5 * 60_000);

      const irFile = newest(dir, ".ir.json");
      if (!irFile) {
        const reason = lines.filter((l) => /error/i.test(l)).at(-1) ?? lines.at(-1) ?? `extractor exited with code ${code}`;
        throw new SourceError(reason.replace(/^error:\s*/i, ""), 422, lines.slice(-20));
      }
      const doc = checkIr(JSON.parse(readFileSync(irFile, "utf8")));
      const reportFile = irFile.replace(/\.ir\.json$/, ".extract.json");
      const report = existsSync(reportFile) ? readReport(reportFile) : {};
      return { source: this.add({ kind: "solidworks", ir: doc, ...report }), log: lines };
    } finally {
      this.extracting = false;
    }
  }

  private loadSamples(): void {
    if (!existsSync(this.opts.samplesDir)) return;
    for (const file of readdirSync(this.opts.samplesDir).filter((f) => f.endsWith(".ir.json")).sort()) {
      try {
        const doc = checkIr(JSON.parse(readFileSync(join(this.opts.samplesDir, file), "utf8")));
        this.add({ kind: "sample", ir: doc, id: `sample:${file.replace(/\.ir\.json$/, "")}` });
      } catch (err) {
        console.warn(`sample ${file} skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private add(input: { kind: SourceInfo["kind"]; ir: Document; id?: string; fileName?: string; notCarried?: SourceInfo["notCarried"]; warnings?: string[] }): Source {
    const { ir } = input;
    const ops: Record<string, number> = {};
    for (const f of ir.partStudio.features) ops[f.op] = (ops[f.op] ?? 0) + 1;
    const info: SourceInfo = {
      id: input.id ?? `${input.kind}:${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      name: ir.partStudio.name,
      ...(ir.source.fileName || input.fileName ? { fileName: ir.source.fileName ?? input.fileName } : {}),
      featureCount: ir.partStudio.features.length,
      ops,
      behaviorCases: ir.behaviorEvidence?.length ?? 0,
      ...(ir.source.extractedAt ? { extractedAt: ir.source.extractedAt } : {}),
      ...(input.notCarried?.length ? { notCarried: input.notCarried } : {}),
      ...(input.warnings?.length ? { warnings: input.warnings } : {}),
    };
    const source = { info, ir };
    this.items.set(info.id, source);
    return source;
  }
}

/** Full IR validation (schema plus referential rules). */
export function checkIr(ir: unknown): Document {
  const result = validateDocument(ir);
  if (!result.ok) {
    const issues = [...result.schema, ...result.structure].slice(0, 20).map((i) => `${i.path}: ${i.message}`);
    throw new SourceError("That isn't a valid IR document.", 422, issues);
  }
  return ir as Document;
}

function readReport(file: string): { notCarried?: SourceInfo["notCarried"]; warnings?: string[] } {
  try {
    const report = JSON.parse(readFileSync(file, "utf8")) as {
      features?: Array<{ name: string; type?: string; status: string; reason?: string; notes?: string[] }>;
      warnings?: unknown[];
    };
    const notCarried = (report.features ?? [])
      .filter((f) => f.status === "unsupported" || f.status === "error")
      .map((f) => ({ name: f.name, ...(f.type ? { type: f.type } : {}), status: f.status, ...(f.reason || f.notes ? { reason: f.reason ?? f.notes!.join("; ") } : {}) }));
    const warnings = (report.warnings ?? []).map((w) => (typeof w === "string" ? w : JSON.stringify(w))).slice(0, 20);
    return { notCarried, warnings };
  } catch {
    return {};
  }
}

function newest(dir: string, suffix: string): string | undefined {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(suffix))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function run(exe: string, args: string[], timeoutMs: number): Promise<{ code: number | null; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    const lines: string[] = [];
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) lines.push(line.trimEnd());
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new SourceError(`SolidWorks didn't finish within ${Math.round(timeoutMs / 1000)} s.`, 504, lines.slice(-20)));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new SourceError(`Couldn't start ${basename(exe)}: ${err.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, lines });
    });
  });
}
