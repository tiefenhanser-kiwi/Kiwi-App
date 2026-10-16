// CAT-Q1 Part C — plan the patches. READ-ONLY on data (findMany / findFirst
// only); writes files under out/<mode>/ and spends on the model.
//
//   node --env-file=.env --import tsx scripts/_scratch/cat-q1/plan.ts --set pilot|rest [--ids a,b] [--limit N] [--batch] --ceiling <usd>
//
// Per meal, in this order:
//   1. Part B's deterministic edits, applied IN MEMORY (the editor sees the
//      meal as it will be after B; the patch carries B's edits first, and
//      apply treats them as idempotent, so B may be applied before or not).
//   2. The issues: every block and fix issue from catq0-full.csv, verbatim —
//      except a sous vide doneness block the FSIS table check passes, which
//      goes to the editor as a fix with the ruling's one-sentence fix, and one
//      it fails, which is HELD (not sent; listed for Hans).
//   3. The editor call → the code limits (limits.ts) → reject or Edits.
//   4. Pass 1 on the patched meal; the CAT-Q0 rubric on the patched meal and
//      (when CAT-Q0 never reviewed this exact payload) on the unpatched one as
//      the baseline → the gate (gate.ts).
//   5. out/<mode>/patches/<mealId>.json (status accepted | rejected | declined |
//      b-only | clean) and one out/<mode>/diff-<set>.txt, old → new per edit.
//
// --batch runs each model stage as a Message Batch and waits for it (one
// command). Production: a fresh PowerShell window with DATABASE_URL and
// KIWI_PRODUCTION_HOST in the shell (see ../cat-q0/fingerprint.ts).
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { lookupIngredientsByName } from "../../../src/lib/ingredientLookup";
import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog, type CatMeal } from "../cat-q0/catalogDb";
import { buildVocab } from "../cat-q0/checks";
import { requestFor, RUBRIC_SHA, TOOL_NAME, userMessage, type ReviewIssue, type ReviewOutput } from "../cat-q0/rubric";
import { requestKey } from "../cat-q0/reviewRunner";
import { q0Review, runCalls, spentSoFar, type CallJob, type CallRecord } from "./caller";
import { patchMeal, type Edit, type IngRow } from "./edits";
import { EDIT_TOOL, editorIssues, editorPayload, editorRequest, editorUserMessage, EDITOR_SHA, type PatchInput } from "./editor";
import { pass1New, reviewGate } from "./gate";
import { OUT, pilotIds, readIssues, restIds, type Q0Issue } from "./issues";
import { checkPatch, issueDishes } from "./limits";
import { partBEdits } from "./partB";
import { checkSousVide, type SousVideCheck } from "./sousVide";
import { callKey } from "./caller";

const has = (k: string) => process.argv.includes(k);
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SET = arg("--set", "");
const CEILING = Number(arg("--ceiling", "0"));
const LIMIT = Number(arg("--limit", "0"));
const BATCH = has("--batch");
if (!["pilot", "rest"].includes(SET)) throw new Error("--set pilot|rest");
if (!(CEILING > 0)) throw new Error("--ceiling <usd> (this run's AI spend bound)");

const t0 = Date.now();
const { host, mode } = assertScriptDatabase("cat-q1/plan");
const DIR = join(OUT, mode);
mkdirSync(join(DIR, "patches"), { recursive: true });
const lines: string[] = [];
const say = (s = "") => { console.log(s); lines.push(s); };
say(`database: ${host} (${mode}) · set ${SET} · editor ${EDITOR_SHA} · rubric ${RUBRIC_SHA} · ${BATCH ? "batch" : "live"} · ceiling $${CEILING}`);

// ── reads ───────────────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const catalog = await loadCatalog(prisma);
const vocab = buildVocab(catalog);
const byId = new Map(catalog.map((m) => [m.id, m]));
const allIssues = readIssues();
let ids = has("--ids") ? arg("--ids", "").split(",") : SET === "pilot" ? pilotIds(allIssues) : restIds(allIssues);
const missing = ids.filter((id) => !byId.has(id));
ids = ids.filter((id) => byId.has(id));
if (LIMIT > 0) ids = ids.slice(0, LIMIT);
say(`catalog ${catalog.length} meals · set ${SET}: ${ids.length} on this database${missing.length ? ` · not here: ${missing.join(", ")}` : ""}`);

