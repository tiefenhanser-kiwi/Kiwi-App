// A4 — THE AI STAGE, MEASURED. READ-ONLY, reads out/*.json only.
//
//   --mode diff    every change grocery.generate_list made, per list, classified
//   --mode repro   which rows differ between repeated runs of one plan
//   --mode ab      live vs the AI-removed control: rows and defects per list
//
//   node --import tsx scripts/grocery-census/compare.ts --mode diff --tag live
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return (i >= 0 ? process.argv[i + 1] : fallback) as string;
}
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
const load = (f: string) => JSON.parse(readFileSync(join(OUT, f), "utf8"));
const listFiles = (tag: string) =>
  readdirSync(OUT).filter((f) => f.startsWith(`${tag}__`) && f.endsWith(".json")).sort();

interface Item {
  canonicalName: string; displayName: string; quantity: number; unit: string;
  sectionKey: string; isUniversalStaple: boolean; isUserPantryStaple: boolean;
  isRecurringItem: boolean; isAmbiguous: boolean; wasAiInferred: boolean;
  purchaseDisplay: string | null; notes: string | null;
}

// R7's over-specific shapes — a buy name a store search will not match.
const OVERSPECIFIC = /\b(about|approximately|roughly|preferably|homemade|high[- ]quality)\b|,\s*(cut|sliced|diced|chopped|minced|torn|trimmed|halved|quartered|grated|shredded|cubed|thinly|finely|coarsely|divided|plus more|room temperature)|\d+(\.\d+)?[- ]?inch/i;

function classify(before: Item, after: Item): { verdict: string; why: string }[] {
  const out: { verdict: string; why: string }[] = [];
  if (norm(before.displayName) !== norm(after.displayName)) {
    const wasOver = OVERSPECIFIC.test(before.displayName);
    const isOver = OVERSPECIFIC.test(after.displayName);
    const shorter = after.displayName.length < before.displayName.length;
    let verdict = "neutral";
    let why = "cosmetic rename";
    if (!wasOver && isOver) { verdict = "regress"; why = "R7: made the buy name over-specific"; }
    else if (wasOver && !isOver) { verdict = "improve"; why = "R7: made the buy name shoppable"; }
    else if (shorter && norm(after.displayName).length > 2 && norm(before.displayName).includes(norm(after.displayName))) {
      verdict = "improve"; why = "R7: generalised toward a search term";
    } else if (/^[A-Z]/.test(after.displayName) && !/^[A-Z]/.test(before.displayName)) {
      verdict = "regress"; why = "R6/display: introduced a leading capital";
    } else if (!/^[A-Z]/.test(after.displayName) && /^[A-Z]/.test(before.displayName)) {
      verdict = "improve"; why = "display: removed a leading capital";
    }
    out.push({ verdict, why: `displayName "${before.displayName}" → "${after.displayName}" — ${why}` });
  }
  if (before.sectionKey !== after.sectionKey) {
    const verdict = before.sectionKey === "extras" ? "improve" : after.sectionKey === "extras" ? "regress" : "neutral";
    out.push({ verdict, why: `section ${before.sectionKey} → ${after.sectionKey} — ${verdict === "improve" ? "R8: rescued from extras" : verdict === "regress" ? "R8: dropped into extras" : "reassigned"}` });
  }
  if (Math.abs(before.quantity - after.quantity) > 1e-6 || before.unit !== after.unit) {
    out.push({ verdict: "review", why: `need ${before.quantity} ${before.unit} → ${after.quantity} ${after.unit}` });
  }
  for (const f of ["isUniversalStaple", "isUserPantryStaple", "isRecurringItem"] as const) {
    if (before[f] !== after[f]) {
      out.push({ verdict: "regress", why: `flag ${f} ${before[f]} → ${after[f]} — the prompt contract says flags are preserved exactly` });
    }
  }
  return out;
}

