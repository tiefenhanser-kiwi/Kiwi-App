// [prepcook] Part I — the SHAPE probe. Read-only, no AI.
//
// Tags every meal with the Part I shapes (seafood, cold dishes, toss-without-heat,
// long passive windows, single/multi-dish, bought paths, marinades, aromatics, two
// cuts of one food) so the corpus is chosen for shape, not for whatever was lying
// around. Exported so `corpus.ts` and the checker read ONE definition.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/shapes.ts --catalog
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/shapes.ts --plans <ids>
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

export const SHAPES = [
  "seafood", "cold", "toss-no-heat", "long-passive", "single-dish", "multi-3plus",
  "bought-path", "marinate", "aromatics", "two-cuts",
] as const;
export type Shape = (typeof SHAPES)[number];

const SEAFOOD = /\b(shrimp|prawns?|salmon|cod|tilapia|halibut|mahi|haddock|pollock|white fish|whitefish|snapper|sea bass|scallops?|tuna steaks?|catfish|trout|swordfish)\b/i;
const COLD_TITLE = /\b(slaw|pico|salsa|chopped salad|tuna salad|chicken salad|crema|guacamole|cucumber salad|tzatziki|raita)\b/i;
const HEAT = /\b(bak\w*|roast\w*|grill\w*|boil\w*|simmer\w*|braise\w*|steam\w*|sear\w*|saut\w*|fry\w*|fried|cook\w*|smok\w*|broil\w*|poach\w*|toast\w*|heat\w*|oven|skillet)\b/i;
const LONG = /\b(slow cooker|crock ?pot|smoker|smoke[ds]?\b|braise|braising|dutch oven|rise|proof|knead|dough|cornbread|bread|focaccia|biscuits?)\b/i;
const MARINATE = /\bmarinat\w*\b[^.]*\b(overnight|hours?|minutes?|\d+\s*(?:h|hr))\b|\b(overnight|hours?)\b[^.]*\bmarinat/i;
const CHILE = /\b(jalape[nñ]o|serrano|fresno|habanero|thai chil(?:e|i)|poblano|bird'?s eye)\b/i;

export interface MealShape {
  mealId: string;
  title: string;
  isPublic: boolean;
  userId: string | null;
  dishCount: number;
  shapes: Shape[];
  evidence: Partial<Record<Shape, string>>;
}

type Loaded = Awaited<ReturnType<typeof loadMeals>>[number];

async function loadMeals(prisma: PrismaClient, where: object) {
  return prisma.meal.findMany({
    where,
    select: {
      id: true, title: true, isPublic: true, userId: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: {
          dish: {
            select: {
              id: true, title: true,
              dishIngredients: {
                select: { preparationNote: true, pathKey: true, componentKey: true, ingredient: { select: { displayName: true } } },
              },
            },
          },
        },
      },
    },
  });
}