// ── 1–2. B in memory, the issues ────────────────────────────────────────────
interface Work {
  meal: CatMeal; postB: CatMeal; bEdits: Edit[]; issues: Q0Issue[]; sent: Q0Issue[];
  held: Array<{ n: number; why: string }>; sousVide: Array<SousVideCheck & { dish: string }>;
  payload?: ReturnType<typeof editorPayload>; editorJob?: CallJob;
}
const work: Work[] = [];
for (const id of ids) {
  const meal = byId.get(id)!;
  const b = partBEdits(meal);
  const postB = patchMeal(meal, b.edits);
  const issues = allIssues.get(id) ?? [];
  const overrides = new Map<number, { severity: string; fix: string; ruling: string }>();
  const held: Work["held"] = [];
  const sousVide: Work["sousVide"] = [];
  for (const d of postB.dishes) { const c = checkSousVide(d); if (c) sousVide.push({ ...c, dish: d.title }); }
  for (const i of issues) {
    if (i.class !== 5 || i.severity !== "block") continue;
    const sv = issueDishes(postB, i).map((d) => ({ d, c: checkSousVide(d) })).find((x) => x.c);
    if (!sv?.c) continue;
    if (sv.c.meets) {
      overrides.set(i.n, {
        severity: "fix",
        fix: `Add ONE sentence to the bath step (step ${sv.c.steps.join("/")}) saying that holding the ${sv.c.protein === "poultry" ? "chicken" : "meat"} at ${sv.c.bathF}°F for the full time stated is what makes it safe to eat. Change nothing else about its doneness.`,
        ruling: `D-WS9-315 sous vide: ${sv.c.bathF}°F held ${sv.c.holdMinutes} min meets the FSIS table (${sv.c.tableMinutes} min at core temperature) — a fix, not a block`,
      });
    } else held.push({ n: i.n, why: `sous vide ${sv.c.bathF}°F held ${sv.c.holdMinutes} min does NOT meet the FSIS table (${sv.c.tableMinutes ?? "below the table"} min) — held for Hans, not sent to the editor` });
  }
  const sent = issues.filter((i) => !held.some((h) => h.n === i.n));
  const w: Work = { meal, postB, bEdits: b.edits, issues, sent, held, sousVide };
  if (sent.length) {
    w.payload = editorPayload(postB, editorIssues(sent, overrides));
    w.editorJob = { label: "editor", mealId: id, tool: EDIT_TOOL, request: editorRequest(editorUserMessage(w.payload.json), 4096, BATCH) };
  }
  work.push(w);
}
say(`B in memory: ${work.reduce((a, w) => a + w.bEdits.length, 0)} edits in ${work.filter((w) => w.bEdits.length).length} meals · editor calls ${work.filter((w) => w.editorJob).length} · held issues ${work.reduce((a, w) => a + w.held.length, 0)}`);

// ── 3. the editor ───────────────────────────────────────────────────────────
const startSpend = spentSoFar();
const left = () => CEILING - (spentSoFar() - startSpend);
const edRecs = await runCalls(work.filter((w) => w.editorJob).map((w) => w.editorJob!), { ceilingUsd: left(), batch: BATCH, log: say });

interface Planned { w: Work; rec?: CallRecord; cEdits: Edit[]; proposed?: Edit[]; rejections: string[]; declined: Array<{ issue: number; reason: string }>; notes: string[]; patched?: CatMeal; reJob?: CallJob; baseJob?: CallJob; baseline?: ReviewOutput }
const planned: Planned[] = [];
for (const w of work) {
  const p: Planned = { w, cEdits: [], rejections: [], declined: [], notes: [] };
  planned.push(p);
  if (!w.editorJob) continue;
  p.rec = edRecs.get(callKey(w.editorJob.request));
  if (!p.rec) { p.rejections.push("no editor result (not called, failed, or stopped at the ceiling)"); continue; }
  const input = p.rec.input as PatchInput;
  // the one DB fact the limits need: which EXISTING Ingredient each new name is
  const names = [
    ...(input.new_lines ?? []).map((x) => x.line?.name),
    ...(input.line_edits ?? []).filter((x) => x.new && x.old && x.new.name !== x.old.name && !x.remove).map((x) => x.new.name),
  ].filter((n): n is string => typeof n === "string" && !!n.trim());
  const found = names.length ? await lookupIngredientsByName(prisma, names.map((n) => ({ primaryKey: n.toLowerCase().trim(), rawName: n }))) : new Map();
  const rows = found.size ? await prisma.ingredient.findMany({ where: { id: { in: [...found.values()].map((x) => x.id) } }, select: { id: true, displayName: true, canonicalName: true, aliases: true } }) : [];
  const resolved = new Map<string, IngRow | null>(names.map((n) => { const hit = found.get(n.toLowerCase().trim()); return [n.toLowerCase().trim(), hit ? rows.find((r) => r.id === hit.id) ?? null : null]; }));
  const printed = new Map<string, string>();
  for (const d of (w.payload!.json as { meal: { dishes: Array<{ ingredients: Array<{ id: string; printed: string }> }> } }).meal.dishes) for (const i of d.ingredients) printed.set(w.payload!.ids.line.get(i.id)!.rowId, i.printed);
  const lim = checkPatch(w.postB, input, w.payload!.ids, w.sent, resolved, printed);
  Object.assign(p, { cEdits: lim.edits, proposed: lim.proposed, rejections: lim.rejections, declined: lim.declined, notes: lim.notes });
  if (lim.rejections.length || !lim.edits.length) continue;
  p.patched = patchMeal(w.postB, lim.edits);
  const p1 = pass1New(w.postB, p.patched, vocab);
  for (const f of p1) p.rejections.push(`Pass 1 new [${f.code}] ${f.dish} · ${f.where}: ${f.detail}`);
  if (p1.length) continue;
  p.reJob = { label: "rereview", mealId: w.meal.id, tool: TOOL_NAME, request: requestFor(userMessage(p.patched), 4096, BATCH) };
  const q0 = q0Review(requestKey(userMessage(w.meal)));
  if (q0) p.baseline = q0 as ReviewOutput;
  else p.baseJob = { label: "baseline", mealId: w.meal.id, tool: TOOL_NAME, request: requestFor(userMessage(w.meal), 4096, BATCH) };
}

