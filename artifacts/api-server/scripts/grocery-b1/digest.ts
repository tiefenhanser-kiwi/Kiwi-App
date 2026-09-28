// [grocery] B1 · Part A item 5 — THE DIGEST. READ-ONLY.
//
// One numbered plain-text list for Hans to rule on by number, in the A1 shape
// (`NNN. fresh cilantro → 1 cup chopped / bunch [Hans Sept 7]`, reply "12 no,
// 41 no"). Three sections: Y yields · P parts · X refusals and fixes.
//
// A `?` marks a line where this lane had to CHOOSE. Anything with a stated
// source and no choice needs no flag.
//
//   node --env-file=.env --import tsx scripts/grocery-b1/digest.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { resolveConversion } from "../../src/lib/ingredientConversions";
import {
  PACK_YIELDS, PACK_YIELDS_PORTION_NAMES, NO_YIELD_NEEDED, PART_EDGES,
  WIDENED_ADMIT, WIDENED_REFUSE_NOTES, SYNONYM_EDGES, X_ITEMS,
  PACK_FORGIVENESS_FRACTION,
} from "./proposals";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient();
  const ings = await prisma.ingredient.findMany({
    select: { canonicalName: true, category: true, purchaseUnit: true, purchaseDisplay: true, defaultUnit: true },
  });
  const byName = new Map(ings.map((i) => [normalizeIngredientName(i.canonicalName), i]));

  const L: string[] = [];
  let n = 0;
  const say = (s = "") => L.push(s);
  const item = (s: string, flag = false) => { n++; L.push(`${String(n).padStart(3)}. ${flag ? "? " : "  "}${s}`); };

  say("[grocery] B1 — THE DIGEST · September 28, 2026");
  say("Rule by number. `?` = this lane had to choose; a line with a source and no `?` is");
  say("high-confidence and needs no reply. Reply like: 12 no, 41 no");
  say();
  say(`Constants: PACK_FORGIVENESS_FRACTION = ${PACK_FORGIVENESS_FRACTION} · the perishable`);
  say("discriminator is Ingredient.category === 'Produce' (read through the EXISTING");
  say("PERISHABILITY_BY_CATEGORY table in planDayAssignment.ts, tier 1 = FRESH). There is");
  say("NO 'Herbs' category — the live vocabulary is exactly: Pantry 725, Produce 367,");
  say("Protein 232, Dairy 148, Canned 130, Bakery 119, Frozen 39, Snacks 19, Household 1.");
  say();

  say("=== Y — PACK YIELDS (how much of the need unit ONE PACK gives) ===");
  say("The pack noun is not repeated: it is Ingredient.purchaseUnit, which already exists.");
  say();
  for (const y of [...PACK_YIELDS, ...PACK_YIELDS_PORTION_NAMES]) {
    const row = byName.get(normalizeIngredientName(y.ingredient));
    const conv = resolveConversion(y.ingredient, null);
    const pack = row?.purchaseUnit ?? conv?.purchaseUnit ?? null;
    const disp = row?.purchaseDisplay ?? conv?.purchaseDisplay ?? "-";
    if (!row) { item(`${y.ingredient} · NO CATALOG ROW — cannot carry a yield`, true); continue; }
    if (!pack) { item(`${y.ingredient} · NO PACK NOUN — the ladder cannot fire; needs a pack first`, true); continue; }
    item(
      `${y.ingredient} · ${y.perPack} ${y.unit} per ${pack} ("${disp}", ${row.category}) · source: ${y.source} — ${y.note}`,
      y.chose === true,
    );
  }
  say();
  say("-- R2 population members that need NO yield row (reuse first) --");
  for (const z of NO_YIELD_NEEDED) item(`${z.ingredient} · NO YIELD OWED — ${z.reason}`);
  say();
  say("-- R2 population members with NO DEFENSIBLE FIGURE --");
  const covered = new Set([
    ...PACK_YIELDS.map((y) => normalizeIngredientName(y.ingredient)),
    ...PACK_YIELDS_PORTION_NAMES.map((y) => normalizeIngredientName(y.ingredient)),
    ...NO_YIELD_NEEDED.map((z) => normalizeIngredientName(z.ingredient)),
  ]);
  const surveyNames = [
    "fresh cilantro", "fresh flat-leaf parsley", "lime juice", "fresh lemon juice",
    "fresh ginger", "fresh lime juice", "fresh parsley", "green cabbage", "lemon zest",
    "fresh basil leaves", "fresh chives", "fresh dill", "fresh rosemary", "fresh thyme",
    "lime zest", "fresh mint leaves", "fresh thyme leaves", "red cabbage", "fresh basil",
    "fresh cilantro leaves", "fresh thai basil leaves", "romaine lettuce", "red onion",
    "white onion", "fresh pineapple", "fresh mint", "iceberg lettuce", "broccolini",
    "lime juice, fresh", "romaine lettuce hearts", "fresh corn kernels",
    "lime juice, freshly squeezed", "fresh flat-leaf parsley leaves", "fresh oregano",
    "fresh sage", "crusty bread", "seedless watermelon", "broccoli", "thai basil",
    "garlic", "yellow onion", "fresh cilantro stems", "fresh lacinato kale",
    "fresh flat-leaf parsley, finely chopped", "fresh cilantro, roughly chopped",
    "rotisserie chicken", "rotisserie chicken, meat shredded",
    "fresh rosemary, finely chopped", "fennel fronds", "radicchio",
    "shredded rotisserie chicken", "roma tomatoes", "sliced scallions",
  ];
  const gaps = surveyNames.filter((s) => !covered.has(normalizeIngredientName(s)));
  if (gaps.length === 0) say("  (none — every one of the 53 whole-sold R2 foods is answered above)");
  for (const g of gaps) item(`${g} · NO FIGURE — falls back to one whole pack per need (D-WS9-182's over-order-never-under-order fallback)`, true);

  say();
  say("=== P — PARTS (a part never buys its own line) ===");
  say("Every one is a `component` edge with coHarvestable where the part rides free.");
  say();
  say("-- P1. edges that EXIST and are refused only because the basis is read off");
  say("   defaultUnit instead of the PACK. Reading the pack instead is a code change with");
  say("   NO new column; each edge it newly reaches still needs a yes/no. --");
  for (const w of WIDENED_ADMIT) {
    const p = PART_EDGES.find((e) => `${e.parent} -> ${e.child}` === w.edge);
    item(`ADMIT ${w.edge}${p ? ` · ${p.yieldQuantity} ${p.yieldUnit} · coHarvestable ${p.coHarvestable}` : ""} — ${w.why}`, p?.chose === true || w.chose === true);
  }
  say();
  say("-- P2. edges the widening reaches and this lane REFUSES. Listed so nobody");
  say("   re-proposes them. --");
  for (const w of WIDENED_REFUSE_NOTES) item(`REFUSE ${w.edge} — ${w.why}`);
  say();
  say("-- P3. NEW edges --");
  for (const e of PART_EDGES.filter((x) => !x.existsButRefused)) {
    const parent = byName.get(normalizeIngredientName(e.parent));
    item(
      `${e.parent} -> ${e.child}${parent ? "" : " [NO PARENT CATALOG ROW — cannot author]"} · ${e.yieldQuantity ?? "rides free"} ${e.yieldUnit ?? ""} · ${e.coHarvestable ? "coHarvestable" : "exclusive (adds)"} · ${e.source} — ${e.note}`,
      e.chose === true,
    );
  }
  say();
  say("-- P4. NEW synonym edges (same product, two rows) --");
  for (const s of SYNONYM_EDGES) item(`SYNONYM ${s.a} <-> ${s.b} — ${s.why}`, s.chose === true);

  say();
  say("=== X — REFUSALS AND DATA FIXES ===");
  for (const x of X_ITEMS) item(`[${x.kind}] ${x.target}: ${x.change} — ${x.why}`, x.chose === true);
  say();
  say("-- BUG-328: the three ≤30-min labels, with the honest step-sum minutes --");
  item("Cheese Ravioli with Marinara and Garlic Bread (b96af5ed, public) · label 30 · active 23 · HONEST STEP SUM 73 min (ratio 2.43) · the convenience/bought path is 54 min (1.80) · re-time or relabel — Hans's call");
  item("Spicy Chicken Scampi with Cherry Tomatoes over Linguine (9d693c64, public) · label 28 · active 27 · HONEST STEP SUM 50 min (ratio 1.79) · bought path 48 min (1.71)");
  item("Sausage and Kale Orecchiette with Crusty Bread (FOUR rows share this title: 1f122b1a public, plus private copies 1b565fb5 / 97aeb9cc / bf29666d) · label 27 · active 24 · HONEST STEP SUM 65 min (ratio 2.41) · both paths 65 min · ⚠️ FOUR rows share this title, so a relabel is four writes, not one");

  say();
  say(`(${n} numbered lines)`);
  writeFileSync(join(OUT, "digest.txt"), L.join("\n") + "\n", "utf8");
  console.log(L.join("\n"));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exit(1); });
