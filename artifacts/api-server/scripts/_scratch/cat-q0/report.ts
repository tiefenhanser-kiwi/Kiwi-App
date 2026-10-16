// CAT-Q0 B — the report for the fix pass, from FILES ONLY (no database, no API):
// out/<prod|dev>-catalog.json, out/reviews.jsonl, out/pass1-<mode>.csv, and the
// other side's catalog for the dev ↔ production diff.
//
//   node --import tsx scripts/_scratch/cat-q0/report.ts [--side prod|dev] [--seed 1015]
//
// Writes out/catq0-full.csv (one row per issue) and out/catq0-summary.md; prints
// the inline report (verdicts, class × severity, every block verbatim, 10 random
// fix issues, spend, cache and batch evidence, the diff, the step-less dishes).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mulberry32, shuffled } from "./rng";
import type { ReviewIssue } from "./rubric";
import { OUT, type ReviewRecord } from "./reviewRunner";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SIDE = arg("--side", "prod");
const OTHER = SIDE === "prod" ? "dev" : "prod";
const MODE = SIDE === "prod" ? "production" : "dev";
const SEED = Number(arg("--seed", "1015"));

interface CatRow { id: string; title: string; updatedAt: string; sourceType: string; payloadSha: string; reviewKey: string; planItems: number; templateItems: number; featured: string[]; steplessDishes: Array<{ dishId: string; title: string }> }
interface CatFile { mode: string; rubricSha: string; meals: number; payloadFingerprint: string; featuredPlans: Array<{ templateId: string; title: string }>; catalog: CatRow[] }
const readCat = (t: string): CatFile | null => (existsSync(join(OUT, `${t}-catalog.json`)) ? JSON.parse(readFileSync(join(OUT, `${t}-catalog.json`), "utf8")) : null);

const cat = readCat(SIDE);
if (!cat) throw new Error(`out/${SIDE}-catalog.json not found`);
const other = readCat(OTHER);
const recs = new Map<string, ReviewRecord>();
const allRecs: ReviewRecord[] = [];
for (const l of readFileSync(join(OUT, "reviews.jsonl"), "utf8").split("\n")) {
  if (!l.trim()) continue;
  const r = JSON.parse(l) as ReviewRecord;
  allRecs.push(r);
  if (r.ok) recs.set(r.key, r);
}
// Pass 1 classes per meal
const p1 = new Map<string, Set<string>>();
const p1csv = join(OUT, `pass1-${MODE}.csv`);
if (existsSync(p1csv)) {
  for (const line of readFileSync(p1csv, "utf8").split("\n").slice(1)) {
    const m = line.match(/^"[^"]*","([^"]*)","([^"]*)"/);
    if (m) p1.set(m[2], (p1.get(m[2]) ?? new Set()).add(m[1]));
  }
}

const out: string[] = [];
const say = (s = "") => { console.log(s); out.push(s); };

// integrity: the file's own fingerprint recomputes
const fp = createHash("sha256").update(cat.catalog.map((c) => `${c.id}:${c.payloadSha}`).sort().join("\n")).digest("hex");
say(`${SIDE} catalog: ${cat.meals} meals · payload fingerprint ${fp.slice(0, 8)}…${fp.slice(-4)} (${fp === cat.payloadFingerprint ? "recomputes" : "DOES NOT RECOMPUTE"}) · rubric ${cat.rubricSha}`);

// ── dev ↔ production ────────────────────────────────────────────────────────
if (other) {
  const a = new Map(cat.catalog.map((c) => [c.id, c]));
  const b = new Map(other.catalog.map((c) => [c.id, c]));
  const onlyOther = other.catalog.filter((c) => !a.has(c.id));
  const onlySide = cat.catalog.filter((c) => !b.has(c.id));
  const shared = cat.catalog.filter((c) => b.has(c.id));
  const differ = shared.filter((c) => b.get(c.id)!.payloadSha !== c.payloadSha);
  say(`\n═══ ${SIDE} ↔ ${OTHER} ═══`);
  say(`${OTHER}-only ids: ${onlyOther.length}`);
  for (const c of onlyOther) say(`  ${c.id} "${c.title}" (${c.sourceType}, updated ${c.updatedAt.slice(0, 10)})`);
  say(`${SIDE}-only ids: ${onlySide.length}`);
  for (const c of onlySide) say(`  ${c.id} "${c.title}" (${c.sourceType}, updated ${c.updatedAt.slice(0, 10)})`);
  say(`shared ids: ${shared.length} · same payload ${shared.length - differ.length} · different payload ${differ.length}`);
  for (const c of differ.slice(0, 40)) say(`  ${c.id} "${c.title}" — ${SIDE} updated ${c.updatedAt.slice(0, 16)}, ${OTHER} ${b.get(c.id)!.updatedAt.slice(0, 16)}`);
  if (differ.length > 40) say(`  … ${differ.length - 40} more`);
}

