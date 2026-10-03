import type { BuildReport } from "./builder.ts";

/** Human-readable migration report (architecture doc §7 / §9). */
export function renderMarkdown(r: BuildReport): string {
  const lines: string[] = [];
  const { did, wid, eid } = r.document;
  lines.push(`# Migration report`);
  lines.push(``);
  lines.push(`- Document: https://cad.onshape.com/documents/${did}/w/${wid}/e/${eid}`);
  lines.push(`- IR intent hash: \`${r.irIntentHash}\``);
  lines.push(`- Planner: ${r.plan.provenance.planner}${r.plan.provenance.model ? ` (${r.plan.provenance.model})` : ""}`);
  lines.push(`- Features: ${r.summary.built} built, ${r.summary.failed} failed, ${r.summary.skipped} skipped${r.stoppedEarly ? " (stopped early on divergence)" : ""}`);
  lines.push(`- Fidelity: ${Object.entries(r.summary.byRung).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  lines.push(`- Checks: ${r.summary.checksPassed} passed, ${r.summary.checksFailed} failed`);
  lines.push(`- Enhancements (implied intent the source never encoded): ${r.summary.enhancements}`);
  lines.push(`- Onshape API calls: ${r.apiCalls}`);
  if (r.summary.llmCalls) lines.push(`- LLM: ${r.summary.llmCalls} calls, ${r.summary.inputTokens} in / ${r.summary.outputTokens} out`);
  lines.push(``);
  lines.push(`| # | Feature | Op | Rung | Status | Attempts | Onshape id | Checks |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  r.features.forEach((f, i) => {
    const checks = f.checks.length ? `${f.checks.filter((c) => c.pass).length}/${f.checks.length}` : "";
    lines.push(`| ${i + 1} | ${f.srcName} | ${f.op} | ${f.rung} | ${f.status}${f.featureStatus ? ` (${f.featureStatus})` : ""} | ${f.attempts} | ${f.onshapeFeatureId ?? ""} | ${checks} |`);
  });

  for (const f of r.features) {
    if (!f.refs.length && !f.notes.length && !f.error && !f.reasoning && !f.enhancements.length && !f.checks.some((c) => !c.pass)) continue;
    lines.push(``);
    lines.push(`## ${f.srcName}`);
    if (f.reasoning) lines.push(`- Intent: ${f.reasoning}`);
    if (f.error) lines.push(`- Error: ${f.error}`);
    for (const e of f.enhancements) lines.push(`- Enhancement: ${e}`);
    for (const n of f.notes) lines.push(`- Note: ${n}`);
    for (const ref of f.refs) {
      const conf = ref.confidence < 1 ? ` (confidence ${ref.confidence.toFixed(3)}${ref.runnerUp !== undefined ? `, runner-up ${ref.runnerUp.toFixed(3)}` : ""})` : "";
      lines.push(`- Ref \`${ref.opId}.${ref.parameterId}\`: ${JSON.stringify(ref.selection)} -> ${ref.deterministicIds.join(", ")} via ${ref.resolver}${conf}`);
    }
    for (const c of f.checks) {
      if (c.pass) continue;
      lines.push(`- ${c.advisory ? "Advisory" : "FAILED"} ${c.name}: expected ${c.expected}, got ${c.actual}${c.error !== undefined ? ` (error ${c.error.toExponential(2)})` : ""}`);
    }
    if (f.attemptLog.length > 1) {
      lines.push(`- Retries:`);
      for (const a of f.attemptLog) lines.push(`  - attempt ${a.n}: ${a.summary}`);
    }
  }

  if (r.plan.behaviorTests.length) {
    lines.push(``);
    lines.push(`## Behaviour tests (proposed)`);
    for (const t of r.plan.behaviorTests) lines.push(`- ${t.target} → \`${t.expression}\`: ${t.expectation}`);
  }
  return lines.join("\n") + "\n";
}
