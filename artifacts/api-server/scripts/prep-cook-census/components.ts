// [prepcook] B2 Part A — D-WS9-296: can we derive a COMPONENT per dish ingredient?
//
// READ-ONLY. No writes, no AI, no cost. Measures only; the engine change is
// Part B and does not exist yet.
//
// THE QUESTION. `combinePrep` groups by `ingredientId`, so a marinade's five
// parts become five steps and five containers and nothing ever says they belong
// together. D-WS9-296 wants one named bowl per component. That needs a component
// key on each DISH INGREDIENT, and no column holds one — so it has to be derived
// from the dish's steps.
//
// THE FOUR SIGNALS, in precedence order:
//   1. `RecipeInstructionStep.componentKey` — the Block 3.7 swappable-component
//      tag (D-WS9-066). Measured on dev: 5,449 of 30,391 dish steps (17.9%), and
//      the values are real component names — marinade, glaze, rub, salsa, gravy,
//      tzatziki, remoulade, spice-blend. It was built for path selection, but it
//      names the thing.
//   2. A ROLE NOUN in the step's own prose ("…for the marinade", "whisk the
//      dressing"). The catalog's steps are written by a generator that names what
//      it is making.
//   3. The VERB GROUP — a combine/whisk/mix/stir-together step is one component
//      by construction, whatever it is called, so the step itself becomes the
//      component.
//
//   4. A NAME MATCH in a component step, for an ingredient whose AMOUNT is on a
//      different step. The commonest catalog shape: step 0 dices, step 1 combines
//      "the tomatoes, onion, jalapeño" with no amounts at all. Lowest precedence
//      and lowest precision — see the note at the loop.
//
// The link from a step to an INGREDIENT is `amountRefs` (BUG-003 Block 1):
// non-null on 98.3% of dish steps, each entry carrying an `ingredientId`.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/components.ts \
//     --plans b4aa6fee,31c7a885,…
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../../src/lib/prepCombineAdapter";
import { combinePrep } from "../../src/lib/prepCombineEngine";
import { buildStepPlan, formatMeasure } from "../../src/lib/prepWeekAssembly";

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: not the dev branch");
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PREFIXES = arg("plans").split(",").map((s) => s.trim()).filter(Boolean);

// ── signal 2: the role nouns a step names ───────────────────────────────────
//
// Ordered longest-first so "spice blend" wins over "blend" and "pico de gallo"
// over "pico". Each maps to the CANONICAL component word the bowl is named with.
const ROLE_NOUNS: ReadonlyArray<[RegExp, string]> = [
  [/\bspice (?:blend|mix|rub)\b/i, "spice blend"],
  [/\bseasoning (?:blend|mix|rub)\b/i, "spice blend"],
  [/\bpico de gallo\b/i, "pico de gallo"],
  // Bare "pico" too: the Pico de Gallo dish's own steps say "let the PICO sit",
  // and without this its combine step falls through to the numbered fallback and
  // the bowl reads "Pico de Gallo bowl 1" — a number where a name was available.
  [/\bpico\b/i, "pico de gallo"],
  [/\bcompound butter\b/i, "compound butter"],
  [/\bteriyaki (?:glaze|sauce)\b/i, "glaze"],
  [/\bmarinade\b/i, "marinade"],
  [/\bvinaigrette\b/i, "vinaigrette"],
  [/\bdressing\b/i, "dressing"],
  [/\bchimichurri\b/i, "chimichurri"],
  [/\bremoulade\b/i, "remoulade"],
  [/\btzatziki\b/i, "tzatziki"],
  [/\bglaze\b/i, "glaze"],
  [/\bgravy\b/i, "gravy"],
  [/\bsalsa\b/i, "salsa"],
  [/\bcrema\b/i, "crema"],
  [/\baioli\b/i, "aioli"],
  [/\bslaw\b/i, "slaw"],
  [/\bbrine\b/i, "brine"],
  [/\bbatter\b/i, "batter"],
  [/\bbreading\b/i, "breading"],
  [/\bfilling\b/i, "filling"],
  [/\bstuffing\b/i, "stuffing"],
  [/\brelish\b/i, "relish"],
  [/\bguacamole\b/i, "guacamole"],
  [/\bpesto\b/i, "pesto"],
  [/\brub\b/i, "rub"],
  [/\bsauce\b/i, "sauce"],
  [/\bblend\b/i, "spice blend"],
  [/\bgarnish\b/i, "garnish"],
  [/\btopping\b/i, "topping"],
];

