// CAT-QUICK-1 — knife work no step does: an ingredient whose note says it is cut ("thinly sliced",
// "minced") while no step of its dish names that food with a knife verb. The work is real but the
// clock never sees it. A budget could push it there, so batches are compared with the catalog.
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/knife.ts --gen <label> | --catalog
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import type { GenRecord } from "./generate";

const OUT = "scripts/output/cat-quick-1"; // generate.ts imports this module: no value import back

const CUT_NOTE = /\b(chopped|minced|diced|sliced|grated|shredded|julienned|zested|zest|peeled|trimmed|halved|quartered|cubed|crushed|torn|cut|pitted|cored|seeded)\b/i;
// Seconds of work at the table, not knife time: a garnish torn, grated or shaved over the plate.
const FINISHING = (note: string) => /\b(torn|grated|shaved|wedges)\b/i.test(note) && /\b(serv|garnish|finish|topping)/i.test(note);
// The form the cook buys, not a cut: shrimp sold "peeled and deveined".
const BOUGHT_FORM = (name: string, note: string) => /\b(shrimp|prawns?)\b/i.test(name) && /\bpeeled and deveined\b/i.test(note);
// The cut as an instruction, not a description: a clause that opens with a knife verb ("Slice the
// onions", "…, then mince the garlic", "zest and juice the lemon") — "add the thinly sliced onions"
// describes a cut, it does not do one. Clauses split on sentences and commas only, so a verb pair
// ("dice the onion and mince the garlic") stays one clause.
const KNIFE_CLAUSE = /^(?:(?:and|then)\s+)*(?:finely |thinly |roughly |coarsely |lightly )?(dice|mince|slice|chop|grate|shred|julienne|zest|peel|trim|halve|quarter|cube|cut|tear|crush|smash|core|seed|pit|butterfly|pound)\b/i;
const CLAUSE_SPLIT = /[.;:!]\s*|,\s*/;
// Bought pre-cut, or nothing to cut: not knife work.
const PRECUT = /\b(canned|jarred|bagged|pre-?\w+|frozen|shredded (?:cheese|mozzarella|cheddar)|store-bought|deli|ground)\b/i;
// Words in an ingredient name that do not name the food.
const GENERIC = new Set(["fresh", "large", "small", "medium", "each", "whole", "cloves", "clove", "leaves", "leaf", "boneless", "skinless", "extra", "virgin", "unsalted", "salted", "dried", "sweet", "yellow", "white", "green", "red", "flat", "italian", "english", "baby", "ripe", "firm", "hearts", "fillets", "loaf"]);

export interface Ing { name: string; note: string | null }
export interface KDish { ingredients: Ing[]; steps: string[] }

/** The cut ingredients of a dish that no step cuts: a step that opens a clause with a knife verb and names the food. */
export function uncutIngredients(d: KDish): string[] {
  const out: string[] = [];
  for (const i of d.ingredients) {
    if (!i.note || !CUT_NOTE.test(i.note) || FINISHING(i.note) || BOUGHT_FORM(i.name, i.note) || PRECUT.test(`${i.name} ${i.note}`)) continue;
    const words = i.name.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w)).map((w) => w.replace(/(es|s)$/, ""));
    if (!words.length) continue;
    // A knife clause cuts what it names; "halve them" cuts what the sentence named before it.
    const cut = d.steps.some((s) => s.split(/(?<=[.;!])\s+/).some((sentence) => {
      const clauses = sentence.split(CLAUSE_SPLIT);
      return clauses.some((c, k) => {
        if (!KNIFE_CLAUSE.test(c.trim())) return false;
        const scope = /\b(them|it)\b/i.test(c) ? clauses.slice(0, k + 1).join(" ") : c;
        return words.some((w) => scope.toLowerCase().includes(w));
      });
    }));
    if (!cut) out.push(`${i.name} (${i.note})`);
  }
  return out;
}

/** A generated payload's uncut ingredients, default path only. */
export function uncutInPayload(p: { dishes: Array<{ kind: string; ingredients?: { name: string; preparationNote?: string | null }[]; steps?: { text: string; pathKey?: string | null }[] }> }): string[] {
  return p.dishes.flatMap((d) => d.kind !== "new" ? [] : uncutIngredients({
    ingredients: (d.ingredients ?? []).map((i) => ({ name: i.name, note: i.preparationNote ?? null })),
    steps: (d.steps ?? []).filter((s) => s.pathKey !== "bought").map((s) => s.text),
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const gen = argv[argv.indexOf("--gen") + 1];
  let meals: { title: string; dishes: KDish[] }[];
  if (argv.includes("--gen")) {
    const recs = JSON.parse(readFileSync(join(OUT, gen, "gen.json"), "utf8")) as GenRecord[];
    meals = recs.map((r) => ({ title: `#${r.n} ${r.title}`, dishes: r.payload.dishes.flatMap((d) => d.kind !== "new" ? [] : [{ ingredients: d.ingredients.map((i) => ({ name: i.name, note: i.preparationNote ?? null })), steps: d.steps.filter((s) => s.pathKey !== "bought").map((s) => s.text) }]) }));
  } else {
    const { mode } = assertScriptDatabase("cat-quick-1/knife");
    if (mode !== "dev") throw new Error("dev only");
    const prisma = new PrismaClient();
    const rows = await prisma.meal.findMany({
      where: argv.includes("--keys") ? { dishFamilyKey: { startsWith: argv[argv.indexOf("--keys") + 1] }, isArchived: false } : { userId: null, isArchived: false, isPublic: true, activeTimeMinutes: { not: null } },
      select: { title: true, estimatedTimeMinutes: true, dishLinks: { select: { dishId: true, dish: { select: { dishIngredients: { select: { preparationNote: true, pathKey: true, ingredient: { select: { displayName: true } } } } } } } } },
    });
    const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: rows.flatMap((m) => m.dishLinks.map((l) => l.dishId)) }, OR: [{ pathKey: null }, { pathKey: { not: "bought" } }] }, select: { ownerId: true, stepTextTranslated: true } });
    await prisma.$disconnect();
    const by = new Map<string, string[]>();
    for (const s of steps) by.set(s.ownerId, [...(by.get(s.ownerId) ?? []), s.stepTextTranslated]);
    const quick = argv.includes("--quick");
    meals = rows.filter((m) => !quick || m.estimatedTimeMinutes <= 30).map((m) => ({ title: m.title, dishes: m.dishLinks.map((l) => ({ ingredients: l.dish.dishIngredients.filter((i) => i.pathKey !== "bought").map((i) => ({ name: i.ingredient.displayName, note: i.preparationNote })), steps: by.get(l.dishId) ?? [] })) }));
  }
  const per = meals.map((m) => ({ title: m.title, uncut: m.dishes.flatMap(uncutIngredients) }));
  const withAny = per.filter((p) => p.uncut.length > 0);
  const total = per.reduce((a, p) => a + p.uncut.length, 0);
  console.log(`${meals.length} meals · with uncut knife work ${withAny.length} (${((100 * withAny.length) / Math.max(1, meals.length)).toFixed(0)}%) · uncut ingredients/meal ${(total / Math.max(1, meals.length)).toFixed(2)}`);
  if (argv.includes("--list")) for (const p of withAny) console.log(`  ${p.title.slice(0, 70)}: ${p.uncut.join("; ")}`);
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("cat-quick-1/knife.ts")) main().catch((e) => { console.error(e); process.exit(1); });
