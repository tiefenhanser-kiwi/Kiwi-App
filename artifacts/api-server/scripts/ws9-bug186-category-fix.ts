// WS9 BUG-186 — catalog aisle pass.
//
// 21 Ingredient rows carry a category that sends them to the wrong grocery
// aisle (storeSection derives from Ingredient.category via CATEGORY_TO_SECTION
// in groceryList.ts). Hans's ruling, August 29 2026: "if it's cheese it's in
// dairy" — applied per family, no row-by-row approval.
//
//   • 13 cheeses            Pantry  → Dairy
//   •  1 large eggs         Protein → Dairy
//   •  3 tofu               Protein → Dairy   (refrigerated default)
//   •  4 egg pastas         Dairy   → Pantry
//
// Prep Week is protected separately by PREP_CATEGORY_OVERRIDE
// (src/lib/prepCategoryOverride.ts) — this script does NOT touch prep.
//
// Does NOT touch GroceryListItem: existing lists keep their sections, and
// regeneration/reconcile picks up the fixed defaults.
//
// Run:
//   node --env-file=.env --import tsx scripts/ws9-bug186-category-fix.ts --dry-run
//   node --env-file=.env --import tsx scripts/ws9-bug186-category-fix.ts --apply
//   node --env-file=.env --import tsx scripts/ws9-bug186-category-fix.ts --verify
//   node --env-file=.env --import tsx scripts/ws9-bug186-category-fix.ts --emit-fixture

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { PREP_CATEGORY_OVERRIDE } from "../src/lib/prepCategoryOverride";

const HERE = dirname(fileURLToPath(import.meta.url));

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const EMIT = process.argv.includes("--emit-fixture");

/** canonicalName → the corrected category. Census of 2026-08-31. */
const AISLE_FIX: Record<string, string> = {
  // ── Cheese ×13: Pantry → Dairy. All were filed Pantry because their names
  // carry no "cheese" token and inferCategory had no keyword for them
  // (fixed forward as BUG-191).
  "parmigiano-reggiano": "Dairy",
  "pecorino romano": "Dairy",
  "queso fresco": "Dairy",
  paneer: "Dairy",
  "parmigiano-reggiano rind": "Dairy",
  "shaved parmigiano-reggiano": "Dairy",
  "grated pecorino romano": "Dairy",
  "parmigiano reggiano": "Dairy",
  "finely grated parmigiano-reggiano": "Dairy",
  fontina: "Dairy",
  "freshly grated parmigiano-reggiano": "Dairy",
  "gorgonzola dolce": "Dairy",
  "parmigiano-reggiano, finely grated": "Dairy",

  // ── Eggs ×1: Protein → Dairy. The twelve other egg rows were already Dairy;
  // this one was a hand-authored seed literal (seed.ts, also corrected).
  "large eggs": "Dairy",

  // ── Tofu ×3: Protein → Dairy. Refrigerated case beside the eggs. None of the
  // three names is marked shelf-stable/aseptic, so all take the fridge default.
  "extra-firm tofu": "Dairy",
  "firm tofu": "Dairy",
  "silken tofu": "Dairy",

  // ── Egg pasta ×4: Dairy → Pantry. Filed Dairy because inferCategory's bare
  // "egg" keyword matched the noodle name (fixed forward as BUG-191).
  "wide egg noodles": "Pantry",
  "fresh chow mein egg noodles": "Pantry",
  "fresh lo mein egg noodles": "Pantry",
  "egg noodles": "Pantry",
};

const prisma = new PrismaClient();

// ── --emit-fixture ──────────────────────────────────────────────────────────
// Regenerates the integrity fixture guarding PREP_CATEGORY_OVERRIDE's keys.
if (EMIT) {
  const FAM =
    /(cheese|parmigiano|parmesan|pecorino|romano|mozzarella|cheddar|feta|ricotta|queso|gouda|brie\b|gruy|provolone|asiago|mascarpone|manchego|halloumi|cotija|monterey jack|swiss|burrata|boursin|havarti|colby|muenster|fontina|camembert|paneer|gorgonzola|taleggio|stilton|\begg|tofu|pasta|noodle|spaghetti|penne|rigatoni|fettuccine|linguine|macaroni|orzo|lasagn|ziti|farfalle|rotini|bucatini|tagliatelle|vermicelli|ramen|soba|udon|gnocchi|orecchiette|pappardelle)/i;
  const all = await prisma.ingredient.findMany({
    select: { canonicalName: true },
    orderBy: { canonicalName: "asc" },
  });
  const names = all.map((r) => r.canonicalName).filter((n) => FAM.test(n));
  const out = join(HERE, "../src/lib/__tests__/catalogFamilyNames.fixture.ts");
  writeFileSync(
    out,
    `// WS9 BUG-186 — GENERATED FIXTURE, do not hand-edit.
//
// Every Ingredient.canonicalName in the cheese / egg / tofu / pasta families,
// as they exist in the catalog. Regenerate with:
//
//   node --env-file=.env --import tsx scripts/ws9-bug186-category-fix.ts --emit-fixture
//
// Its ONLY job is to make PREP_CATEGORY_OVERRIDE's keys falsifiable: the
// override table is keyed on ingredient NAME, so a canonical rename would
// silently unlink an entry and quietly restore the BUG-186 behaviour. The
// integrity test in prepCategoryOverride.test.ts asserts every key still
// appears here, so a rename goes RED instead of going unnoticed.
export const CATALOG_FAMILY_CANONICAL_NAMES: readonly string[] = [
${names.map((n) => "  " + JSON.stringify(n) + ",").join("\n")}
];
`,
  );
  console.log(`fixture written: ${names.length} names → ${out}`);
  await prisma.$disconnect();
  process.exit(0);
}

