// [grocery] F Part E / E2 — WHICH CATALOG NAMES ESCAPE THE STAPLE CHECK.
//
// D-WS9-295 asks for sugar and cornstarch as staples, and asks first for an
// explanation of `1 bottle (51 oz) vegetable oil` — which renders as a staple on
// some lists and as a pack on others.
//
// ⚠️ THE ANSWER IS NOT "ADD ONE ROW", and the go-ahead says so: fix the class.
// This is the class. BUG-182 ruled that a staple flag is set on the SPECIFIC
// ingredient, listed by name in UNIVERSAL_STAPLES, or not at all — no folding.
// That is the right rule and it has one consequence nobody has swept for: every
// catalog canonical name that IS one of those foods under a different word is
// silently not a staple. `neutral oil` is one; its displayName is literally
// "vegetable oil".
//
// Read-only.
//   node --env-file=.env --import tsx scripts/grocery-f/staple-sweep.ts

import { PrismaClient } from "@prisma/client";

import { UNIVERSAL_STAPLES } from "../../src/lib/groceryStaples";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";

/**
 * The staple FOODS, each with the catalog spellings that mean it. Written out
 * rather than derived: STAPLE_VARIANT_TO_BASE answers "do I already own this?"
 * and deliberately omits the ones BUG-182 excluded, so it is the wrong table to
 * sweep with — it would re-add flaky sea salt, which Hans added by hand
 * precisely because he does not own it.
 */
const FOOD_PATTERNS: { food: string; re: RegExp }[] = [
  { food: "salt", re: /\bsalts?\b/i },
  { food: "black pepper", re: /\bpepper(corns?)?\b/i },
  { food: "sugar", re: /\bsugar\b/i },
  { food: "flour", re: /\bflour\b/i },
  { food: "oil", re: /\boil\b/i },
  { food: "baking", re: /\bbaking (soda|powder)\b/i },
  { food: "cornstarch", re: /\b(cornstarch|corn starch)\b/i },
  { food: "vinegar", re: /\bvinegar\b/i },
];

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
  console.log("host check: PASS (dev branch)");
  const prisma = new PrismaClient();

  const listed = new Set(UNIVERSAL_STAPLES.map((s) => normalizeIngredientName(s.canonicalName)));
  console.log(`\nUNIVERSAL_STAPLES holds ${listed.size} names.`);

  const rows = await prisma.ingredient.findMany({
    select: { canonicalName: true, displayName: true, category: true, purchaseDisplay: true },
    orderBy: { canonicalName: "asc" },
  });

  // How many DISH references each name has — a name with none is a silent
  // no-op, which is the discipline UNIVERSAL_STAPLES' own docblock sets.
  const refs = new Map<string, number>();
  for (const g of await prisma.dishIngredient.groupBy({
    by: ["ingredientId"],
    _count: { _all: true },
  })) {
    if (g.ingredientId) refs.set(g.ingredientId, g._count._all);
  }
  const byId = new Map(
    (await prisma.ingredient.findMany({ select: { id: true, canonicalName: true } })).map((r) => [
      r.canonicalName,
      refs.get(r.id) ?? 0,
    ]),
  );

  for (const { food, re } of FOOD_PATTERNS) {
    const hits = rows.filter((r) => re.test(r.canonicalName));
    const already = hits.filter((r) => listed.has(normalizeIngredientName(r.canonicalName)));
    const escaping = hits.filter((r) => !listed.has(normalizeIngredientName(r.canonicalName)));
    console.log(`\n══ ${food} — ${hits.length} catalog rows, ${already.length} listed, ${escaping.length} NOT ══`);
    for (const r of escaping.sort((a, b) => (byId.get(b.canonicalName) ?? 0) - (byId.get(a.canonicalName) ?? 0))) {
      const n = byId.get(r.canonicalName) ?? 0;
      if (n === 0) continue; // a name with no dish reference can never render
      console.log(
        `   ${String(n).padStart(5)} refs  ${r.canonicalName.padEnd(38)} display="${r.displayName}"  pack="${r.purchaseDisplay ?? ""}"`,
      );
    }
  }
  await prisma.$disconnect();
}
if (process.argv[1]?.includes("staple-sweep")) main().catch((e) => { console.error(e); process.exit(1); });
