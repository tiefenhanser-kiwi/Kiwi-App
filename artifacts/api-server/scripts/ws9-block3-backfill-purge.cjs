// Plan-Gen Arc · Block 3 · 1C — backfill dishFamilyKey on the pilot's 28
// batch_generated meals, then purge duplicates (keep the EARLIEST per key).
//
// Run AFTER applying the dishFamilyKey migration + prisma generate.
//   Dry-run (default, no deletes):  node --env-file=.env scripts/ws9-block3-backfill-purge.cjs
//   Purge:                          node --env-file=.env scripts/ws9-block3-backfill-purge.cjs --apply
//
// The pilot harness (pre-fix) did not record the source target dish, so the
// backfill uses an explicit id-prefix → dishFamilyKey map derived from the 1C
// inspection (the titles paraphrase the target, so title-inference is unsafe).

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// id-prefix → target dishFamilyKey (from the 1C store inspection).
const KEY_BY_PREFIX = {
  // run 1 (ranks 1-10) — KEEP
  "53ba3c2e": "spaghetti-with-meat-sauce",
  "e5556c9f": "ground-beef-tacos-hard-shell",
  "9aaf45f6": "baked-chicken-breast",
  "67b192e0": "classic-cheeseburger",
  "e5469902": "grilled-chicken-breast",
  "6e0d54d1": "spaghetti-and-meatballs",
  "1eafc755": "beef-chili",
  "aefc64f2": "meatloaf",
  "cce515c8": "chicken-parmesan",
  "8c3cb0aa": "homemade-pepperoni-pizza",
  // run 2 (ranks 1-8 DUPLICATES + ranks 11-20 new)
  "f74e1a2c": "spaghetti-with-meat-sauce",       // DUP
  "e0c68539": "ground-beef-tacos-hard-shell",    // DUP
  "89ddf95d": "baked-chicken-breast",            // DUP
  "bba8e406": "classic-cheeseburger",            // DUP
  "427bf426": "grilled-chicken-breast",          // DUP
  "d89f4cbe": "spaghetti-and-meatballs",         // DUP
  "d625618a": "beef-chili",                      // DUP
  "0378173b": "meatloaf",                        // DUP
  "bc3e0d2a": "baked-mac-and-cheese",
  "26abd41a": "beef-and-broccoli-stir-fry",
  "3e2e0912": "pot-roast",
  "8b34a859": "sheet-pan-chicken-fajitas",
  "a63262b8": "chicken-and-vegetable-stir-fry",
  "eae97408": "baked-lemon-herb-salmon",
  "e3702c33": "buttermilk-fried-chicken",
  "20f75a0d": "chicken-noodle-soup",
  "4c1a206d": "roast-whole-chicken",
  "edc65b17": "beef-stew",
};

async function deleteMealGraph(id) {
  await prisma.$transaction(async (tx) => {
    const links = await tx.mealDishLink.findMany({ where: { mealId: id }, select: { dishId: true } });
    const dishIds = links.map((l) => l.dishId);
    await tx.recipeInstructionStep.deleteMany({ where: { ownerType: "dish", ownerId: { in: dishIds } } });
    await tx.dishIngredient.deleteMany({ where: { dishId: { in: dishIds } } });
    await tx.mealDishLink.deleteMany({ where: { mealId: id } });
    await tx.dish.deleteMany({ where: { id: { in: dishIds } } });
    await tx.meal.delete({ where: { id } });
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const meals = await prisma.meal.findMany({
    where: { sourceType: "batch_generated" },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, dishFamilyKey: true, createdAt: true },
  });

  // 1. Backfill dishFamilyKey.
  let backfilled = 0;
  for (const m of meals) {
    const prefix = m.id.slice(0, 8);
    const key = KEY_BY_PREFIX[prefix];
    if (!key) { console.log(`⚠️ no key mapping for ${prefix} "${m.title}" — SKIPPED`); continue; }
    if (m.dishFamilyKey === key) continue;
    if (apply) await prisma.meal.update({ where: { id: m.id }, data: { dishFamilyKey: key } });
    backfilled++;
  }
  console.log(`${apply ? "backfilled" : "would backfill"} dishFamilyKey on ${backfilled} meals`);

  // 2. Identify duplicates (same key, keep earliest by createdAt).
  const byKey = new Map();
  for (const m of meals) {
    const key = KEY_BY_PREFIX[m.id.slice(0, 8)];
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  const toDelete = [];
  for (const [key, ms] of byKey) {
    if (ms.length <= 1) continue;
    ms.sort((a, b) => a.createdAt - b.createdAt);
    const keep = ms[0];
    for (const extra of ms.slice(1)) {
      toDelete.push(extra);
      console.log(`  dup [${key}] KEEP ${keep.id.slice(0, 8)} "${keep.title}"  |  DELETE ${extra.id.slice(0, 8)} "${extra.title}"`);
    }
  }
  console.log(`\n${apply ? "deleting" : "would delete"} ${toDelete.length} duplicate meals`);
  if (apply) {
    for (const m of toDelete) { await deleteMealGraph(m.id); console.log(`  deleted ${m.id}`); }
  } else {
    console.log("(dry-run — re-run with --apply to backfill + delete)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
