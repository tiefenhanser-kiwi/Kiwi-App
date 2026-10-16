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
//      except a sous vide doneness block, which goes to the editor as a fix:
//      the one-sentence fix when its time covers come-up + the FSIS hold
//      (sousVide.ts), or "lengthen to <the next passing half hour>, then the
//      sentence" when it does not. Below the table altogether → HELD for Hans.
//   3. The editor call → the code limits (limits.ts) → reject or Edits.
//   4. Pass 1 and the sous vide time check on the patched meal; the CAT-Q0
//      rubric on the patched meal and (when CAT-Q0 never reviewed this exact
//      payload) on the unpatched one as the baseline → the gate (gate.ts).
//   4b. ONE second round (follow-up B) when the re-review raised a new block or
//      fix and every answered issue is gone: the editor gets the patched meal
//      and only the new issue(s); its edits are limited, checked and
//      re-reviewed the same way. The last round decides; two rounds at most.
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
import { checkSousVide, COME_UP_MINUTES, formatMinutes, sousVideFailures, type SousVideCheck } from "./sousVide";
import { callKey } from "./caller";
import { graphHash, readGraph } from "./graph";
import { roundTwoDeclined, secondRoundIssues, wantsSecondRound } from "./gate";

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
    const what = sv.c.protein === "poultry" ? "chicken" : "meat";
    const need = `${COME_UP_MINUTES} min come-up + ${sv.c.tableMinutes} min FSIS hold at ${sv.c.bathF}°F = ${sv.c.requiredMinutes?.toFixed(1)} min`;
    if (sv.c.meets) {
      overrides.set(i.n, {
        severity: "fix",
        fix: `Add ONE sentence to the bath step (step ${sv.c.holdStep}) saying that holding the ${what} at ${sv.c.bathF}°F for the full time stated is what makes it safe to eat. Change nothing else about its doneness.`,
        ruling: `D-WS9-315 sous vide: ${sv.c.bathF}°F for ${formatMinutes(sv.c.holdMinutes)} covers ${need} — a fix, not a block`,
      });
    } else if (sv.c.passingMinutes !== null) {
      // follow-up B: too short once come-up is counted → lengthen to the next passing half hour
      overrides.set(i.n, {
        severity: "fix",
        fix: `In step ${sv.c.holdStep}, change the bath time from ${formatMinutes(sv.c.holdMinutes)} to exactly ${formatMinutes(sv.c.passingMinutes)} and set that step's minutes to ${sv.c.passingMinutes}; then add ONE sentence saying that holding the ${what} at ${sv.c.bathF}°F for the full ${formatMinutes(sv.c.passingMinutes)} is what makes it safe to eat. Change nothing else about its doneness.`,
        ruling: `D-WS9-315 sous vide (come-up counted): ${formatMinutes(sv.c.holdMinutes)} is short of ${need}; the next half hour that passes is ${formatMinutes(sv.c.passingMinutes)}`,
      });
    } else held.push({ n: i.n, why: `sous vide ${sv.c.bathF}°F is below the FSIS table for ${sv.c.protein} — no time makes it safe; held for Hans, not sent to the editor` });
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

// ── 3–4. the editor, the limits, the re-review, the gate — round 1, then round 2 ──
const startSpend = spentSoFar();
const left = () => CEILING - (spentSoFar() - startSpend);
/** Every call record this run saw (cache hits included), for the cost lines. */
const recs = new Map<string, CallRecord>();
const keep = (m: Map<string, CallRecord>) => { for (const [k, v] of m) recs.set(k, v); return m; };