// ── --verify ────────────────────────────────────────────────────────────────
// The negative, from both directions.
if (VERIFY) {
  let bad = 0;
  const CHEESE =
    /(cheese|parmigiano|parmesan|pecorino|romano|mozzarella|cheddar|feta|ricotta|queso|gouda|brie\b|gruy|provolone|asiago|mascarpone|manchego|halloumi|cotija|monterey jack|burrata|havarti|colby|muenster|fontina|camembert|paneer|gorgonzola)/i;
  const rows = await prisma.ingredient.findMany({
    select: { canonicalName: true, category: true },
    orderBy: { canonicalName: "asc" },
  });

  // 1. No cheese outside Dairy (the Frozen pierogi is a prepared food, not a
  //    cheese row — the one documented exemption).
  const strayCheese = rows.filter(
    (r) =>
      CHEESE.test(r.canonicalName) &&
      r.category !== "Dairy" &&
      r.canonicalName !== "frozen potato and cheese pierogis",
  );
  if (strayCheese.length) {
    bad++;
    console.log(`FAIL cheese outside Dairy: ${strayCheese.map((r) => `${r.canonicalName}=${r.category}`).join(", ")}`);
  } else console.log("OK   zero cheese rows outside Dairy");

  // 2. No egg pasta inside Dairy.
  const strayPasta = rows.filter(
    (r) => /egg noodle/i.test(r.canonicalName) && r.category === "Dairy",
  );
  if (strayPasta.length) {
    bad++;
    console.log(`FAIL egg pasta still Dairy: ${strayPasta.map((r) => r.canonicalName).join(", ")}`);
  } else console.log("OK   zero egg-pasta rows in Dairy");

  // 3. Every egg row agrees.
  const eggs = rows.filter(
    (r) => /\begg/i.test(r.canonicalName) && !/noodle|plant/i.test(r.canonicalName),
  );
  const oddEggs = eggs.filter((r) => r.category !== "Dairy");
  if (oddEggs.length) {
    bad++;
    console.log(`FAIL eggs not Dairy: ${oddEggs.map((r) => `${r.canonicalName}=${r.category}`).join(", ")}`);
  } else console.log(`OK   all ${eggs.length} egg rows are Dairy (incl. large eggs)`);

  // 4. Tofu per the reported verdicts.
  const tofu = rows.filter((r) => /tofu/i.test(r.canonicalName));
  const oddTofu = tofu.filter((r) => r.category !== "Dairy");
  if (oddTofu.length) {
    bad++;
    console.log(`FAIL tofu not Dairy: ${oddTofu.map((r) => `${r.canonicalName}=${r.category}`).join(", ")}`);
  } else console.log(`OK   all ${tofu.length} tofu rows are Dairy`);

  // 5. Live integrity of the override table (the unit test uses a fixture).
  const live = new Set(rows.map((r) => r.canonicalName));
  const orphans = Object.keys(PREP_CATEGORY_OVERRIDE).filter((k) => !live.has(k));
  if (orphans.length) {
    bad++;
    console.log(`FAIL override keys with no catalog row: ${orphans.join(", ")}`);
  } else
    console.log(
      `OK   all ${Object.keys(PREP_CATEGORY_OVERRIDE).length} override keys resolve to live rows`,
    );

  console.log(bad === 0 ? "\nVERIFY: ALL PASS" : `\nVERIFY: ${bad} FAILURES`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}

// ── --dry-run / --apply ─────────────────────────────────────────────────────
const names = Object.keys(AISLE_FIX);
const rows = await prisma.ingredient.findMany({
  where: { canonicalName: { in: names } },
  select: { id: true, canonicalName: true, category: true },
  orderBy: { canonicalName: "asc" },
});

const missing = names.filter((n) => !rows.some((r) => r.canonicalName === n));
if (missing.length) {
  console.error(`ABORT — ${missing.length} planned row(s) not in catalog: ${missing.join(", ")}`);
  await prisma.$disconnect();
  process.exit(1);
}

const changes = rows.filter((r) => r.category !== AISLE_FIX[r.canonicalName]);
const noops = rows.filter((r) => r.category === AISLE_FIX[r.canonicalName]);

console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${changes.length} change(s), ${noops.length} already correct\n`);
for (const r of changes) {
  console.log(`  ${r.canonicalName.padEnd(38)} ${r.category.padEnd(8)} → ${AISLE_FIX[r.canonicalName]}`);
}
for (const r of noops) {
  console.log(`  (no-op) ${r.canonicalName.padEnd(31)} already ${r.category}`);
}

if (APPLY) {
  let written = 0;
  for (const r of changes) {
    await prisma.ingredient.update({
      where: { id: r.id },
      data: { category: AISLE_FIX[r.canonicalName] },
    });
    written++;
  }
  console.log(`\nwrote ${written} row(s)`);
}

console.log(`\nCOUNT=${changes.length}`);
await prisma.$disconnect();