/** A step that COMBINES is one component by construction (signal 3). */
const COMBINE_VERB =
  /\b(whisk(?:\s+together)?|stir\s+together|combine|mix(?:\s+together)?|toss\s+together|blend\s+together|mash\s+together|fold\s+together)\b/i;

/** `componentKey` tokens that name no component — they name the FOOD, not the mixture. */
const NON_COMPONENT_KEYS = new Set([
  "chicken", "bacon", "mushrooms", "veggies", "fries", "cured-pork",
  "tortilla-strips", "croutons", "pickle",
]);

/** componentKey → the canonical component word. */
function normaliseComponentKey(key: string): string | null {
  const k = key.toLowerCase().replace(/[-_]+/g, " ").trim();
  if (NON_COMPONENT_KEYS.has(key.toLowerCase())) return null;
  for (const [re, word] of ROLE_NOUNS) if (re.test(k)) return word;
  // A key that names nothing in the table is still a component NAME; keep it.
  return k;
}

interface DerivedComponent {
  /** Canonical component word ("marinade") or a synthetic `step N` label. */
  component: string;
  /** Which of the three signals produced it — for the coverage report. */
  signal: "componentKey" | "roleNoun" | "verbGroup" | "nameMatch";
  stepIndexes: number[];
}

/** Derive component → ingredientIds for ONE dish, from its steps. */
function deriveForDish(
  steps: { stepIndex: number; text: string; componentKey: string | null; ingredientIds: string[] }[],
  ingredientNames: { ingredientId: string; ingredientName: string }[] = [],
): { byIngredient: Map<string, DerivedComponent[]>; components: Map<string, DerivedComponent> } {
  const components = new Map<string, DerivedComponent>();
  const byIngredient = new Map<string, DerivedComponent[]>();

  for (const st of steps) {
    if (st.ingredientIds.length === 0) continue;
    let name: string | null = null;
    let signal: DerivedComponent["signal"] = "componentKey";
    if (st.componentKey) name = normaliseComponentKey(st.componentKey);
    if (name === null) {
      for (const [re, word] of ROLE_NOUNS) {
        if (re.test(st.text)) { name = word; signal = "roleNoun"; break; }
      }
    }
    if (name === null && COMBINE_VERB.test(st.text)) {
      // ── LOOK AHEAD ONE OR TWO STEPS, and the carne asada is why ────────────
      //
      // "In a bowl, whisk together ¼ cup orange juice, 3 tbsp lime juice, 4 garlic
      // cloves…" names nothing. The NEXT step says "pour the MARINADE over it".
      // The step that MAKES a mixture routinely does not name it; the step that
      // USES it does. Without this the carne asada marinade splits in two — a
      // nameless "bowl 1" holding the whole mixture and a "marinade" holding
      // nothing — which is the defect D-WS9-296 exists to remove, reproduced by
      // the derivation itself.
      const idx = steps.indexOf(st);
      for (const ahead of steps.slice(idx + 1, idx + 3)) {
        for (const [re, word] of ROLE_NOUNS) {
          if (re.test(ahead.text)) { name = word; signal = "roleNoun"; break; }
        }
        if (name !== null) break;
      }
      if (name === null) {
        // Signal 3 proper: the step IS the component. Keyed on its index so two
        // combine steps in one dish are two components, the honest reading.
        name = `step ${st.stepIndex + 1}`;
        signal = "verbGroup";
      }
    }
    if (name === null) continue; // no signal — this step names no component
    let c = components.get(name);
    if (!c) { c = { component: name, signal, stepIndexes: [] }; components.set(name, c); }
    c.stepIndexes.push(st.stepIndex);
    for (const id of st.ingredientIds) {
      const list = byIngredient.get(id) ?? [];
      if (!list.includes(c)) list.push(c);
      byIngredient.set(id, list);
    }
  }
  // ── SIGNAL 4 — THE NAME, WHEN THE AMOUNT IS ON ANOTHER STEP ────────────────
  //
  // The Pico de Gallo is the case, and it is the commonest shape in the catalog:
  //
  //   #0  "Dice 3 roma tomatoes, finely dice ½ white onion, seed and mince 1
  //        jalapeño…"                        — 4 amountRefs, names no component
  //   #1  "Combine THE TOMATOES, ONION, JALAPEÑO, and cilantro in a bowl, then
  //        squeeze in the juice of 1 lime"   — IS the component, 2 amountRefs
  //
  // The combine step names its parts with no amount ("the tomatoes"), and
  // `amountRefs` only spans amounts — so the four ingredients that MAKE the pico
  // were uncovered while the lime alone got the bowl. An ingredient belongs where
  // it ENDS UP, not where it was cut, so the last resort is a plain name match
  // against each component's step text.
  //
  // Matched on the HEAD NOUN ("roma tomatoes" → "tomatoes") with an optional
  // plural, because a step writes "the tomatoes" where the catalog row says
  // "roma tomatoes". Deliberately the LOWEST-precedence signal: an amountRef is
  // a span the generator computed, a name is a string that happens to appear.
  for (const { ingredientId, ingredientName } of ingredientNames) {
    if (byIngredient.has(ingredientId)) continue;
    // An ingredient name can end in a parenthetical or a comma clause
    // ("rotisserie chicken, meat shredded)"), so the head noun is stripped to
    // letters and hyphens before it becomes part of a pattern. A name whose head
    // survives as nothing is skipped rather than compiled into a broken regex.
    // ⚠️ NON-ASCII LETTERS MUST SURVIVE. A first version stripped to [a-z-] and
    // turned "jalapeño" into "jalape", which then matched nothing — so the pico's
    // jalapeño stayed in a container of its own while its tomatoes, onion and
    // cilantro moved into the bowl. Punctuation and digits go; letters stay.
    const head = (ingredientName.toLowerCase().trim().split(/\s+/).pop() ?? "")
      .replace(/[^\p{L}-]/gu, "");
    if (head.length < 4) continue; // too short to match safely ("oil", "egg")
    const singular = head.replace(/(?:es|s)$/, "");
    const re = new RegExp(`\\b${singular}(?:e?s)?\\b`, "i");
    for (const c of components.values()) {
      const texts = c.stepIndexes.map((i) => steps.find((x) => x.stepIndex === i)?.text ?? "");
      if (texts.some((t) => re.test(t))) {
        byIngredient.set(ingredientId, [{ ...c, signal: "nameMatch" }]);
        break;
      }
    }
  }
  return { byIngredient, components };
}

