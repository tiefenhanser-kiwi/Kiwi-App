// [grocery] F Part B — the catalog DATA rows behind F2, F3 and F4.
//
// Dry by default; `--apply` writes. DEV only (host check). Every change is
// printed as before → after, and a row whose stored value already equals the
// target is reported as a no-op rather than written.
//
//   node --env-file=.env --import tsx scripts/grocery-f/catalog-fix.ts
//   node --env-file=.env --import tsx scripts/grocery-f/catalog-fix.ts --apply
//
// ⚠️ NOTHING HERE IS AN F1 PACK. D-WS9-292 explicitly does not write catalog
// packs for fresh meat — the stored pack stops being USED for that class and
// keeps its value for every other consumer. The one Protein row touched below
// is `cream of chicken soup`, whose category is the defect.

import { PrismaClient } from "@prisma/client";

import { assertDevHost } from "./catalog-sweep";

interface Change {
  finding: string;
  canonicalName: string;
  field: "purchaseDisplay" | "purchaseQuantity" | "category";
  to: string | number;
  why: string;
}

// ── F2 — the tomatillo count hint, dropped ─────────────────────────────────
//
// Ruled September 30. Two defects in one string: the count is wrong, and it is
// the only place the line names the food.
//
// ⚠️ THE NUMBER COULD NOT BE CORRECTED, SO IT IS REMOVED. Hans put a medium
// tomatillo at roughly 2 oz, which is ~8 to the pound, not 3-4. Nothing in this
// repository can settle it: the catalog's tomatillo rows carry no
// `gramsPerEach`, their USDA pointer (fdcId 168566, SR Legacy) holds per-100 g
// nutrition and no `foodPortions`, and the authored-prose sweep
// (scripts/grocery-f/piece-weights-text.ts) returns nothing for produce. An
// unverifiable hint that is the only thing naming the food is worth less than
// no hint, so it goes — which is the ruling's own second branch, "or drop the
// parenthetical".
//
// ⚠️ IT COSTS NO ARITHMETIC, and that was checked rather than assumed. The hint
// is read by `packSizeHint` → `packsToCoverNeed` rule 3, which needs the hint's
// unit to relate to the NEED's unit through the weight or volume table. The
// hint's unit here is "tomatillos", which is in neither, so rule 3 already
// returns null for every one of these rows and the pack is decided by rule 2
// (lb against lb) exactly as it will be afterwards.
//
// The other 14 rows carrying this shape KEEP their hint: the render rules in
// Part C make the line name the food whether or not a hint is present, and a
// hint like "(4 buns)" or "(~8-10 stalks)" is true and useful.
const F2_DROP_PAREN = ["tomatillo", "tomatillos"];

// ── F3 — a canned good is bought one can at a time ─────────────────────────
//
// The count was never a conversion: the CATALOG ROW stores the two-can pack
// (`purchaseQuantity` 2, display "2 cans (10.5 oz each)", packCount 1), so the
// list faithfully printed what it was told. Sweeping the class — a pack whose
// unit is a single container and whose quantity is above one — finds 5 rows.
// Four are foods a shop sells singly and are corrected here.
//
// `pouch sticky rice` is the fifth and is LEFT ALONE: microwave rice pouches
// genuinely do ship as 2-packs, so "2 pouches" may be the real shelf unit. It
// is reported rather than guessed at.
const F3_SINGLE: { name: string; display: string }[] = [
  { name: "cream of chicken soup", display: "1 can (10.5 oz)" },
  { name: "canned black beans, drained and rinsed", display: "1 can (15 oz)" },
  { name: "red kidney beans", display: "1 can (15 oz)" },
  { name: "near east rice pilaf", display: "1 box" },
];

// ── F4 — the category column, on the rows where it is an outlier ───────────
//
// The mechanism is `Ingredient.category`, not `inferCategory` and not the
// Sonnet pass: every row below has siblings of the same food filed correctly,
// which is what makes each one an outlier rather than a policy. Counts at the
// time of writing: vinegars Pantry=11 / Produce=1, condensed soups Produce=3 /
// Protein=2 with no row in Canned at all, fresh chiles Pantry=11 / Produce=4.
const F4_CATEGORY: { name: string; to: string }[] = [
  { name: "apple cider vinegar", to: "Pantry" },
  { name: "condensed cream of chicken soup", to: "Canned" },
  { name: "condensed cream of mushroom soup", to: "Canned" },
  { name: "condensed tomato soup", to: "Canned" },
  { name: "cream of chicken soup", to: "Canned" },
  { name: "cream of mushroom soup", to: "Canned" },
  { name: "fresh serrano chile", to: "Produce" },
  { name: "fresh serrano chili", to: "Produce" },
  { name: "fresh tomatillos", to: "Produce" },
  { name: "green serrano chile", to: "Produce" },
  { name: "poblano chiles", to: "Produce" },
  { name: "poblano pepper", to: "Produce" },
  { name: "serrano chile", to: "Produce" },
  { name: "serrano chili", to: "Produce" },
  { name: "tomatillo", to: "Produce" },
  { name: "tomatillos", to: "Produce" },
  { name: "tomatillos, husked and halved", to: "Produce" },
];

