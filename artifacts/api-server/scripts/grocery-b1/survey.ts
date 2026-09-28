// [grocery] B1 · Part A — THE CATALOG SURVEY. READ-ONLY.
//
// Answers §3 Part A items 2 and 3 catalog-wide (the census's A7 measured the
// 20-list CORPUS only, which is why its numbers are smaller):
//
//   2. the R2 population — foods whose PACK is a whole/count unit and whose
//      DishIngredient needs arrive in a MEASURE.
//   3. the parts population — ingredients whose NAME marks them as part of
//      another purchase, with the parent candidate and any existing edge.
//
// Plus the facts Part A has to report rather than assume: the distinct
// `Ingredient.category` vocabulary (the perishable discriminator's domain), the
// live component-edge inventory with its admit/decline reason, and the
// coarse-salt row.
//
//   node --env-file=.env --import tsx scripts/grocery-b1/survey.ts

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  normalizeUnit,
  canonicalUnitToken,
  resolveConversion,
} from "../../src/lib/ingredientConversions";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

const prisma = new PrismaClient();

// Same vocabulary the census's yields.ts used, so the two counts are comparable.
const PACK_SOLD_WHOLE = new Set([
  "bunch", "bunches", "head", "heads", "each", "bulb", "bulbs", "ear", "ears",
  "stalk", "stalks", "sprig", "sprigs",
]);
// Containers: whole packs too, and R2's "never under-buy" applies, but they are
// NOT perishable so they never take the forgiveness. Counted separately.
const PACK_CONTAINER = new Set([
  "can", "cans", "jar", "jars", "package", "packages", "packet", "packets",
  "bottle", "bottles", "box", "boxes", "bag", "bags", "carton", "cartons",
  "container", "containers", "loaf", "loaves", "block", "blocks", "stick",
  "sticks", "pint", "quart", "gallon", "bundle", "clamshell", "tub",
]);
const MEASURE_NEED = new Set([
  "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon",
  "teaspoons", "oz", "ounce", "ounces", "lb", "pound", "pounds", "g", "gram",
  "grams", "kg", "ml", "l", "liter", "litre", "fl oz", "pinch", "dash",
]);

// §3.3 — the part words. Matched as whole words at the END of a name or before a
// comma, which is where the part noun sits ("lemon zest", "cilantro stems,
// chopped"). The parent candidate is the name with the part word removed.
const PART_WORDS = [
  "brine", "stems", "stem", "leaves", "leaf", "zest", "juice", "tops", "top",
  "fronds", "frond", "rind", "rinds", "peel", "peels", "seeds", "seed",
  "whites", "white", "yolks", "yolk", "florets", "greens", "sprigs", "sprig",
  "cloves", "clove", "wedges", "wedge",
];