// ── 4. re-review (+ baseline where CAT-Q0 never saw this payload) ───────────
const reJobs = planned.flatMap((p) => [p.reJob, p.baseJob].filter((j): j is CallJob => !!j));
const reRecs = reJobs.length ? await runCalls(reJobs, { ceilingUsd: left(), batch: BATCH, log: say }) : new Map<string, CallRecord>();
const gates = new Map<Planned, ReturnType<typeof reviewGate>>();
for (const p of planned) {
  if (!p.reJob) continue;
  const after = reRecs.get(callKey(p.reJob.request));
  const base = p.baseline ?? (p.baseJob ? (reRecs.get(callKey(p.baseJob.request))?.input as ReviewOutput | undefined) : undefined);
  if (!after || !base) { p.rejections.push(`no ${!after ? "re-review" : "baseline review"} result`); continue; }
  const answered = new Set(p.cEdits.flatMap((e) => e.answers));
  const g = reviewGate({ patched: p.patched!, issues: p.w.issues, answered, baseline: base.issues, after: after.input as ReviewOutput });
  gates.set(p, g);
  p.rejections.push(...g.reasons);
}

// ── 5. files ────────────────────────────────────────────────────────────────
const statusOf = (p: Planned) => (p.w.editorJob ? (p.rejections.length ? "rejected" : p.cEdits.length ? "accepted" : "declined") : p.w.bEdits.length ? "b-only" : "clean");
const costOf = (p: Planned, label?: string) => [p.rec, p.reJob && reRecs.get(callKey(p.reJob.request)), p.baseJob && reRecs.get(callKey(p.baseJob.request))].filter((r): r is CallRecord => !!r && (!label || r.label === label)).reduce((a, r) => a + r.costUsd, 0);
const fmtIng = (x: { quantity: number; unit: string; name: string; preparationNote: string | null; isOptional: boolean } | null) => (x ? `${Number(x.quantity.toFixed(4))} ${x.unit} ${x.name}${x.preparationNote ? ` (${x.preparationNote})` : ""}${x.isOptional ? " — optional" : ""}` : "(removed)");
function fmtEdit(e: Edit): string[] {
  const tag = e.source === "B" ? `[B ${e.rule}]` : `[C ${e.answers.map((n) => `#${n}`).join(" ")}]`;
  if (e.kind === "step") return [`  ${tag} ${e.dishTitle} — step ${e.stepIndex}${e.old.minutes !== e.new.minutes ? ` — minutes ${e.old.minutes} → ${e.new.minutes}` : ""}`, ...(e.old.text !== e.new.text ? [`      old: ${e.old.text}`, `      new: ${e.new.text}`] : [])];
  if (e.kind === "ingredient") return [`  ${tag} ${e.dishTitle} — line: ${fmtIng(e.old)} → ${fmtIng(e.new)}`];
  if (e.kind === "new_ingredient") return [`  ${tag} ${e.dishTitle} — NEW line: ${fmtIng(e.new)} (Ingredient "${e.ingredient.canonicalName}", ${e.ingredient.id})`];
  return [`  ${tag} ${e.dishTitle} — swap removed: ${e.old.quantity} ${e.old.unit} ${e.old.product} (replaces ${e.old.replaces.join(", ")})`];
}