interface Round {
  n: 1 | 2;
  /** The meal the editor saw (postB in round 1, round 1's result in round 2). */
  base: CatMeal;
  issues: Q0Issue[];
  payload: ReturnType<typeof editorPayload>;
  job: CallJob;
  rec?: CallRecord;
  edits: Edit[];
  proposed: Edit[];
  declined: Array<{ issue: number; reason: string }>;
  notes: string[];
  rejections: string[];
  patched?: CatMeal;
  reJob?: CallJob;
  gate?: ReturnType<typeof reviewGate>;
}
interface Planned { w: Work; rounds: Round[]; baseJob?: CallJob; baseline?: ReviewOutput }
const planned: Planned[] = work.map((w) => ({ w, rounds: [] }));
const last = (p: Planned) => p.rounds[p.rounds.length - 1];
/** Every C edit an accepted patch carries, round by round. */
const cEditsOf = (p: Planned) => p.rounds.flatMap((r) => r.edits);
const rejectionsOf = (p: Planned) => (p.rounds.length ? last(p).rejections : []);

async function resolveNames(input: PatchInput) {
  // the one DB fact the limits need: which EXISTING Ingredient each new name is
  const names = [
    ...(input.new_lines ?? []).map((x) => x.line?.name),
    ...(input.line_edits ?? []).filter((x) => x.new && x.old && x.new.name !== x.old.name && !x.remove).map((x) => x.new.name),
  ].filter((n): n is string => typeof n === "string" && !!n.trim());
  const found = names.length ? await lookupIngredientsByName(prisma, names.map((n) => ({ primaryKey: n.toLowerCase().trim(), rawName: n }))) : new Map();
  const rows = found.size ? await prisma.ingredient.findMany({ where: { id: { in: [...found.values()].map((x) => x.id) } }, select: { id: true, displayName: true, canonicalName: true, aliases: true } }) : [];
  return new Map<string, IngRow | null>(names.map((n) => { const hit = found.get(n.toLowerCase().trim()); return [n.toLowerCase().trim(), hit ? rows.find((r) => r.id === hit.id) ?? null : null]; }));
}
function printedOf(payload: ReturnType<typeof editorPayload>) {
  const printed = new Map<string, string>();
  for (const d of (payload.json as { meal: { dishes: Array<{ ingredients: Array<{ id: string; printed: string }> }> } }).meal.dishes) for (const i of d.ingredients) printed.set(payload.ids.line.get(i.id)!.rowId, i.printed);
  return printed;
}