say(`\n═══ step-less dishes (${SIDE}) ═══`);
const stepless = cat.catalog.filter((c) => c.steplessDishes.length);
say(`${stepless.length} meals: ${stepless.map((c) => `${c.id} "${c.title}"`).join(" · ") || "none"}`);

// ── the reviews ─────────────────────────────────────────────────────────────
const rows = cat.catalog.map((c) => ({ c, r: recs.get(c.reviewKey) }));
const reviewed = rows.filter((x) => x.r) as Array<{ c: CatRow; r: ReviewRecord }>;
say(`\n═══ verdicts — ${reviewed.length}/${cat.meals} reviewed ═══`);
const v = (k: string, xs = reviewed) => xs.filter((x) => x.r.review!.verdict === k).length;
const feat = reviewed.filter((x) => x.c.featured.length);
say(`all      ok ${v("ok")} · fix ${v("fix")} · block ${v("block")}`);
say(`featured ok ${v("ok", feat)} · fix ${v("fix", feat)} · block ${v("block", feat)} (${feat.length} meals in live Featured plans)`);

const issues = reviewed.flatMap((x) => x.r.review!.issues.map((i) => ({ ...x, i })));
const SEV = ["block", "fix", "polish"] as const;
const table = ["| class | block | fix | polish | total |", "|---|---|---|---|---|"];
for (let k = 1; k <= 7; k++) {
  const n = (s: string) => issues.filter((x) => x.i.class === k && x.i.severity === s).length;
  table.push(`| ${k} | ${n("block")} | ${n("fix")} | ${n("polish")} | ${n("block") + n("fix") + n("polish")} |`);
}
table.push(`| all | ${SEV.map((s) => issues.filter((x) => x.i.severity === s).length).join(" | ")} | ${issues.length} |`);
say(`\nclass × severity`);
for (const t of table) say(t);

const where = (i: ReviewIssue) => [i.ingredient ? `ingredient "${i.ingredient}"` : "", i.stepIndex != null ? `step ${i.stepIndex}` : ""].filter(Boolean).join(" · ");
const fmt = (x: { c: CatRow; i: ReviewIssue }) => `[${x.i.severity} · class ${x.i.class}] ${x.c.title} — ${x.i.dish}${where(x.i) ? ` · ${where(x.i)}` : ""}${x.c.featured.length ? ` · FEATURED ${x.c.featured.join(",")}` : ""} — ${x.c.id}\n    quote: "${x.i.quote}"\n    why:   ${x.i.why}\n    fix:   ${x.i.fix}`;
const blocks = issues.filter((x) => x.i.severity === "block");
say(`\n═══ every block issue (${blocks.length}) ═══`);
blocks.forEach((x, n) => say(`#${n + 1} ${fmt(x)}`));
const fixes = issues.filter((x) => x.i.severity === "fix");
say(`\n═══ 10 random fix issues (seed ${SEED}, of ${fixes.length}) ═══`);
shuffled(fixes, mulberry32(SEED)).slice(0, 10).forEach((x, n) => say(`#${n + 1} ${fmt(x)}`));

// ── spend, cache, batch ─────────────────────────────────────────────────────
const batchFile = join(OUT, `batch-${MODE}.json`);
const batch = existsSync(batchFile) ? (JSON.parse(readFileSync(batchFile, "utf8")) as { id: string; submittedAt: string; keys: Record<string, unknown> }) : null;
const batchRecs = batch ? allRecs.filter((r) => r.label === "batch" && r.key in batch.keys) : [];
const okB = batchRecs.filter((r) => r.ok);
const sum = (f: (r: ReviewRecord) => number) => okB.reduce((a, r) => a + f(r), 0);
say(`\n═══ spend · cache · batch ═══`);
if (batch) {
  say(`batch ${batch.id} submitted ${batch.submittedAt} · ${Object.keys(batch.keys).length} requests · records ${batchRecs.length} (ok ${okB.length}, not ok ${batchRecs.length - okB.length})`);
  say(`batch spend $${sum((r) => r.costUsd).toFixed(2)} · per meal $${(sum((r) => r.costUsd) / Math.max(1, okB.length)).toFixed(4)} · tokens: in ${sum((r) => r.usage.input_tokens)} · cache read ${sum((r) => r.usage.cache_read_input_tokens)} · cache write ${sum((r) => r.usage.cache_creation_input_tokens)} · out ${sum((r) => r.usage.output_tokens)}`);
  say(`requests with a cache read ${okB.filter((r) => r.usage.cache_read_input_tokens > 0).length}/${okB.length} · with a cache write ${okB.filter((r) => r.usage.cache_creation_input_tokens > 0).length}`);
  const stops = new Map<string, number>();
  for (const r of batchRecs) stops.set(r.stopReason ?? r.error ?? "?", (stops.get(r.stopReason ?? r.error ?? "?") ?? 0) + 1);
  say(`stop reasons: ${[...stops].map(([k, n]) => `${k} ${n}`).join(" · ")}`);
} else say("no batch file for this side");
const ledger = existsSync(join(OUT, "spend.json")) ? JSON.parse(readFileSync(join(OUT, "spend.json"), "utf8")).usd : 0;
say(`ledger total (pilot + reruns + full run): $${Number(ledger).toFixed(2)}`);