// ── bowl naming ─────────────────────────────────────────────────────────────
//
// `{dish short name} {component} {vessel}`. The vessel is chosen by the
// component's own nature: a jar for something poured, a bag for a marinating
// protein, a bowl otherwise. Sentence case, because it is read mid-sentence
// ("Add these to the Carne asada marinade bowl").
const JAR_COMPONENTS = new Set(["glaze", "dressing", "vinaigrette", "sauce", "crema", "aioli", "remoulade"]);
// ⚠️ NOT the marinade. It is WHISKED in a bowl and Hans's own wording is "Carne
// asada marinade bowl"; the zip-top bag is where the protein meets it on cook day,
// which is D-WS9-298 item 4, not what this vessel names.
const BAG_COMPONENTS = new Set<string>([]);

/** Trim a dish title to the few words a bowl label can carry. */
function shortDishName(title: string): string {
  // Drop the "with …" tail and any parenthetical: catalog titles are long
  // ("Spinach and Ricotta Stuffed Portobello Mushrooms with Roasted Cherry…").
  let t = title.split(/\s+with\s+/i)[0].replace(/\([^)]*\)/g, "").trim();
  const words = t.split(/\s+/);
  if (words.length > 4) t = words.slice(0, 4).join(" ");
  return t;
}

function bowlName(dishTitle: string, component: string, ordinal: number): string {
  const dish = shortDishName(dishTitle);
  if (component.startsWith("step ")) {
    // No name to use — D-WS9-296's fallback is a number.
    return `${dish} bowl ${ordinal}`;
  }
  const vessel = JAR_COMPONENTS.has(component) ? "jar" : BAG_COMPONENTS.has(component) ? "bag" : "bowl";
  // ── THE STUTTER, when the dish IS the component ─────────────────────────────
  //
  // "Pico de Gallo pico de gallo bowl". "Velvety Nacho Cheese Sauce sauce jar".
  // "Seasoned Ground Beef Filling filling bowl". A dish whose own title already
  // names the mixture does not need it twice, so the component word is dropped
  // when the dish name already contains it.
  if (new RegExp(`\\b${component.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(dish)) {
    return `${dish} ${vessel}`;
  }
  // "Fajita spice blend" already reads as a thing; a trailing "bowl" on a dry
  // blend is noise, so a spice blend keeps its own noun.
  if (component === "spice blend") return `${dish} spice blend`;
  return `${dish} ${component} ${vessel}`;
}

// ── main ────────────────────────────────────────────────────────────────────

interface PlanReport {
  planId: string;
  planName: string;
  mealCount: number;
  prepIngredients: number;
  covered: number;
  bySignal: Record<string, number>;
  componentsPerDish: number[];
  multiComponentIngredients: number;
  vesselsCurrent: number;
  vessels: number;
  bowls: string[];
}

async function main() {
  const reports: PlanReport[] = [];
  const allBowls: { plan: string; dish: string; component: string; signal: string; name: string }[] = [];
  const sequences: Record<string, string[]> = {};

  for (const prefix of PREFIXES) {
    const rows = await prisma.mealPlanInstance.findMany({ where: { id: { startsWith: prefix } }, select: { id: true, userId: true } });
    if (rows.length !== 1) { console.error(`${prefix}: ${rows.length} matches, skipped`); continue; }
    const { input } = await loadPrepWeekInput({ planId: rows[0].id, userId: rows[0].userId, prisma });
    const combined = combinePrep(buildPrepCombineInput(input));

    // Every dish id the plan touches, and its steps with amountRefs resolved.
    const dishIds = input.meals.flatMap((m) => m.dishes.map((d) => d.dishId));
    const stepRows = await prisma.recipeInstructionStep.findMany({
      where: { ownerType: "dish", ownerId: { in: dishIds } },
      orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
      select: { ownerId: true, stepIndex: true, stepTextTranslated: true, componentKey: true, amountRefs: true },
    });
    const stepsByDish = new Map<string, { stepIndex: number; text: string; componentKey: string | null; ingredientIds: string[] }[]>();
    for (const r of stepRows) {
      const refs = Array.isArray(r.amountRefs) ? (r.amountRefs as { ingredientId?: string }[]) : [];
      const ids = [...new Set(refs.map((x) => x.ingredientId).filter((x): x is string => !!x))];
      const list = stepsByDish.get(r.ownerId) ?? [];
      list.push({ stepIndex: r.stepIndex, text: r.stepTextTranslated, componentKey: r.componentKey, ingredientIds: ids });
      stepsByDish.set(r.ownerId, list);
    }

    // The ingredients that actually REACH Prep the Week (include + uncertain).
    const prepIds = new Set(
      combined.phases.flatMap((p) => p.entries.map((e) => e.ingredientId)),
    );
    // The engine's own phase per ingredient — the current shape's vessel depends
    // on it, and re-deriving it here would be a second copy of assignPhase.
    const phaseByIngredientId = new Map<string, string>();
    for (const ph of combined.phases) {
      for (const e of ph.entries) phaseByIngredientId.set(e.ingredientId, ph.phase);
    }

    const dishTitleById = new Map<string, string>();
    for (const m of input.meals) for (const d of m.dishes) dishTitleById.set(d.dishId, d.dishName);

    let covered = 0;
    let prepIngredientPairs = 0;
    let multiComponent = 0;
    const bySignal: Record<string, number> = {};
    const componentsPerDish: number[] = [];
    // ── TWO VESSEL COUNTS FROM ONE ITERATION ─────────────────────────────────
    //
    // ⚠️ 463 vs B1's 387 IS NOT A COMPARISON. B1's containers.ts counts over the
    // NARRATION steps; a first pass here counted over dish ingredients, and the
    // two denominators differ (an ingredient shared by three dishes is one
    // narration step and three dish-ingredients). So both shapes are counted here,
    // over the same walk, with the same key function:
    //
    //   CURRENT   the vessel the engine emits today — one per (dish, ingredient)
    //             for produce/proteins, one per (dish, phase) for the blend and
    //             the sauce steps, which are per-dish mixtures.
    //   COMPONENT the same, except a COVERED ingredient keys on its component
    //             instead of itself, so a marinade's five parts share one bowl.
    const vesselCurrent = new Set<string>();
    const vesselComponent = new Set<string>();

    for (const meal of input.meals) {
      for (const dish of meal.dishes) {
        const steps = stepsByDish.get(dish.dishId) ?? [];
        const { byIngredient, components } = deriveForDish(steps, dish.ingredients.map((i) => ({ ingredientId: i.ingredientId, ingredientName: i.ingredientName })));
        componentsPerDish.push(components.size);

        let ordinal = 0;
        const ordinalOf = new Map<string, number>();
        for (const name of components.keys()) ordinalOf.set(name, ++ordinal);
        for (const [name, c] of components) {
          const label = bowlName(dish.dishName, name, ordinalOf.get(name)!);
          allBowls.push({ plan: rows[0].id.slice(0, 8), dish: dish.dishName, component: name, signal: c.signal, name: label });
        }

        for (const ing of dish.ingredients) {
          if (!prepIds.has(ing.ingredientId)) continue;
          prepIngredientPairs += 1;
          // The vessel today: a per-dish mixture for the two mixture phases,
          // otherwise the ingredient's own container.
          const phase = phaseByIngredientId.get(ing.ingredientId);
          const currentKey =
            phase === "seasonings_dry" || phase === "sauces_marinades"
              ? `${dish.dishId}|${phase}`
              : `${dish.dishId}|${ing.ingredientId}`;
          vesselCurrent.add(currentKey);

          const hit = byIngredient.get(ing.ingredientId);
          if (!hit || hit.length === 0) {
            // Uncovered: it keeps the vessel it has today.
            vesselComponent.add(currentKey);
            continue;
          }
          covered += 1;
          bySignal[hit[0].signal] = (bySignal[hit[0].signal] ?? 0) + 1;
          if (hit.length > 1) multiComponent += 1;
          vesselComponent.add(`${dish.dishId}|${hit[0].component}`);
        }
      }
    }

    reports.push({
      planId: rows[0].id.slice(0, 8),
      planName: input.planName,
      mealCount: input.meals.length,
      prepIngredients: prepIngredientPairs,
      covered,
      bySignal,
      componentsPerDish,
      multiComponentIngredients: multiComponent,
      vesselsCurrent: vesselCurrent.size,
      vessels: vesselComponent.size,
      bowls: [],
    });

    // ── the two named sequences, for the report ──────────────────────────────
    for (const meal of input.meals) {
      if (!/Carne Asada Tacos|Teriyaki Salmon/i.test(meal.mealName)) continue;
      const lines: string[] = [];
      const plan = buildStepPlan(combined, input.planName, new Map());
      // Group this meal's prep measures by (dish, component) — the shape Part B
      // would emit — and render each as its bowl.
      const buckets = new Map<string, { label: string; lines: string[] }>();
      for (const step of plan.steps) {
        for (const comp of step.components) {
          for (const m of comp.measures) {
            const dish = meal.dishes.find((d) => d.dishName === m.forDish);
            if (!dish) continue;
            const steps = stepsByDish.get(dish.dishId) ?? [];
            const { byIngredient, components } = deriveForDish(steps, dish.ingredients.map((i) => ({ ingredientId: i.ingredientId, ingredientName: i.ingredientName })));
            const ing = dish.ingredients.find((i) => i.ingredientName === comp.ingredientName);
            const hit = ing ? byIngredient.get(ing.ingredientId) : undefined;
            let label: string;
            if (hit && hit.length > 0) {
              let ord = 0;
              const ordinalOf = new Map<string, number>();
              for (const n of components.keys()) ordinalOf.set(n, ++ord);
              label = bowlName(dish.dishName, hit[0].component, ordinalOf.get(hit[0].component)!);
            } else {
              label = `${shortDishName(dish.dishName)} — ${comp.ingredientName} (its own container)`;
            }
            const b = buckets.get(label) ?? { label, lines: [] };
            b.lines.push(`${m.amount} ${comp.ingredientName}${m.preparationNote ? `, ${m.preparationNote}` : ""}${m.fromSource ? `  [from ${m.fromSource}]` : ""}  ·  ${step.phase}`);
            buckets.set(label, b);
          }
        }
      }
      lines.push(`── ${meal.mealName} ──`);
      for (const b of buckets.values()) {
        lines.push(`  ${b.label}`);
        for (const l of b.lines) lines.push(`      ${l}`);
      }
      sequences[meal.mealName] = lines;
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const L: string[] = [];
  const totPrep = reports.reduce((s, r) => s + r.prepIngredients, 0);
  const totCov = reports.reduce((s, r) => s + r.covered, 0);
  const allPerDish = reports.flatMap((r) => r.componentsPerDish).sort((a, b) => a - b);
  const sig: Record<string, number> = {};
  for (const r of reports) for (const [k, v] of Object.entries(r.bySignal)) sig[k] = (sig[k] ?? 0) + v;

  L.push(`D-WS9-296 PART A — component coverage over ${reports.length} plans`);
  L.push("");
  L.push(`  prep-reaching dish ingredients: ${totPrep}`);
  L.push(`  with a component key:           ${totCov}  (${((100 * totCov) / Math.max(1, totPrep)).toFixed(1)}%)`);
  L.push(`  by signal:                      ${Object.entries(sig).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push(`  components per dish:            median ${allPerDish[Math.floor(allPerDish.length / 2)]}, max ${allPerDish.at(-1)}, dishes with 0: ${allPerDish.filter((n) => n === 0).length}/${allPerDish.length}`);
  L.push(`  ingredients in >1 component:    ${reports.reduce((s, r) => s + r.multiComponentIngredients, 0)}`);
  L.push("");
  L.push("  per plan:");
  L.push("   plan      meals  prep-ings  covered   vessels now → component");
  for (const r of reports) {
    const d = r.vessels - r.vesselsCurrent;
    L.push(
      `   ${r.planId}  ${String(r.mealCount).padStart(5)}  ${String(r.prepIngredients).padStart(9)}  ${String(r.covered).padStart(7)}   ${String(r.vesselsCurrent).padStart(7)} → ${String(r.vessels).padStart(3)}${d < 0 ? `  (${d})` : d > 0 ? `  (+${d})` : ""}`,
    );
  }
  const vc = reports.reduce((s, r) => s + r.vesselsCurrent, 0);
  const vn = reports.reduce((s, r) => s + r.vessels, 0);
  L.push(
    `   TOTAL vessels: ${vc} now → ${vn} under the component shape (${vn - vc}, ${Math.round((100 * (vc - vn)) / Math.max(1, vc))}% fewer)`,
  );
  L.push("");
  L.push("── BOWL NAMES ─────────────────────────────────────────────────────");
  const seen = new Set<string>();
  const picked: typeof allBowls = [];
  // Every carne asada and teriyaki component first, then a spread of the rest.
  for (const b of allBowls) {
    if (!/carne asada|teriyaki/i.test(b.dish)) continue;
    if (seen.has(b.name)) continue;
    seen.add(b.name); picked.push(b);
  }
  for (const b of allBowls) {
    if (picked.length >= 24) break;
    if (seen.has(b.name)) continue;
    seen.add(b.name); picked.push(b);
  }
  for (const b of picked) L.push(`  ${b.name.padEnd(52)} [${b.signal}]  ← ${b.dish.slice(0, 40)}`);
  L.push("");
  for (const [, lines] of Object.entries(sequences)) { L.push(...lines); L.push(""); }

  const text = L.join("\n");
  writeFileSync(join(OUT, "components.txt"), text);
  writeFileSync(join(OUT, "components.json"), JSON.stringify({ reports, bowls: allBowls, sequences }, null, 2));
  console.log(text);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
