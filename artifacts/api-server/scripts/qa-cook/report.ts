// QA-COOK-1 — the written report: the pattern list (the deliverable), the
// fajita case, the K-flag counts, the model comparison and the spend.
// Also the short section the night run puts in its summary.md (item E).
import { type Hit, type PatternRow, rankPatterns } from "./patterns";
import { caughtFajita } from "./personas";
import { FAJITA_MEAL_ID } from "./sample";
import type { CookView, KFinding, KFlag, PersonaRun } from "./types";
import { K_TITLES } from "./types";

export interface ModelCompare {
  meals: string[];
  models: {
    model: string;
    runs: number;
    issues: number;
    usd: number;
    minutes: number;
    patterns: Record<string, number>;
    fajita: boolean;
    errors: number;
  }[];
  /** Issues one model found that the other did not (same meal, same step ±1, same pattern). */
  onlyIn: Record<string, { meal: string; step: number; pattern: string; what: string }[]>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function kTable(sims: { view: CookView; findings: KFinding[] }[]): string[] {
  const L = ["| flag | what | findings | meals | high |", "|---|---|---:|---:|---:|"];
  for (const k of Object.keys(K_TITLES) as KFlag[]) {
    const fs = sims.flatMap((s) => s.findings.filter((f) => f.flag === k).map((f) => ({ f, meal: s.view.sourceMealId })));
    L.push(`| ${k} | ${K_TITLES[k]} | ${fs.length} | ${new Set(fs.map((x) => x.meal)).size} | ${fs.filter((x) => x.f.severity === "high").length} |`);
  }
  return L;
}

function patternBlock(r: PatternRow, i: number): string[] {
  const L: string[] = [];
  L.push(`### ${i + 1}. ${r.def.title} (${r.def.id})`);
  L.push(`**${r.meals} meal${r.meals === 1 ? "" : "s"} corroborated** of ${r.mealsRaw} touched (simulator ${r.mealsBySim}, two or more AI cooks ${r.mealsByPersona}) · worst **${r.worst}** · score ${r.score} · ${r.hits} hits · from: ${Object.entries(r.sources).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  L.push(`Cause: the hits split **sequencer ${r.cause.sequencer} / recipe text ${r.cause["recipe text"]}**; the fix belongs to the ${r.def.cause === "both" ? "sequencer and the recipe text" : r.def.cause}.`);
  L.push("");
  for (const e of r.examples) {
    L.push(`- *${e.meal}* (${e.servings} servings, ${e.prepped ? "prepped" : "unprepped"}, step ${e.steps.join("→")}, ${e.source === "sim" ? e.signature : e.who}): “${clip(e.quote, 200)}” — ${clip(e.detail, 260)}${e.rewrite ? ` **Rewrite:** ${clip(e.rewrite, 220)}` : ""}`);
  }
  L.push("");
  L.push(`**Rule:** ${r.def.rule}`);
  L.push("");
  return L;
}

export function renderReport(args: {
  views: CookView[];
  sims: { view: CookView; findings: KFinding[]; serveAt: number }[];
  runs: PersonaRun[];
  hits: Hit[];
  compare: ModelCompare | null;
  spend: { serverUsd: number; serverCalls: number; personaUsd: number; personaCalls: number; compareUsd: number; budgetUsd: number };
  time: { captureMin: number; personaMin: number; totalMin: number };
  facts: { runTag: string; sampleSize: number; seed: number; failures: string[]; bootProof: string; dirtyTree: string[]; model: string };
}): string {
  const { views, sims, runs, hits, compare, spend, time, facts } = args;
  const rows = rankPatterns(hits);
  const L: string[] = [];
  L.push(`# QA-COOK-1 · cook simulation · ${facts.runTag}`);
  L.push("");
  const meals = new Set(views.map((v) => v.sourceMealId)).size;
  L.push(`${meals} meals (seed ${facts.seed}) · ${views.length} Cook Mode sessions (2 and 6 servings × unprepped and after a full Prep the Week) · ${runs.length} AI-cook runs (${facts.model}) · ${hits.length} hits in ${rows.length} patterns`);
  L.push(`Spend **$${(spend.serverUsd + spend.personaUsd + spend.compareUsd).toFixed(2)}** of $${spend.budgetUsd} (server $${spend.serverUsd.toFixed(2)} in ${spend.serverCalls} calls · AI cooks $${spend.personaUsd.toFixed(2)} in ${spend.personaCalls} calls · comparison $${spend.compareUsd.toFixed(2)}) · time ${time.totalMin.toFixed(0)} min (capture ${time.captureMin.toFixed(0)}, AI cooks ${time.personaMin.toFixed(0)})`);
  L.push(`Email off: ${facts.bootProof}`);
  if (facts.failures.length) L.push(`Capture failures: ${facts.failures.join(" · ")}`);
  if (facts.dirtyTree.length) L.push(`Working tree under the server and app sources at capture (other lanes' uncommitted work runs in the child): ${facts.dirtyTree.length} files`);
  L.push("");

  // ── the fajita case ──
  const fv = views.filter((v) => v.sourceMealId === FAJITA_MEAL_ID);
  if (fv.length) {
    L.push("## The fajita case");
    for (const v of fv) {
      const s = sims.find((x) => x.view === v);
      const k = (s?.findings ?? []).filter((f) => /bread/.test(f.signature) || f.flag === "K3");
      const caught = runs.filter((r) => r.view.sourceMealId === v.sourceMealId && r.view.servings === v.servings && r.view.prepped === v.prepped).map((r) => `${r.persona} ${caughtFajita(r).length ? "✓" : "✗"}`);
      L.push(`- ${v.servings} servings, ${v.prepped ? "prepped" : "unprepped"}: simulator ${k.map((f) => `${f.flag} ${f.signature.split(":").slice(1).join(":")} (steps ${f.steps.join("→")})`).join("; ") || "—"} · AI cooks ${caught.join(", ") || "—"}`);
    }
    L.push("");
  }

  // ── the patterns ──
  L.push("## Patterns, ranked by corroborated meals × severity");
  L.push("");
  L.push("A meal counts for a pattern when the simulator flags it, or when at least two of the three AI cooks report it at the same step (±1). One cook alone can be its own kitchen (no Dutch oven → every later step \"never made\").");
  L.push("");
  L.push("| # | pattern | meals (corroborated) | meals (any report) | worst | score | sequencer / text hits | fix |");
  L.push("|---:|---|---:|---:|---|---:|---|---|");
  rows.forEach((r, i) => L.push(`| ${i + 1} | ${r.def.title} (${r.def.id}) | ${r.meals} | ${r.mealsRaw} | ${r.worst} | ${r.score} | ${r.cause.sequencer} / ${r.cause["recipe text"]} | ${r.def.cause} |`));
  L.push("");
  rows.forEach((r, i) => L.push(...patternBlock(r, i)));

  // ── K-flags ──
  L.push("## The simulator's flags");
  L.push(...kTable(sims));
  L.push("");

  // ── the content list ──
  const content = hits.filter((h) => h.cause === "recipe text" && ["P11", "P13", "P14", "P15", "P18", "P19", "P2"].includes(h.pattern) && h.severity !== "low");
  const seen = new Set<string>();
  L.push("## Recipe-text fixes (for a content pass)");
  for (const h of content) {
    const key = `${h.mealId}|${h.steps[0]}|${h.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    L.push(`- ${h.pattern} · *${h.meal}* step ${h.steps.join("→")}: “${clip(h.quote, 160)}” — ${clip(h.detail, 180)}`);
    if (seen.size >= 60) {
      L.push(`- … ${content.length - 60} more in patterns.json`);
      break;
    }
  }
  L.push("");

  // ── the model comparison ──
  if (compare) {
    L.push("## Model comparison");
    L.push(`Meals: ${compare.meals.join("; ")} (6 servings, unprepped, all three cooks)`);
    L.push("");
    L.push("| model | runs | issues | fajita | $ | min | errors | top patterns |");
    L.push("|---|---:|---:|---|---:|---:|---:|---|");
    for (const m of compare.models) {
      L.push(`| ${m.model} | ${m.runs} | ${m.issues} | ${m.fajita ? "caught" : "missed"} | ${m.usd.toFixed(3)} | ${m.minutes.toFixed(1)} | ${m.errors} | ${Object.entries(m.patterns).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(", ")} |`);
    }
    for (const [model, list] of Object.entries(compare.onlyIn)) {
      L.push("");
      L.push(`Only ${model} (${list.length}):`);
      for (const x of list.slice(0, 12)) L.push(`- ${x.pattern} · *${x.meal}* step ${x.step}: ${clip(x.what, 200)}`);
    }
    L.push("");
  }

  // ── AI cook health ──
  const errs = runs.filter((r) => r.error);
  L.push(`AI cooks: ${runs.length} runs, ${runs.reduce((n, r) => n + r.issues.length, 0)} issues, ${errs.length} errored${errs.length ? ` (${errs.slice(0, 3).map((r) => `${r.persona} ${r.view.title.slice(0, 30)}: ${r.error!.slice(0, 80)}`).join("; ")})` : ""}.`);
  return `${L.join("\n")}\n`;
}

/** The night run's section: the patterns found tonight, one line each, and what the AI cooks cost. */
export function nightSection(args: { hits: Hit[]; views: number; runs: PersonaRun[]; usd: number; meals: string[] }): string {
  const rows = rankPatterns(args.hits);
  const L: string[] = [];
  L.push(`## Cook simulation (${args.views} Cook Mode sessions; AI cooks on ${args.meals.length} meal${args.meals.length === 1 ? "" : "s"}: ${args.meals.join("; ") || "none"}; $${args.usd.toFixed(3)})`);
  if (rows.length === 0) L.push("none");
  for (const r of rows) {
    const e = r.examples[0];
    L.push(`- **${r.worst}** ${r.def.id} ${r.def.title} — ${r.meals} meal${r.meals === 1 ? "" : "s"} · e.g. *${e.meal}* step ${e.steps.join("→")}: “${clip(e.quote, 140)}”`);
  }
  return `${L.join("\n")}\n`;
}