// ── the files ───────────────────────────────────────────────────────────────
const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
const csv = ["mealId,title,verdict,featured,class,severity,dish,where,quote,why,fix,pass1"];
for (const x of rows) {
  const p = [...(p1.get(x.c.id) ?? [])].sort().join(";");
  const f = x.c.featured.join(";");
  if (!x.r) { csv.push([x.c.id, x.c.title, "NOT REVIEWED", f, "", "", "", "", "", "", "", p].map(cell).join(",")); continue; }
  if (!x.r.review!.issues.length) csv.push([x.c.id, x.c.title, x.r.review!.verdict, f, "", "", "", "", "", "", "", p].map(cell).join(","));
  for (const i of x.r.review!.issues) csv.push([x.c.id, x.c.title, x.r.review!.verdict, f, i.class, i.severity, i.dish, where(i), i.quote, i.why, i.fix, p].map(cell).join(","));
}
writeFileSync(join(OUT, "catq0-full.csv"), csv.join("\n"));

// Most planned: MealPlanItem count (plans that include the meal), then
// template-item count, then live Featured membership. Meal.useCount/saveCount/
// likeCount/timesCooked are all 0 on dev, so they are not used.
const ranked = [...reviewed].sort((a, b) => b.c.planItems - a.c.planItems || b.c.templateItems - a.c.templateItems || b.c.featured.length - a.c.featured.length || a.c.title.localeCompare(b.c.title)).slice(0, 20);
const md: string[] = [
  `# CAT-Q0 — catalog quality, ${MODE}`,
  "",
  `${reviewed.length} of ${cat.meals} meals reviewed (rubric ${cat.rubricSha}, claude-sonnet-5-5). Verdicts: ok ${v("ok")} · fix ${v("fix")} · block ${v("block")}. Featured: ok ${v("ok", feat)} · fix ${v("fix", feat)} · block ${v("block", feat)}.`,
  "",
  "## Issues by class × severity",
  "",
  "Classes: 1 can't work as written · 2 ingredients and steps disagree · 3 units · 4 missing prerequisites · 5 safety and technique · 6 swaps that aren't shortcuts · 7 times that lie.",
  "",
  ...table,
  "",
  "## The 20 most-planned meals first",
  "",
  `Ranked by MealPlanItem count (how many plans include the meal), then template-item count, then live Featured membership. Meal.useCount, saveCount, likeCount and timesCooked are all 0 on dev, so they are not used. On this database ${cat.catalog.filter((c) => c.planItems > 0).length} catalog meal(s) are in any plan (a plan holds a forked copy with its own meal id), and ${cat.catalog.filter((c) => c.templateItems > 0).length} are in a plan template, so in practice the order is template membership — the live Featured plans first.`,
  "",
];
for (const x of ranked) {
  md.push(`### ${x.c.title} — ${x.r.review!.verdict}`, "", `\`${x.c.id}\` · in ${x.c.planItems} plans · ${x.c.templateItems} template items${x.c.featured.length ? ` · Featured: ${x.c.featured.join(", ")}` : ""}`, "");
  if (!x.r.review!.issues.length) md.push("No issues.", "");
  for (const i of x.r.review!.issues) md.push(`- **${i.severity} · class ${i.class}** — ${i.dish}${where(i) ? ` · ${where(i)}` : ""}: "${i.quote}" — ${i.why} **Fix:** ${i.fix}`);
  md.push("");
}
md.push(`## Every block issue (${blocks.length})`, "");
for (const x of blocks) md.push(`- ${x.c.title} (\`${x.c.id}\`${x.c.featured.length ? `, Featured` : ""}) — class ${x.i.class} · ${x.i.dish}${where(x.i) ? ` · ${where(x.i)}` : ""}: "${x.i.quote}" — ${x.i.why} **Fix:** ${x.i.fix}`);
writeFileSync(join(OUT, "catq0-summary.md"), md.join("\n"));
writeFileSync(join(OUT, `catq0-report-${MODE}.txt`), out.join("\n"));
console.log(`\n→ out/catq0-full.csv (${csv.length - 1} rows) · out/catq0-summary.md · out/catq0-report-${MODE}.txt`);
