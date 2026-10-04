import type { Document, Feature } from "@slop/ir";
import { proposeDirect, ProposalError } from "../proposers/index.ts";
import { stepProposalSchema } from "../plan/schema.ts";
import type { BehaviorTest, PlanStep } from "../plan/types.ts";
import { validateStepProposal } from "../plan/validate.ts";
import type { Feedback, LlmUsage, Planner, StepProposal, StepRequest } from "./types.ts";

export const CLAUDE_PROMPT_VERSION = "0.1.1";

export interface ClaudeConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

const SYSTEM = `You are the SolidWorks-to-Onshape translator. You decide how each source feature is rebuilt; Onshape only executes what you write.

You emit typed build-plan operations (never Onshape wire JSON). Every op needs:
- id (plan-unique; later ops refer to it)
- intent (one sentence a reviewer can read)
- rung: exact | composite | featurescript | approximated | geometry | dropped
- enhancement: true only if you add intent the source never encoded

Selections:
- {kind:"datum", name:"FRONT"|"TOP"|"RIGHT"}
- {kind:"origin"}
- {kind:"sketchRegion", sketch:"<plan op id>"}
- {kind:"irRef", irFeature:"f3", path:"plane"}  — resolver cascade; fails if candidates tie
- {kind:"createdBy", feature:"<plan op id>", entity:"face"|"edge"|"vertex", where?:{type,normal,offset,radius,near}}
- {kind:"entities", ids:["..."]}  — explicit pick after a tie or from list_topology
- {kind:"sketchEntity", sketch:"<plan op id>", entity:"l1"}  — a sketch line/arc/point as a selection (revolve axis, pattern direction, hole centre)
- {kind:"features", features:["<plan op id>", ...]}  — whole features as pattern or mirror seeds

Sketch constraint and dimension args:
- "l1", "l1.start", "c1.center", "ORIGIN"  — entities of this sketch
- an IR Ref object (copy it from the IR)  — model geometry, resolved live; keeps the sketch at rung exact
- "ext:<deterministicId>"  — explicit pick of a model entity after a tie, using an id from feedback

Rules you must follow:
- Never invent a dimension or expression. Use the IR values.
- Prefer live references (sketch regions, createdBy, irRef) over coordinates.
- Tag implied intent (centering, equal-by-habit) as enhancement:true.
- If a selection ties, call list_topology and resubmit with {kind:"entities", ids:[...]}.
- You may call propose_direct for a starting plan, then edit or ignore it.
- Measurements, not you, decide pass/fail. If feedback says volume is wrong, change the ops.

Call submit_step when the ops for THIS feature are ready.`;

type Content = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string };

interface Message {
  role: "user" | "assistant";
  content: string | Content[];
}

/**
 * Claude via the Messages API, as a tool-using agent (architecture doc §11).
 * Needs ANTHROPIC_API_KEY in packages/onshape/.env. Structured output is
 * enforced by the submit_step tool schema plus validateStepProposal().
 */
export class ClaudePlanner implements Planner {
  readonly provenance;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly url: string;
  private totals: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  private current: StepRequest | undefined;
  private history: Message[] = [];
  /** The submit_step tool_use the last proposal came from; feedback must answer it as a tool_result. */
  private lastSubmitId: string | undefined;