/** "1 lb (~3–4 tomatillos)" → "1 lb". Collapses the space the paren leaves. */
export function dropParenthetical(display: string): string {
  return display.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** The leading count of a pack display, as a number. */
function leadingCount(display: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s/.exec(display);
  return m ? parseFloat(m[1]) : null;
}

async function main() {
  assertDevHost();
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient();
  const changes: Change[] = [];
  const noops: string[] = [];
  const missing: string[] = [];

  const byName = new Map<string, { id: string; category: string | null; purchaseDisplay: string | null; purchaseQuantity: number | null }>();
  const wanted = [
    ...F2_DROP_PAREN,
    ...F3_SINGLE.map((r) => r.name),
    ...F4_CATEGORY.map((r) => r.name),
  ];
  for (const row of await prisma.ingredient.findMany({
    where: { canonicalName: { in: [...new Set(wanted)] } },
    select: { id: true, canonicalName: true, category: true, purchaseDisplay: true, purchaseQuantity: true },
  })) {
    byName.set(row.canonicalName, row);
  }
  for (const n of new Set(wanted)) if (!byName.has(n)) missing.push(n);

  for (const name of F2_DROP_PAREN) {
    const row = byName.get(name);
    if (!row?.purchaseDisplay) continue;
    const to = dropParenthetical(row.purchaseDisplay);
    if (to === row.purchaseDisplay) { noops.push(`F2 ${name} (no parenthetical)`); continue; }
    changes.push({ finding: "F2", canonicalName: name, field: "purchaseDisplay", to, why: `"${row.purchaseDisplay}" → "${to}"` });
  }

  for (const { name, display } of F3_SINGLE) {
    const row = byName.get(name);
    if (!row) continue;
    const qty = leadingCount(display) ?? 1;
    if (row.purchaseDisplay !== display) {
      changes.push({ finding: "F3", canonicalName: name, field: "purchaseDisplay", to: display, why: `"${row.purchaseDisplay}" → "${display}"` });
    } else noops.push(`F3 ${name} display`);
    if (row.purchaseQuantity !== qty) {
      changes.push({ finding: "F3", canonicalName: name, field: "purchaseQuantity", to: qty, why: `${row.purchaseQuantity} → ${qty}` });
    } else noops.push(`F3 ${name} quantity`);
  }

  for (const { name, to } of F4_CATEGORY) {
    const row = byName.get(name);
    if (!row) continue;
    if (row.category === to) { noops.push(`F4 ${name} (already ${to})`); continue; }
    changes.push({ finding: "F4", canonicalName: name, field: "category", to, why: `${row.category} → ${to}` });
  }

  console.log(`\n${apply ? "APPLY" : "DRY RUN"} — ${changes.length} change(s), ${noops.length} no-op(s), ${missing.length} name(s) not in the catalog\n`);
  let last = "";
  for (const c of changes) {
    if (c.finding !== last) { console.log(`── ${c.finding} ──`); last = c.finding; }
    console.log(`  ${c.canonicalName.padEnd(42)} ${c.field.padEnd(17)} ${c.why}`);
  }
  if (noops.length) console.log(`\nno-ops: ${noops.join(" · ")}`);
  if (missing.length) console.log(`\n🔴 NOT FOUND: ${missing.join(" · ")}`);

  if (!apply) { console.log(`\n(dry run — nothing written. Re-run with --apply)`); await prisma.$disconnect(); return; }

  let written = 0;
  for (const c of changes) {
    const row = byName.get(c.canonicalName);
    if (!row) continue;
    await prisma.ingredient.update({
      where: { id: row.id },
      data: { [c.field]: c.to } as Record<string, unknown>,
    });
    written++;
  }
  console.log(`\n✅ wrote ${written} field update(s) to DEV.`);
  await prisma.$disconnect();
}
if (process.argv[1]?.includes("catalog-fix")) main().catch((e) => { console.error(e); process.exit(1); });
