// THX-3d round 3b (B) — EXPORT THE FIVE THANKSGIVING FEASTS' CATALOG CONTENT, read-only.
//
// Production's feasts are not dev's (dev's were hand-edited along the way), so the
// patch's one-pass proof starts from production's own content: this writes one JSON
// with everything patch.ts and the dumper read for the five thx2 feast targets
// (targets.json) — the meals, their dish links, the dishes, the dish ingredients and
// the ingredients they reference, and every instruction step with every column (amount
// refs, phases, parallel-group tags, durations, the path tags), the meals' and dishes'
// stamps and tags included. CATALOG CONTENT ONLY: no user, subscription, plan or email
// table is read, and an argument naming one is refused.
//
//   $env:DATABASE_URL = "<the branch's connection string>"
//   node --import tsx scripts/thx2/exportFeasts.ts --host <its hostname> --out scripts/_scratch/thx-3d/prod-feasts.json
//
// The database guard is assertScriptDatabase with --host as the exact-match override
// (dev needs none), so it runs against a Neon branch copy and nothing else. It writes
// nothing to the database. It prints the row count per table and nothing else.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase, PRODUCTION_HOST_ENV } from "../../src/lib/scripts/requireDatabaseHost";

const argv = process.argv.slice(2);
const FORBIDDEN = /\b(?:users?|subscriptions?|plans?|mealplan\w*|emails?|sessions?|payments?|stripe|revenuecat|guests?)\b/i;
const KNOWN = new Set(["--out", "--host"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FORBIDDEN.test(a.replace(/^--/, ""))) {
    console.error(`refusing: "${a}" — this export reads catalog content only (no user, subscription, plan or email tables)`);
    process.exit(2);
  }
  if (a.startsWith("--")) {
    if (!KNOWN.has(a)) { console.error(`refusing: unknown option ${a}`); process.exit(2); }
    i++;
  }
}
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = arg("--out");
const HOST = arg("--host");
if (!OUT) { console.error("usage: exportFeasts.ts --out <file> [--host <neon hostname>]"); process.exit(2); }

assertScriptDatabase("thx2/exportFeasts", HOST ? { ...process.env, [PRODUCTION_HOST_ENV]: HOST } : process.env);

const targets = (JSON.parse(readFileSync(new URL("./targets.json", import.meta.url), "utf8")) as { targets: { key: string; kind: string }[] }).targets
  .filter((t) => t.kind === "feast")
  .map((t) => t.key);

const prisma = new PrismaClient();
const meals = await prisma.meal.findMany({
  where: { sourceType: "batch_generated", dishFamilyKey: { in: targets }, isArchived: false },
  orderBy: { dishFamilyKey: "asc" },
});
const mealIds = meals.map((m) => m.id);
const dishLinks = await prisma.mealDishLink.findMany({ where: { mealId: { in: mealIds } }, orderBy: [{ mealId: "asc" }, { positionIndex: "asc" }] });
const dishIds = [...new Set(dishLinks.map((l) => l.dishId))];
const dishes = await prisma.dish.findMany({ where: { id: { in: dishIds } } });
const dishIngredients = await prisma.dishIngredient.findMany({ where: { dishId: { in: dishIds } }, orderBy: [{ dishId: "asc" }, { positionIndex: "asc" }] });
const ingredientIds = [...new Set(dishIngredients.map((i) => i.ingredientId))];
const ingredients = await prisma.ingredient.findMany({ where: { id: { in: ingredientIds } } });
const steps = await prisma.recipeInstructionStep.findMany({
  where: { OR: [{ ownerType: "dish", ownerId: { in: dishIds } }, { ownerType: "meal", ownerId: { in: mealIds } }] },
  orderBy: [{ ownerType: "asc" }, { ownerId: "asc" }, { stepIndex: "asc" }],
});
await prisma.$disconnect();

const out = {
  exportedAt: new Date().toISOString(),
  targets,
  meals,
  dishLinks,
  dishes,
  dishIngredients,
  ingredients,
  steps,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const [table, rows] of Object.entries({ meals, dishLinks, dishes, dishIngredients, ingredients, steps })) console.log(`${table} ${rows.length}`);
console.log(`total ${meals.length + dishLinks.length + dishes.length + dishIngredients.length + ingredients.length + steps.length}`);
