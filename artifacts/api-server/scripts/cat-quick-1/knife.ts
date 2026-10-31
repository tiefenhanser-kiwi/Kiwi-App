// CAT-QUICK-1 — knife work no step does: an ingredient whose note says it is cut ("thinly sliced",
// "minced") while no step of its dish names that food with a knife verb. The work is real but the
// clock never sees it. A budget could push it there, so batches are compared with the catalog.
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/knife.ts --gen <label> | --catalog
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { OUT, type GenRecord } from "./generate";

const CUT_NOTE = /\b(dic|minc|slic|chop|grat|shred|julienn|zest|peel|trim|halv|quarter|cub|crush|torn|tear)\w*/i;
const KNIFE_STEP = /\b(dice|mince|slice|chop|grate|shred|julienne|zest|peel|trim|halve|quarter|cube|cut|tear|crush|smash|core|seed|juice|squeeze)\w*/i;
// Bought pre-cut, or nothing to cut: not knife work.
const PRECUT = /\b(canned|jarred|bagged|pre-?\w+|frozen|shredded (?:cheese|mozzarella|cheddar)|store-bought|deli|ground)\b/i;

export interface Ing { name: string; note: string | null }
export interface KDish { ingredients: Ing[]; steps: string[] }

/** The cut ingredients of a dish that no step cuts (head word = the name's last word ≥3 letters). */
export function uncutIngredients(d: KDish): string[] {
  const out: string[] = [];
  for (const i of d.ingredients) {
    if (!i.note || !CUT_NOTE.test(i.note) || PRECUT.test(`${i.name} ${i.note}`)) continue;
    const words = i.name.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
    const head = (words[words.length - 1] ?? "").replace(/(es|s)$/, "");
    if (!head) continue;
    const cut = d.steps.some((s) => KNIFE_STEP.test(s) && s.toLowerCase().includes(head));
    if (!cut) out.push(`${i.name} (${i.note})`);
  }
  return out;
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