function packUnitClass(u: string | null): "whole" | "container" | "measure" | "none" {
  if (!u) return "none";
  const n = normalizeUnit(u);
  if (PACK_SOLD_WHOLE.has(n)) return "whole";
  if (PACK_CONTAINER.has(n)) return "container";
  return "measure";
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const lines: string[] = [];
  const say = (s = "") => { lines.push(s); console.log(s); };

  const ings = await prisma.ingredient.findMany({
    select: {
      id: true, canonicalName: true, displayName: true, category: true,
      subcategory: true, defaultUnit: true, purchaseUnit: true,
      purchaseQuantity: true, purchaseDisplay: true, conversionRef: true,
    },
  });
  say(`INGREDIENTS: ${ings.length}`);

  // ── the category vocabulary (the perishable discriminator's domain) ────────
  const cats = new Map<string, number>();
  for (const i of ings) cats.set(i.category, (cats.get(i.category) ?? 0) + 1);
  say();
  say("=== Ingredient.category — LIVE VOCABULARY ===");
  for (const [c, n] of [...cats].sort((a, b) => b[1] - a[1])) say(`  ${c}  ${n}`);
  const subs = ings.filter((i) => i.subcategory != null).length;
  say(`  subcategory non-null: ${subs} / ${ings.length}`);

  // ── pack-unit classes ─────────────────────────────────────────────────────
  say();
  say("=== pack (purchaseUnit) class ===");
  const byClass = new Map<string, number>();
  for (const i of ings) {
    const c = packUnitClass(i.purchaseUnit);
    byClass.set(c, (byClass.get(c) ?? 0) + 1);
  }
  for (const [c, n] of byClass) say(`  ${c}: ${n}`);

  // ── need units per ingredient, from DishIngredient ─────────────────────────
  const needs = await prisma.dishIngredient.groupBy({
    by: ["ingredientId", "unit"],
    _count: { _all: true },
  });
  const needsById = new Map<string, Map<string, number>>();
  for (const n of needs) {
    if (!n.ingredientId) continue;
    let m = needsById.get(n.ingredientId);
    if (!m) { m = new Map(); needsById.set(n.ingredientId, m); }
    m.set(n.unit, (m.get(n.unit) ?? 0) + n._count._all);
  }
  say();
  say(`DISH INGREDIENT rows: ${needs.reduce((a, b) => a + b._count._all, 0)} in ${needsById.size} distinct ingredients`);

  // ── §3.2 THE R2 POPULATION, CATALOG-WIDE ──────────────────────────────────
  type R2 = {
    name: string; cat: string; packUnit: string; packDisplay: string | null;
    packClass: string; defaultUnit: string;
    measureRows: number; measureUnits: string; countRows: number;
    hasSubUnit: boolean; gramsPerCup: number | null; gramsPerEach: number | null;
  };
  const r2: R2[] = [];
  for (const i of ings) {
    const cls = packUnitClass(i.purchaseUnit);
    if (cls !== "whole" && cls !== "container") continue;
    const m = needsById.get(i.id);
    if (!m) continue;
    let measureRows = 0, countRows = 0;
    const mu = new Map<string, number>();
    for (const [u, n] of m) {
      const nu = normalizeUnit(u);
      if (MEASURE_NEED.has(nu)) {
        measureRows += n;
        mu.set(nu, (mu.get(nu) ?? 0) + n);
      } else countRows += n;
    }
    if (measureRows === 0) continue;
    // A need whose unit is the PACK unit itself needs no yield.
    const conv = resolveConversion(i.canonicalName, i.conversionRef);
    r2.push({
      name: i.canonicalName, cat: i.category,
      packUnit: i.purchaseUnit!, packDisplay: i.purchaseDisplay,
      packClass: cls, defaultUnit: i.defaultUnit,
      measureRows, countRows,
      measureUnits: [...mu].sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u}×${n}`).join(" "),
      hasSubUnit: !!conv?.subUnit,
      gramsPerCup: conv?.gramsPerCup ?? null,
      gramsPerEach: conv?.gramsPerEach ?? null,
    });
  }
  r2.sort((a, b) => b.measureRows - a.measureRows);
  const wholeR2 = r2.filter((r) => r.packClass === "whole");
  const contR2 = r2.filter((r) => r.packClass === "container");
  say();
  say("=== §3.2 THE R2 POPULATION, CATALOG-WIDE ===");
  say(`whole-sold packs with a MEASURE need: ${wholeR2.length} foods / ${wholeR2.reduce((a, b) => a + b.measureRows, 0)} DishIngredient rows`);
  say(`container packs with a MEASURE need: ${contR2.length} foods / ${contR2.reduce((a, b) => a + b.measureRows, 0)} rows`);
  say();
  say("-- whole-sold (R2 proper) --");
  for (const r of wholeR2) {
    say(`  ${r.name} [${r.cat}] pack=${r.packUnit} "${r.packDisplay ?? "-"}" default=${r.defaultUnit} need: ${r.measureUnits}${r.countRows ? ` (+${r.countRows} count rows)` : ""}${r.hasSubUnit ? " SUBUNIT" : ""}${r.gramsPerCup ? ` gpc=${r.gramsPerCup}` : ""}${r.gramsPerEach ? ` gpe=${r.gramsPerEach}` : ""}`);
  }
  say();
  say("-- container packs (never forgiven; listed for the ceil rule) --");
  for (const r of contR2) {
    say(`  ${r.name} [${r.cat}] pack=${r.packUnit} "${r.packDisplay ?? "-"}" need: ${r.measureUnits}`);
  }

  // ── §3.3 THE PARTS POPULATION ─────────────────────────────────────────────
  const byName = new Map(ings.map((i) => [i.canonicalName.toLowerCase(), i]));
  type Part = { child: string; word: string; parentGuess: string; parentExists: boolean; childCat: string; needUnits: string };
  const parts: Part[] = [];
  for (const i of ings) {
    const lower = i.canonicalName.toLowerCase();
    const head = (lower.split(",")[0] ?? lower).trim();
    const words = head.split(/\s+/);
    const last = words[words.length - 1];
    const hit = PART_WORDS.find((w) => w === last);
    if (!hit) continue;
    if (words.length < 2) continue; // "juice" alone is not a part of anything named
    const guess = words.slice(0, -1).join(" ");
    const m = needsById.get(i.id);
    parts.push({
      child: i.canonicalName, word: hit, parentGuess: guess,
      parentExists: byName.has(guess) || byName.has(guess.replace(/^fresh /, "")),
      childCat: i.category,
      needUnits: m ? [...m].map(([u, n]) => `${u}×${n}`).join(" ") : "(no dish rows)",
    });
  }
  parts.sort((a, b) => a.word.localeCompare(b.word) || a.child.localeCompare(b.child));
  say();
  say("=== §3.3 THE PARTS POPULATION (name pattern) ===");
  say(`${parts.length} ingredients whose name ends in a part word`);
  for (const p of parts) {
    say(`  [${p.word}] ${p.child} [${p.childCat}] -> parent? "${p.parentGuess}" ${p.parentExists ? "EXISTS" : "no catalog row"} · need ${p.needUnits}`);
  }

  // ── existing relation edges ───────────────────────────────────────────────
  const rels = await prisma.ingredientRelation.findMany({
    include: {
      from: { select: { canonicalName: true, defaultUnit: true, purchaseUnit: true, purchaseDisplay: true, category: true } },
      to: { select: { canonicalName: true, defaultUnit: true } },
    },
  });
  say();
  say("=== ingredient_relations — INVENTORY ===");
  const byLabel = new Map<string, number>();
  for (const r of rels) byLabel.set(r.label, (byLabel.get(r.label) ?? 0) + 1);
  for (const [l, n] of byLabel) say(`  ${l}: ${n}`);

  const comps = rels.filter((r) => r.label === "component");
  say();
  say(`-- component edges (${comps.length}), with the basis gate's verdict --`);
  for (const r of comps.sort((a, b) => a.from.canonicalName.localeCompare(b.from.canonicalName))) {
    const basis = normalizeUnit(r.from.defaultUnit);
    const admitted =
      r.yieldQuantity == null || !(r.yieldQuantity > 0) || !r.yieldUnit ? "REFUSED missing-yield"
      : r.coHarvestable == null ? "REFUSED missing-yield(coHarvestable null)"
      : !["each", "head", "bunch"].includes(basis) ? `REFUSED basis-unit-not-countable (${basis})`
      : "admitted";
    say(`  ${r.from.canonicalName} [default=${r.from.defaultUnit} pack=${r.from.purchaseUnit ?? "-"} "${r.from.purchaseDisplay ?? "-"}"] -> ${r.to.canonicalName}: ${r.yieldQuantity ?? "null"} ${r.yieldUnit ?? "null"} coHarvest=${r.coHarvestable} conf=${r.confidence} human=${r.reviewedByHuman} :: ${admitted}`);
  }

  say();
  say("-- the coarse-salt row (D-WS9-217) --");
  for (const r of rels) {
    const a = r.from.canonicalName.toLowerCase();
    const b = r.to.canonicalName.toLowerCase();
    if (a.includes("salt") && b.includes("salt")) {
      say(`  id=${r.id} ${r.from.canonicalName} --${r.label}--> ${r.to.canonicalName} conf=${r.confidence} human=${r.reviewedByHuman} source=${(r as unknown as { source?: string }).source ?? "?"}`);
    }
  }

  // ── conversionRef occupancy (is there already a home for {unit, perPack}?) ─
  say();
  say("=== conversionRef occupancy ===");
  let withRef = 0, withSub = 0, withPack = 0, withGpc = 0, withGpe = 0;
  const subNames: string[] = [];
  for (const i of ings) {
    const c = resolveConversion(i.canonicalName, i.conversionRef);
    if (i.conversionRef != null) withRef++;
    if (c?.subUnit) { withSub++; subNames.push(`${i.canonicalName} {${c.subUnit.parent} / ${c.subUnit.perParent}}`); }
    if (c?.purchaseUnit) withPack++;
    if (c?.gramsPerCup) withGpc++;
    if (c?.gramsPerEach) withGpe++;
  }
  say(`  conversionRef non-null: ${withRef} · subUnit: ${withSub} · purchase*: ${withPack} · gramsPerCup: ${withGpc} · gramsPerEach: ${withGpe}`);
  for (const s of subNames) say(`    subUnit: ${s}`);

  writeFileSync(join(OUT, "survey.txt"), lines.join("\n") + "\n", "utf8");
  writeFileSync(join(OUT, "survey.json"), JSON.stringify({ r2, parts }, null, 2), "utf8");
  console.log(`\nwrote ${join(OUT, "survey.txt")}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