function diffMode(tag: string) {
  const L: string[] = [];
  const totals = { improve: 0, neutral: 0, regress: 0, review: 0, dropped: 0, added: 0 };
  const perList: string[] = [];

  for (const file of listFiles(tag)) {
    const r = load(file);
    const cons: Item[] = r.consolidated;
    const fin: Item[] = r.final;
    const aiKeys = new Set<string>(r.aiSubsetKeys);
    // Only rows that WENT to the model can have been changed by it; the
    // deterministic half is built locally and is not the pass under question.
    const consAI = cons.filter((c) => aiKeys.has(`${c.canonicalName}|${c.unit}`));
    const byName = new Map<string, Item[]>();
    for (const c of consAI) {
      const k = norm(c.canonicalName);
      (byName.get(k) ?? byName.set(k, []).get(k)!).push(c);
    }
    const seen = new Set<Item>();
    const changes: { verdict: string; why: string }[] = [];
    let dropped = 0, added = 0;

    for (const f of fin) {
      const k = norm(f.canonicalName);
      const q = byName.get(k);
      if (!q || q.length === 0) continue; // a deterministic row, or unmatched
      const src = q.shift()!;
      seen.add(src);
      changes.push(...classify(src, f));
    }
    for (const c of consAI) if (!seen.has(c)) dropped++;

    const counts = { improve: 0, neutral: 0, regress: 0, review: 0 };
    for (const c of changes) counts[c.verdict as keyof typeof counts]++;
    totals.improve += counts.improve; totals.neutral += counts.neutral;
    totals.regress += counts.regress; totals.review += counts.review;
    totals.dropped += dropped; totals.added += added;

    perList.push(
      `${file.padEnd(30)} consolidated=${String(cons.length).padStart(3)} aiSubset=${String(r.aiSubsetCount).padStart(3)} final=${String(fin.length).padStart(3)}  cost=$${Number(r.costUsd).toFixed(4)}  improve=${counts.improve} neutral=${counts.neutral} regress=${counts.regress} review=${counts.review} merged/dropped=${dropped}`,
    );
    if (changes.length > 0 || dropped > 0) {
      L.push(`\n── ${file}  (AI subset ${r.aiSubsetCount} of ${cons.length}) ──`);
      for (const c of changes) L.push(`   [${c.verdict.toUpperCase().padEnd(7)}] ${c.why}`);
      if (dropped > 0) L.push(`   [MERGE  ] ${dropped} consolidated row(s) absorbed or dropped by the pass`);
    }
  }

  const head = [
    `A4 — WHAT grocery.generate_list CHANGED (tag=${tag})`,
    "",
    "PER LIST", ...perList, "",
    `TOTALS  improve=${totals.improve}  neutral=${totals.neutral}  regress=${totals.regress}  needs-review=${totals.review}  merged/dropped rows=${totals.dropped}`,
  ];
  writeFileSync(join(OUT, `_ai_diff__${tag}.txt`), [...head, ...L].join("\n"));
  console.log(head.join("\n"));
}