/** One round over `rounds`: editor → limits → Pass 1 + sous vide → re-review (+ baseline) → gate. */
async function runRound(rounds: Array<{ p: Planned; r: Round }>) {
  if (!rounds.length) return;
  const tag = rounds[0].r.n === 1 ? "" : "2";
  const edRecs = keep(await runCalls(rounds.map((x) => x.r.job), { ceilingUsd: left(), batch: BATCH, log: say }));
  for (const { p, r } of rounds) {
    r.rec = edRecs.get(callKey(r.job.request));
    if (!r.rec) { r.rejections.push(`round ${r.n}: no editor result (not called, failed, or stopped at the ceiling)`); continue; }
    const input = r.rec.input as PatchInput;
    const lim = checkPatch(r.base, input, r.payload.ids, r.issues, await resolveNames(input), printedOf(r.payload));
    Object.assign(r, { edits: lim.edits.map((e) => (r.n === 2 ? { ...e, round: 2 } : e)), proposed: lim.proposed, declined: lim.declined, notes: lim.notes });
    r.rejections.push(...lim.rejections.map((x) => (r.n === 2 ? `round 2: ${x}` : x)));
    const declinedAll = roundTwoDeclined(r.n, lim.edits.length, lim.rejections.length);
    if (declinedAll) r.rejections.push(declinedAll);
    if (lim.rejections.length || !lim.edits.length) continue;
    r.patched = patchMeal(r.base, r.edits);
    const p1 = pass1New(p.w.postB, r.patched, vocab);
    for (const f of p1) r.rejections.push(`Pass 1 new [${f.code}] ${f.dish} · ${f.where}: ${f.detail}`);
    // follow-up B: the final sous vide time must cover come-up + the FSIS hold
    r.rejections.push(...sousVideFailures(r.patched));
    if (r.rejections.length) continue;
    r.reJob = { label: `rereview${tag}`, mealId: p.w.meal.id, tool: TOOL_NAME, request: requestFor(userMessage(r.patched), 4096, BATCH) };
    if (r.n === 1) {
      const q0 = q0Review(requestKey(userMessage(p.w.meal)));
      if (q0) p.baseline = q0 as ReviewOutput;
      else p.baseJob = { label: "baseline", mealId: p.w.meal.id, tool: TOOL_NAME, request: requestFor(userMessage(p.w.meal), 4096, BATCH) };
    }
  }
  const reJobs = rounds.flatMap(({ p, r }) => [r.reJob, r.n === 1 ? p.baseJob : undefined].filter((j): j is CallJob => !!j));
  const reRecs = reJobs.length ? keep(await runCalls(reJobs, { ceilingUsd: left(), batch: BATCH, log: say })) : new Map<string, CallRecord>();
  for (const { p, r } of rounds) {
    if (!r.reJob) continue;
    const after = reRecs.get(callKey(r.reJob.request));
    if (p.baseJob && !p.baseline) p.baseline = reRecs.get(callKey(p.baseJob.request))?.input as ReviewOutput | undefined;
    if (!after || !p.baseline) { r.rejections.push(`no ${!after ? "re-review" : "baseline review"} result`); continue; }
    const issues = p.rounds.flatMap((x) => x.issues);
    const answered = new Set(cEditsOf(p).flatMap((e) => e.answers));
    r.gate = reviewGate({ patched: r.patched!, issues, answered, baseline: p.baseline.issues, after: after.input as ReviewOutput });
    r.rejections.push(...r.gate.reasons.map((x) => (r.n === 2 ? `round 2: ${x}` : x)));
  }
}

// round 1
const r1: Array<{ p: Planned; r: Round }> = [];
for (const p of planned) {
  if (!p.w.editorJob) continue;
  const r: Round = { n: 1, base: p.w.postB, issues: p.w.sent, payload: p.w.payload!, job: p.w.editorJob, edits: [], proposed: [], declined: [], notes: [], rejections: [] };
  p.rounds.push(r);
  r1.push({ p, r });
}
await runRound(r1);

// round 2 (follow-up B): one more editor round for a REAL new issue the re-review raised
const r2: Array<{ p: Planned; r: Round }> = [];
for (const p of planned) {
  const r = p.rounds[0];
  if (!r?.gate || !wantsSecondRound(r.gate)) continue;
  const issues = secondRoundIssues(r.gate.fresh, p.w.issues, p.w.meal);
  const payload = editorPayload(r.patched!, editorIssues(issues), "The issues the editor fixed earlier are already fixed in this text. Fix only the issues listed here.");
  const next: Round = {
    n: 2, base: r.patched!, issues, payload, edits: [], proposed: [], declined: [], notes: [], rejections: [],
    job: { label: "editor2", mealId: p.w.meal.id, tool: EDIT_TOOL, request: editorRequest(editorUserMessage(payload.json), 4096, BATCH) },
  };
  p.rounds.push(next);
  r2.push({ p, r: next });
}
say(`round 2: ${r2.length} meals (a new block/fix in the re-review and every answered issue gone)`);
await runRound(r2);

// The LAST round decides: round 1's gate reasons are what sent a meal to round 2.
// A meal whose last round is rejected keeps no edit from either round.
for (const p of planned) if (p.rounds.length && last(p).rejections.length) for (const r of p.rounds) r.edits = [];
const patchedOf = (p: Planned) => last(p)?.patched;
const gateOf = (p: Planned) => last(p)?.gate;
const allRecs = (p: Planned) => [...p.rounds.flatMap((r) => [r.rec, r.reJob && callRec(r.reJob)]), p.baseJob && callRec(p.baseJob)].filter((x): x is CallRecord => !!x);
function callRec(j: CallJob) { return recs.get(callKey(j.request)); }