const diff: string[] = [`CAT-Q1 plan — ${mode} — set ${SET} — ${new Date().toISOString()} — editor ${EDITOR_SHA} · rubric ${RUBRIC_SHA}`, ""];
const counts: Record<string, number> = {};
for (const p of planned) {
  const st = statusOf(p);
  counts[st] = (counts[st] ?? 0) + 1;
  const g = gates.get(p);
  const edits = [...p.w.bEdits, ...(st === "accepted" ? p.cEdits : [])];
  writeFileSync(join(DIR, "patches", `${p.w.meal.id}.json`), JSON.stringify({
    mealId: p.w.meal.id, title: p.w.meal.title, mode, host, set: SET, plannedAt: new Date().toISOString(), editorSha: EDITOR_SHA, rubricSha: RUBRIC_SHA,
    status: st, reasons: p.rejections, payloadKey: requestKey(userMessage(p.w.meal)),
    // what the database must produce after apply (check.ts compares)
    afterKey: requestKey(userMessage(st === "accepted" ? p.patched! : p.w.postB)),
    edits, proposedC: st === "accepted" ? undefined : (p.cEdits.length ? p.cEdits : p.proposed), issues: p.w.issues, held: p.w.held, declined: p.declined, notes: p.notes,
    sousVide: p.w.sousVide, gate: g ? { verdictAfter: g.verdictAfter, allowed: g.allowed, ruled: g.ruled } : null,
    costUsd: costOf(p),
  }, null, 1));
  if (st === "clean") continue;
  diff.push(`═══ ${p.w.meal.title} — ${p.w.meal.id} — ${st.toUpperCase()}${g ? ` — re-review verdict ${g.verdictAfter}` : ""}`);
  // The issues were found on the payload CAT-Q0 reviewed; say so when this database's differs.
  if (p.w.issues.length && !q0Review(requestKey(userMessage(p.w.meal)))) diff.push(`  NOTE: this payload is not the one CAT-Q0 reviewed (${mode === "dev" ? "dev differs from production" : "it moved since the review"}) — the issues may not describe it`);
  for (const i of p.w.issues) diff.push(`  issue #${i.n} [${i.severity} · class ${i.class}] ${i.dish}${i.where ? ` · ${i.where}` : ""} — "${i.quote}" — fix: ${i.fix}`);
  for (const h of p.w.held) diff.push(`  HELD #${h.n}: ${h.why}`);
  for (const s of p.w.sousVide) diff.push(`  sous vide ${s.dish}: ${s.protein} ${s.bathF}°F held ${s.holdMinutes} min · FSIS ${s.tableMinutes ?? "—"} min · meets ${s.meets} · with ${60} min come-up ${s.meetsWithComeUp}`);
  for (const e of edits) diff.push(...fmtEdit(e));
  if (st !== "accepted") for (const e of p.cEdits.length ? p.cEdits : p.proposed ?? []) diff.push(...fmtEdit(e).map((l) => `  (not applied) ${l.trimStart()}`));
  for (const d of p.declined) diff.push(`  declined #${d.issue}: ${d.reason}`);
  for (const r of p.rejections) diff.push(`  REJECTED: ${r}`);
  for (const r of g?.allowed ?? []) diff.push(`  left (not this patch's): [${r.severity} · class ${r.class}] ${r.dish} — "${r.quote}"`);
  for (const r of g?.ruled ?? []) diff.push(`  ruled (sous vide): [${r.severity} · class ${r.class}] ${r.dish} — "${r.quote}"`);
  diff.push("");
}
writeFileSync(join(DIR, `diff-${SET}.txt`), diff.join("\n"));

// ── summary ─────────────────────────────────────────────────────────────────
const ai = planned.filter((p) => p.rec);
const sum = (label?: string) => ai.reduce((a, p) => a + costOf(p, label), 0);
say(`\nCAT-Q1 plan ${mode} ${SET} — ${((Date.now() - t0) / 60000).toFixed(1)} min`);
say(`meals ${planned.length}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
say(`edits: B ${planned.reduce((a, p) => a + p.w.bEdits.length, 0)} · C accepted ${planned.filter((p) => statusOf(p) === "accepted").reduce((a, p) => a + p.cEdits.length, 0)}`);
say(`spend this run $${(spentSoFar() - startSpend).toFixed(4)} · per AI meal: editor $${(sum("editor") / Math.max(1, ai.length)).toFixed(4)} · re-review $${(sum("rereview") / Math.max(1, ai.length)).toFixed(4)} · baseline $${(sum("baseline") / Math.max(1, ai.length)).toFixed(4)} (${BATCH ? "batch" : "standard"} price)`);
say(`lane ledger $${spentSoFar().toFixed(4)}`);
say(`→ ${join(DIR, `diff-${SET}.txt`)} · ${join(DIR, "patches")}/`);
writeFileSync(join(DIR, `plan-${SET}.txt`), lines.join("\n"));
await prisma.$disconnect();
