// [prepcook] B1 — the container count, counted the way a kitchen counts.
//
// 🔴 THE FIRST METRIC COULD NOT SEE RULING 9 AT ALL. `check.ts`'s P-R1 counts one
// container per (ingredient, dish) portion, which is invariant under a step
// MERGE: folding a lone paprika into its dish's sauce step moves the measure
// without removing it, so 411 stayed 411 and the fold looked like it did nothing.
//
// A kitchen counts vessels, and the rule is what the step DOES:
//   • a step that COMBINES things — a blend, or a per-dish sauce/marinade — is
//     ONE container per dish, however many ingredients go into it. That is the
//     whole point of a blend step.
//   • a step that PORTIONS one ingredient across dishes (produce, proteins) is
//     one container per dish it feeds.
//
// Under that rule the fold is visible, because it turns two containers for one
// dish (a blend of one + a sauce) into one.
//
//   node --import tsx scripts/prep-cook-census/containers.ts --before live --after after
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const BEFORE = arg("before", "live");
const AFTER = arg("after", "after");

interface Measure { forDish: string; amount: string }
interface Component { ingredientName: string; measures: Measure[] }
interface Step { phase: string; isBlend?: boolean; components: Component[] }

/** Containers + step count for one plan's narration input. */
function count(path: string): { containers: number; steps: number; combineSteps: number } {
  const n = JSON.parse(readFileSync(path, "utf8")) as { steps: Step[] };
  let containers = 0;
  let combineSteps = 0;
  for (const st of n.steps) {
    // A blend, or a per-dish sauce/marinade step, is a MIXTURE: one vessel per dish.
    const isCombine = st.isBlend === true || st.phase === "sauces_marinades";
    const dishes = new Set(st.components.flatMap((c) => c.measures.map((m) => m.forDish)));
    if (isCombine) {
      containers += dishes.size;
      combineSteps += 1;
    } else {
      for (const c of st.components) containers += new Set(c.measures.map((m) => m.forDish)).size;
    }
  }
  return { containers, steps: n.steps.length, combineSteps };
}

function byPlan(tag: string): Map<string, ReturnType<typeof count>> {
  const out = new Map<string, ReturnType<typeof count>>();
  for (const f of readdirSync(OUT)) {
    if (!f.startsWith(`${tag}__`) || !f.endsWith("__narration-input.json")) continue;
    out.set(f.split("__")[1], count(join(OUT, f)));
  }
  return out;
}

const b = byPlan(BEFORE);
const a = byPlan(AFTER);
const shared = [...a.keys()].filter((k) => b.has(k)).sort();

console.log(`CONTAINERS — ${BEFORE} → ${AFTER}, over ${shared.length} plans present in both\n`);
console.log("  plan      containers      steps      combine-steps");
let cb = 0, ca = 0, sb = 0, sa = 0;
for (const k of shared) {
  const x = b.get(k)!, y = a.get(k)!;
  cb += x.containers; ca += y.containers; sb += x.steps; sa += y.steps;
  const d = (p: number, q: number) => `${String(p).padStart(3)} → ${String(q).padStart(3)}${q < p ? ` (−${p - q})` : q > p ? ` (+${q - p})` : "      "}`;
  console.log(`  ${k}  ${d(x.containers, y.containers)}   ${d(x.steps, y.steps)}   ${d(x.combineSteps, y.combineSteps)}`);
}
console.log(`\n  TOTAL     containers ${cb} → ${ca} (${ca - cb})     steps ${sb} → ${sa} (${sa - sb})`);
if (shared.length > 0) {
  console.log(`  per plan  ${(cb / shared.length).toFixed(1)} → ${(ca / shared.length).toFixed(1)} containers`);
}