// ── 5. files ────────────────────────────────────────────────────────────────
const statusOf = (p: Planned) => (p.w.editorJob ? (rejectionsOf(p).length ? "rejected" : cEditsOf(p).length ? "accepted" : "declined") : p.w.bEdits.length ? "b-only" : "clean");
const costOf = (p: Planned, label?: string) => allRecs(p).filter((r) => !label || r.label === label).reduce((a, r) => a + r.costUsd, 0);
const fmtIng = (x: { quantity: number; unit: string; name: string; preparationNote: string | null; isOptional: boolean } | null) => (x ? `${Number(x.quantity.toFixed(4))} ${x.unit} ${x.name}${x.preparationNote ? ` (${x.preparationNote})` : ""}${x.isOptional ? " — optional" : ""}` : "(removed)");
function fmtEdit(e: Edit): string[] {
  const tag = e.source === "B" ? `[B ${e.rule}]` : `[C${e.round === 2 ? "2" : ""} ${e.answers.map((n) => `#${n}`).join(" ")}]`;
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
  const g = gateOf(p);
  const cEdits = cEditsOf(p);
  const edits = [...p.w.bEdits, ...(st === "accepted" ? cEdits : [])];
  const proposed = p.rounds.flatMap((r) => (r.edits.length ? r.edits : r.proposed).map((e) => (r.n === 2 ? { ...e, round: 2 } : e)));
  writeFileSync(join(DIR, "patches", `${p.w.meal.id}.json`), JSON.stringify({
    mealId: p.w.meal.id, title: p.w.meal.title, mode, host, set: SET, plannedAt: new Date().toISOString(), editorSha: EDITOR_SHA, rubricSha: RUBRIC_SHA,
    status: st, reasons: rejectionsOf(p), rounds: p.rounds.length, payloadKey: requestKey(userMessage(p.w.meal)),
    // what the database must produce after apply (check.ts compares)
    afterKey: requestKey(userMessage(st === "accepted" ? patchedOf(p)! : p.w.postB)),
    // the row graph plan.ts read (apply's dry run says whether it moved since)
    graphAtPlan: st === "accepted" || st === "b-only" ? graphHash(await readGraph(prisma, p.w.meal.id)) : undefined,
    edits, proposedC: st === "accepted" ? undefined : proposed,
    issues: p.rounds.flatMap((r) => r.issues).concat(p.rounds.length ? [] : p.w.issues), held: p.w.held,
    declined: p.rounds.flatMap((r) => r.declined), notes: p.rounds.flatMap((r) => r.notes),
    roundOneReasons: p.rounds.length === 2 ? p.rounds[0].rejections : undefined,
    sousVide: p.w.sousVide, gate: g ? { verdictAfter: g.verdictAfter, allowed: g.allowed, ruled: g.ruled } : null,
    costUsd: costOf(p),
  }, null, 1));
  if (st === "clean") continue;
  diff.push(`═══ ${p.w.meal.title} — ${p.w.meal.id} — ${st.toUpperCase()}${p.rounds.length === 2 ? " after round 2" : ""}${g ? ` — re-review verdict ${g.verdictAfter}` : ""}`);
  // The issues were found on the payload CAT-Q0 reviewed; say so when this database's differs.
  if (p.w.issues.length && !q0Review(requestKey(userMessage(p.w.meal)))) diff.push(`  NOTE: this payload is not the one CAT-Q0 reviewed (${mode === "dev" ? "dev differs from production" : "it moved since the review"}) — the issues may not describe it`);
  for (const i of p.w.issues) diff.push(`  issue #${i.n} [${i.severity} · class ${i.class}] ${i.dish}${i.where ? ` · ${i.where}` : ""} — "${i.quote}" — fix: ${i.fix}`);
  for (const h of p.w.held) diff.push(`  HELD #${h.n}: ${h.why}`);
  for (const s of p.w.sousVide) diff.push(`  sous vide ${s.dish} (as planned on): ${s.protein} ${s.bathF}°F for ${s.holdMinutes} min · needs ${COME_UP_MINUTES} come-up + ${s.tableMinutes ?? "—"} FSIS = ${s.requiredMinutes?.toFixed(1) ?? "—"} min · passes ${s.meets}${s.meets ? "" : ` · next passing ${s.passingMinutes ?? "—"} min`}`);
  if (st === "accepted") for (const d of patchedOf(p)!.dishes) { const c = checkSousVide(d); if (c) diff.push(`  sous vide ${d.title} (after the patch): ${c.bathF}°F for ${c.holdMinutes} min · passes ${c.meets}`); }
  for (const e of p.w.bEdits) diff.push(...fmtEdit(e));
  for (const r of p.rounds) {
    if (r.n === 2) {
      diff.push(`  ── round 1 was rejected by the re-review; round 2 got the new issue(s):`);
      for (const x of p.rounds[0].rejections) diff.push(`  round 1 REJECTED: ${x}`);
      for (const i of r.issues) diff.push(`  issue #${i.n} (round 2) [${i.severity} · class ${i.class}] ${i.dish}${i.where ? ` · ${i.where}` : ""} — "${i.quote}" — fix: ${i.fix}`);
    }
    const shown = st === "accepted" ? r.edits : r.edits.length ? r.edits : r.proposed;
    for (const e of shown) diff.push(...fmtEdit(r.n === 2 ? { ...e, round: 2 } : e).map((l) => (st === "accepted" ? l : `  (not applied) ${l.trimStart()}`)));
    for (const d of r.declined) diff.push(`  declined #${d.issue}: ${d.reason}`);
  }
  for (const r of rejectionsOf(p)) diff.push(`  REJECTED: ${r}`);
  for (const r of g?.allowed ?? []) diff.push(`  left (not this patch's): [${r.severity} · class ${r.class}] ${r.dish} — "${r.quote}"`);
  for (const r of g?.ruled ?? []) diff.push(`  ruled (sous vide): [${r.severity} · class ${r.class}] ${r.dish} — "${r.quote}"`);
  diff.push("");
}
writeFileSync(join(DIR, `diff-${SET}.txt`), diff.join("\n"));