  constructor(private readonly cfg: ClaudeConfig) {
    if (!cfg.apiKey) {
      throw new Error("missing ANTHROPIC_API_KEY. Copy packages/onshape/.env.example to packages/onshape/.env and fill it in.");
    }
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.model = cfg.model ?? "claude-opus-5-5";
    this.url = `${(cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
    this.provenance = { planner: "claude" as const, model: this.model, promptVersion: CLAUDE_PROMPT_VERSION };
  }

  async proposeStep(req: StepRequest): Promise<StepProposal> {
    this.current = req;
    this.history = [{ role: "user", content: describeFeature(req) }];
    return this.turn();
  }

  async reviseStep(req: StepRequest, _previous: StepProposal, feedback: Feedback): Promise<StepProposal | undefined> {
    this.current = req;
    // The previous proposal was a submit_step tool call; the Messages API requires the next
    // user message to answer it with a tool_result (verified live: a plain message is a 400).
    const text = describeFeedback(feedback);
    if (this.lastSubmitId) {
      this.history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: this.lastSubmitId, content: text }] });
      this.lastSubmitId = undefined;
    } else {
      this.history.push({ role: "user", content: text });
    }
    return this.turn();
  }

  async proposeBehaviorTests(ir: Document, _steps: PlanStep[]): Promise<BehaviorTest[]> {
    this.current = undefined;
    this.history = [
      {
        role: "user",
        content:
          `The part is built. Propose up to 10 Level 3 behaviour tests: driving dimensions to perturb and what must still hold.\n` +
          `Each test changes exactly ONE dimension: target is a single dimension id from the list below (never a list, never "all"), expression is its new value like "60 mm".\n` +
          `Driving dimensions:\n${drivingDimensions(ir).join("\n")}\n` +
          `Reply by calling submit_behavior_tests.`,
      },
    ];
    const tests = await this.turnForTests();
    return tests.slice(0, 10);
  }

  usage(): LlmUsage {
    return { ...this.totals };
  }

  private tools() {
    return [
      {
        name: "submit_step",
        description: "Hand back the operations for the current source feature.",
        input_schema: stepProposalSchema,
      },
      {
        name: "propose_direct",
        description: "Return the cached direct-mapping plan for the current IR feature, if one exists. You may edit or ignore it.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_topology",
        description: "List faces or edges created by a plan op already built in this document.",
        input_schema: {
          type: "object",
          required: ["opId", "entity"],
          properties: { opId: { type: "string" }, entity: { enum: ["face", "edge", "vertex"] } },
        },
      },
      {
        name: "submit_behavior_tests",
        description: "Hand back Level 3 perturbation tests for the finished part.",
        input_schema: {
          type: "object",
          required: ["tests"],
          properties: {
            tests: {
              type: "array",
              items: {
                type: "object",
                required: ["target", "expression", "expectation"],
                properties: { target: { type: "string" }, expression: { type: "string" }, expectation: { type: "string" } },
              },
            },
          },
        },
      },
    ];
  }

  private async turn(): Promise<StepProposal> {
    for (let i = 0; i < 12; i++) {
      const data = await this.call(this.history);
      this.history.push({ role: "assistant", content: data.content });
      const submitted = data.content.find((c) => c.type === "tool_use" && c.name === "submit_step");
      if (submitted && submitted.type === "tool_use") {
        // Any other tool calls in the same turn are answered now; submit_step itself is answered
        // by the executor's feedback (reviseStep) or never, if the step is accepted.
        const others: Content[] = [];
        for (const c of data.content) {
          if (c.type !== "tool_use" || c.id === submitted.id) continue;
          others.push({ type: "tool_result", tool_use_id: c.id, content: await this.runTool(c.name, c.input) });
        }
        if (others.length) this.history.push({ role: "user", content: others });
        this.lastSubmitId = submitted.id;
        return validateStepProposal(submitted.input);
      }
      const results: Content[] = [];
      for (const c of data.content) {
        if (c.type !== "tool_use") continue;
        results.push({ type: "tool_result", tool_use_id: c.id, content: await this.runTool(c.name, c.input) });
      }
      if (results.length === 0) throw new Error("Claude returned no submit_step and no tool calls");
      this.history.push({ role: "user", content: results });
    }
    throw new Error("Claude exceeded the tool-call budget without submit_step");
  }

  private async turnForTests(): Promise<BehaviorTest[]> {
    for (let i = 0; i < 6; i++) {
      const data = await this.call(this.history);
      this.history.push({ role: "assistant", content: data.content });
      const submitted = data.content.find((c) => c.type === "tool_use" && c.name === "submit_behavior_tests");
      if (submitted && submitted.type === "tool_use") {
        const tests = (submitted.input as { tests?: BehaviorTest[] }).tests;
        if (!Array.isArray(tests)) throw new Error("submit_behavior_tests returned no tests");
        return tests;
      }
      const results: Content[] = [];
      for (const c of data.content) {
        if (c.type !== "tool_use") continue;
        results.push({ type: "tool_result", tool_use_id: c.id, content: await this.runTool(c.name, c.input) });
      }
      if (results.length === 0) return [];
      this.history.push({ role: "user", content: results });
    }
    return [];
  }

  private async runTool(name: string, input: unknown): Promise<string> {
    const req = this.current;
    if (name === "propose_direct") {
      if (!req) return JSON.stringify({ error: "no current feature" });
      try {
        const ops = proposeDirect(req.feature, req.context, new Map(req.ir.parameters.map((p) => [p.id, p])));
        return JSON.stringify({ ops });
      } catch (err) {
        return JSON.stringify({ error: err instanceof ProposalError || err instanceof Error ? err.message : String(err) });
      }
    }
    if (name === "list_topology") {
      if (!req) return JSON.stringify({ error: "no current feature" });
      const { opId, entity } = input as { opId: string; entity: "face" | "edge" | "vertex" };
      try {
        const list = await req.context.listTopology(opId, entity);
        return JSON.stringify(
          list.map((c) => ({
            id: c.id,
            type: c.type,
            origin: c.origin,
            normal: c.normal,
            center: c.center,
            radius: c.radius,
            midpoint: c.midpoint,
          })),
        );
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  }

  private async call(messages: Message[]): Promise<{ content: Content[] }> {
    this.totals.calls++;
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        system: SYSTEM,
        tools: this.tools(),
        messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = (await res.json()) as {
      content: Content[];
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    this.totals.inputTokens += body.usage?.input_tokens ?? 0;
    this.totals.outputTokens += body.usage?.output_tokens ?? 0;
    this.totals.cacheReadTokens = (this.totals.cacheReadTokens ?? 0) + (body.usage?.cache_read_input_tokens ?? 0);
    return { content: body.content ?? [] };
  }
}

function describeFeature(req: StepRequest): string {
  const f = req.feature;
  const prior = req.priorSteps.map((s) => `${s.irFeature}: ${s.ops.map((o) => `${o.op} ${o.id}`).join(", ")}`).join("\n") || "(none)";
  return (
    `Translate source feature ${req.index + 1}/${req.ir.partStudio.features.length}: ${f.src.name} (${f.op}, id ${f.id}).\n` +
    `Already built:\n${prior}\n\n` +
    `IR feature JSON:\n${JSON.stringify(stripEvidence(f), null, 2)}\n\n` +
    `Global parameters:\n${JSON.stringify(req.ir.parameters, null, 2)}`
  );
}

function describeFeedback(fb: Feedback): string {
  const lines = [`The last attempt failed. Measurements, not you, decide this.`, fb.summary];
  if (fb.errors.length) lines.push(`Errors:\n${fb.errors.join("\n")}`);
  if (fb.ambiguous) {
    lines.push(
      `Ambiguous selection on op ${fb.ambiguous.opId} for ${JSON.stringify(fb.ambiguous.selection)}. Candidates (pick with {kind:"entities", ids:[...]}, or "ext:<id>" when the selection is a sketch constraint or dimension argument):\n` +
        JSON.stringify(fb.ambiguous.candidates.map((c) => ({ id: c.candidate.id, type: c.candidate.type, score: c.score, center: c.candidate.center, midpoint: c.candidate.midpoint }))),
    );
  }
  if (fb.checks.length) lines.push(`Checks:\n${JSON.stringify(fb.checks)}`);
  lines.push("Revise the operations and call submit_step again.");
  return lines.join("\n\n");
}

function stripEvidence(f: Feature): unknown {
  const { evidence: _e, ...rest } = f;
  return rest;
}

function drivingDimensions(ir: Document): string[] {
  const out: string[] = [];
  for (const f of ir.partStudio.features) {
    if (f.op !== "sketch") continue;
    for (const d of f.dimensions) {
      if (d.driving) out.push(`${d.id} = ${d.value.expr} (${d.value.value} ${d.value.unit})`);
    }
  }
  return out;
}