export async function shapeMeals(prisma: PrismaClient, meals: Loaded[]): Promise<MealShape[]> {
  const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dish.id));
  const mealIds = meals.map((m) => m.id);
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { OR: [{ ownerType: "dish", ownerId: { in: dishIds } }, { ownerType: "meal", ownerId: { in: mealIds } }] },
    select: { ownerId: true, stepIndex: true, stepTextRaw: true, phaseType: true, pathKey: true },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
  });
  const stepsByOwner = new Map<string, typeof steps>();
  for (const s of steps) {
    const l = stepsByOwner.get(s.ownerId) ?? [];
    l.push(s);
    stepsByOwner.set(s.ownerId, l);
  }

  return meals.map((m) => {
    const ev: Partial<Record<Shape, string>> = {};
    const tag = (k: Shape, why: string) => { if (!ev[k]) ev[k] = why.slice(0, 140); };
    if (m.dishLinks.length === 1) tag("single-dish", "1 dish");
    if (m.dishLinks.length >= 3) tag("multi-3plus", `${m.dishLinks.length} dishes`);
    const mealSteps = stepsByOwner.get(m.id) ?? [];
    const prepNotesByName = new Map<string, Set<string>>();
    for (const { dish } of m.dishLinks) {
      const ds = [...(stepsByOwner.get(dish.id) ?? []), ...mealSteps];
      const names = dish.dishIngredients.map((i) => i.ingredient.displayName);
      const seafood = names.find((n) => SEAFOOD.test(n));
      if (seafood) tag("seafood", `${dish.title}: ${seafood}`);
      if (COLD_TITLE.test(dish.title)) tag("cold", dish.title);
      const anyHeat = ds.some((s) => HEAT.test(s.stepTextRaw));
      const toss = ds.find((s) => /^\s*toss\b/i.test(s.stepTextRaw) && !HEAT.test(s.stepTextRaw));
      if (anyHeat && toss) tag("toss-no-heat", `${dish.title}: "${toss.stepTextRaw}"`);
      const long = ds.find((s) => LONG.test(s.stepTextRaw)) ?? (LONG.test(dish.title) ? { stepTextRaw: dish.title } : undefined);
      if (long) tag("long-passive", `${dish.title}: "${long.stepTextRaw}"`);
      const bought = dish.dishIngredients.find((i) => i.pathKey === "bought") ??
        dish.dishIngredients.find((i) => /\b(slaw mix|coleslaw mix|rotisserie|store-bought|pre-?made|jarred)\b/i.test(i.ingredient.displayName));
      if (bought) tag("bought-path", `${dish.title}: ${bought.ingredient.displayName}${bought.pathKey ? ` [${bought.componentKey}/${bought.pathKey}]` : ""}`);
      const mar = ds.find((s) => MARINATE.test(s.stepTextRaw));
      if (mar) tag("marinate", `${dish.title}: "${mar.stepTextRaw}"`);
      // aromatics: garlic added after the onion in one step order; ginger/scallion; fresh chile
      const onionAt = ds.findIndex((s) => /\bonions?\b/i.test(s.stepTextRaw) && HEAT.test(s.stepTextRaw));
      const garlicAt = ds.findIndex((s, i) => i > onionAt && onionAt >= 0 && /\bgarlic\b/i.test(s.stepTextRaw) && !/\bonions?\b/i.test(s.stepTextRaw));
      if (onionAt >= 0 && garlicAt > onionAt) tag("aromatics", `${dish.title}: garlic at step ${garlicAt} after onion at ${onionAt}`);
      const arom = names.find((n) => /\b(ginger|scallions?|green onions?)\b/i.test(n) && !/ground ginger|powder/i.test(n)) ?? names.find((n) => CHILE.test(n) && !/dried|powder|flakes|chipotle|canned/i.test(n));
      if (arom) tag("aromatics", `${dish.title}: ${arom}`);
      for (const i of dish.dishIngredients) {
        const base = i.ingredient.displayName.toLowerCase().replace(/\b(juice|zest|wedges?)\b/g, "").trim();
        const form = `${/juice/i.test(i.ingredient.displayName) ? "juice " : ""}${/zest/i.test(i.ingredient.displayName) ? "zest " : ""}${(i.preparationNote ?? "").toLowerCase()}`.trim();
        const s = prepNotesByName.get(base) ?? new Set<string>();
        s.add(form);
        prepNotesByName.set(base, s);
      }
    }
    for (const [base, forms] of prepNotesByName) {
      if (forms.size >= 2 && /\b(onion|lemon|lime|orange|garlic|cilantro|pepper|tomato|carrot|cabbage)\b/.test(base)) {
        tag("two-cuts", `${base}: ${[...forms].map((f) => `"${f || "(none)"}"`).join(" + ")}`);
        break;
      }
    }
    return {
      mealId: m.id, title: m.title, isPublic: m.isPublic, userId: m.userId,
      dishCount: m.dishLinks.length,
      shapes: SHAPES.filter((k) => ev[k]),
      evidence: ev,
    };
  });
}

async function main() {
  const prisma = new PrismaClient();
  if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
  const HERE = dirname(fileURLToPath(import.meta.url));
  try {
    if (process.argv.includes("--catalog")) {
      const meals = await loadMeals(prisma, { isPublic: true, isArchived: false, userId: null });
      const shaped = await shapeMeals(prisma, meals);
      writeFileSync(join(HERE, "out", "catalog-shapes.json"), JSON.stringify(shaped, null, 2));
      console.log(`${shaped.length} public catalog meals`);
      for (const k of SHAPES) console.log(`  ${k.padEnd(14)} ${shaped.filter((s) => s.shapes.includes(k)).length}`);
    }
    const i = process.argv.indexOf("--plans");
    if (i >= 0) {
      for (const prefix of process.argv[i + 1].split(",")) {
        const plan = await prisma.mealPlanInstance.findFirst({
          where: { id: { startsWith: prefix } },
          select: { id: true, startDate: true, items: { select: { mealId: true, assignedDayOfWeek: true } } },
        });
        if (!plan) { console.log(`${prefix} missing`); continue; }
        const meals = await loadMeals(prisma, { id: { in: plan.items.map((x) => x.mealId) } });
        const shaped = await shapeMeals(prisma, meals);
        console.log(`\n${plan.id.slice(0, 8)} start=${plan.startDate?.toISOString().slice(0, 10) ?? "-"} items=${plan.items.length} days=${plan.items.map((x) => x.assignedDayOfWeek?.slice(0, 3) ?? "-").join(",")}`);
        for (const s of shaped) console.log(`   ${s.title.slice(0, 60).padEnd(60)} d=${s.dishCount} pub=${s.isPublic ? "y" : "n"} [${s.shapes.join(" ")}]`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