// ── summary ─────────────────────────────────────────────────────────────────
const ai = planned.filter((p) => p.rounds.length);
const sum = (label?: string) => ai.reduce((a, p) => a + costOf(p, label), 0);
const per = (label: string) => (sum(label) / Math.max(1, ai.length)).toFixed(4);
say(`\nCAT-Q1 plan ${mode} ${SET} — ${((Date.now() - t0) / 60000).toFixed(1)} min`);
say(`meals ${planned.length}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")} · round 2 tried ${r2.length}, accepted ${r2.filter(({ p }) => statusOf(p) === "accepted").length}`);
say(`edits: B ${planned.reduce((a, p) => a + p.w.bEdits.length, 0)} · C accepted ${planned.filter((p) => statusOf(p) === "accepted").reduce((a, p) => a + cEditsOf(p).length, 0)}`);
say(`spend this run $${(spentSoFar() - startSpend).toFixed(4)} · per AI meal: editor $${per("editor")} · re-review $${per("rereview")} · baseline $${per("baseline")} (${BATCH ? "batch" : "standard"} price)`);
say(`round 2 extra (all meals, cached calls included): editor2 $${sum("editor2").toFixed(4)} · rereview2 $${sum("rereview2").toFixed(4)}`);
say(`lane ledger $${spentSoFar().toFixed(4)}`);
say(`→ ${join(DIR, `diff-${SET}.txt`)} · ${join(DIR, "patches")}/`);
writeFileSync(join(DIR, `plan-${SET}.txt`), lines.join("\n"));
await prisma.$disconnect();