function reproMode(tag: string) {
  const files = listFiles(tag);
  const byPlan = new Map<string, string[]>();
  for (const f of files) {
    const p = f.split("__")[1];
    (byPlan.get(p) ?? byPlan.set(p, []).get(p)!).push(f);
  }
  const L: string[] = [`A4 — REPRODUCIBILITY (tag=${tag})`, ""];
  for (const [plan, fs] of byPlan) {
    if (fs.length < 2) continue;
    const runs = fs.map(load);
    const sig = (r: { final: Item[] }) =>
      r.final.map((i) => `${norm(i.canonicalName)}|${i.quantity}|${i.unit}|${i.sectionKey}`).sort().join("\n");
    const rendered = (r: { rendered: { line: string }[] }) => r.rendered.map((x) => x.line).sort().join("\n");
    const sigs = runs.map(sig);
    const rends = runs.map(rendered);
    const distinctSubstance = new Set(sigs).size;
    const distinctRendered = new Set(rends).size;
    const distinctOutput = new Set(runs.flatMap((r) => r.aiCalls.map((c: { outputHash: string }) => c.outputHash))).size;
    const distinctPrompt = new Set(runs.flatMap((r) => r.aiCalls.map((c: { promptHash: string }) => c.promptHash))).size;
    L.push(
      `${plan}  runs=${fs.length}  rowCounts=[${runs.map((r) => r.finalCount).join(",")}]  ` +
      `distinct promptHash=${distinctPrompt}  distinct outputHash=${distinctOutput}  ` +
      `distinct SUBSTANCE=${distinctSubstance}  distinct RENDERED=${distinctRendered}`,
    );
    if (distinctRendered > 1) {
      const base = rends[0].split("\n");
      for (let i = 1; i < rends.length; i++) {
        const cur = rends[i].split("\n");
        const onlyBase = base.filter((x) => !cur.includes(x));
        const onlyCur = cur.filter((x) => !base.includes(x));
        for (const x of onlyBase) L.push(`      run1 only: ${x}`);
        for (const x of onlyCur) L.push(`      run${i + 1} only: ${x}`);
      }
    }
  }
  writeFileSync(join(OUT, `_repro__${tag}.txt`), L.join("\n"));
  console.log(L.join("\n"));
}

function abMode(a: string, b: string) {
  const fa = listFiles(a), fb = listFiles(b);
  const key = (f: string) => f.split("__")[1];
  const mapB = new Map(fb.map((f) => [key(f), f]));
  const findA = JSON.parse(readFileSync(join(OUT, `_findings__${a}.json`), "utf8"));
  const findB = JSON.parse(readFileSync(join(OUT, `_findings__${b}.json`), "utf8"));
  const defOf = (fr: { perList: Record<string, Record<string, number>> }, file: string) =>
    Object.values(fr.perList[file] ?? {}).reduce((x, y) => x + y, 0);

  const L: string[] = [
    `A4 — ${a.toUpperCase()} vs ${b.toUpperCase()} (the AI pass removed)`,
    "",
    `${"plan".padEnd(10)} ${"rows " + a}  ${"rows " + b}   ${"defects " + a}  ${"defects " + b}   cost ${a}`,
  ];
  let ra = 0, rb = 0, da = 0, db = 0, cost = 0;
  for (const f of fa) {
    const g = mapB.get(key(f));
    if (!g) continue;
    const A = load(f), B = load(g);
    const dA = defOf(findA, f), dB = defOf(findB, g);
    ra += A.finalCount; rb += B.finalCount; da += dA; db += dB; cost += Number(A.costUsd);
    L.push(
      `${key(f).padEnd(10)} ${String(A.finalCount).padStart(7)}  ${String(B.finalCount).padStart(7)}   ` +
      `${String(dA).padStart(10)}  ${String(dB).padStart(10)}   $${Number(A.costUsd).toFixed(4)}`,
    );
  }
  L.push("");
  L.push(`TOTAL      rows ${a}=${ra}  rows ${b}=${rb}  |  defects ${a}=${da}  defects ${b}=${db}  |  ${a} cost $${cost.toFixed(4)}`);
  L.push(`NET EFFECT OF THE AI PASS: ${da - db >= 0 ? "+" : ""}${da - db} defects, ${ra - rb >= 0 ? "+" : ""}${ra - rb} rows, for $${cost.toFixed(4)}`);
  writeFileSync(join(OUT, `_ab__${a}_vs_${b}.txt`), L.join("\n"));
  console.log(L.join("\n"));
}

const mode = arg("mode", "diff");
if (mode === "diff") diffMode(arg("tag", "live"));
else if (mode === "repro") reproMode(arg("tag", "repro"));
else if (mode === "ab") abMode(arg("a", "live"), arg("b", "det"));
else throw new Error("mode must be diff | repro | ab");
