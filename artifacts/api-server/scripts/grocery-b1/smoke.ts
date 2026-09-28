// [grocery] B1 · Part C — THE WIRING SMOKE. READ-ONLY, NO AI.
//
// The census re-run (Part E) is the real proof and it costs money, so this runs
// the REAL production functions — poolComponentNeeds, mergeConvertibleGroups,
// roundNeedQuantity, scalePurchaseForSubUnit — over the golden corpus's
// `consolidated` rows first, and renders with the CLIENT's composePackName.
//
// The corpus was captured BEFORE the pack-yield columns existed, so the rows are
// re-hydrated from the live catalog by canonicalName. That is what the real
// consolidator does at generation time anyway (`include: { ingredient: true }`).
//
//   node --env-file=.env --import tsx scripts/grocery-b1/smoke.ts

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import { poolComponentNeeds } from "../../src/lib/ingredientRelations";
import { mergeConvertibleGroups } from "../../src/lib/groceryMerge";
import { roundNeedQuantity } from "../../src/lib/needQuantity";
import {
  rowConversion,
  scalePurchaseForSubUnit,
  withGroupLadder,
  lookupConversion,
} from "../../src/lib/ingredientConversions";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import type { ConsolidatedItem } from "../../src/lib/groceryList";

import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";
interface GroceryFormat {
  composePackName: (
    name: string, purchaseUnit: string | null | undefined,
    purchaseDisplay: string | null | undefined, needAmount?: string | number | null,
    needUnit?: string | null, isPantryStaple?: boolean,
  ) => string;
  formatNeedText: (a: string | undefined, u: string | undefined, f: string) => string;
}
const ns = groceryFormatNs as unknown as { default?: GroceryFormat } & GroceryFormat;
const G: GroceryFormat = ns.composePackName ? ns : (ns.default as GroceryFormat);
const { composePackName, formatNeedText } = G;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
const PLANS = [
  "f5556c19", "56b03a57", "c404a3cf", "247cd7bb", "14879176", "b8e7f134",
  "31c7a885", "96a94410", "425da049", "ed238692", "2b6e51a1", "6e952e32",
  "a8b0bbd5", "316d0846", "11653a33", "353ce059", "14397131", "163875ec",
  "d47d18aa", "8a462408",
];

/** groupLadder, mirrored: a sibling in the same fold group that carries one. */
let ALL: ConsolidatedItem[] = [];
let INDEX: Awaited<ReturnType<typeof loadRelationIndex>>;
function groupLadderFor(name: string) {
  const key = INDEX.groupKey(name);
  if (key === normalizeIngredientName(name)) return null;
  for (const o of ALL) {
    if (INDEX.groupKey(o.canonicalName) !== key) continue;
    const c = rowConversion(o);
    if (c?.subUnit) return c;
  }
  return lookupConversion(key) ?? null;
}

/** The four lines of resolvePurchaseFields, which is module-private. */
function packFor(item: ConsolidatedItem): { purchaseUnit: string | null; purchaseDisplay: string | null } {
  const conv = withGroupLadder(rowConversion(item), groupLadderFor(item.canonicalName));
  const scaled = scalePurchaseForSubUnit(conv, item.quantity, item.unit, {
    packFloor: item.packFloor,
    storedDisplay: item.purchaseDisplay,
  });
  if (scaled && conv?.subUnit) {
    return { purchaseUnit: conv.subUnit.parent, purchaseDisplay: scaled.purchaseDisplay };
  }
  return { purchaseUnit: item.purchaseUnit, purchaseDisplay: item.purchaseDisplay };
}

function render(r: ConsolidatedItem, pack: { purchaseUnit: string | null; purchaseDisplay: string | null }): string {
  const amt = String(r.quantity);
  const unit = r.unit || undefined;
  const staple = r.isUniversalStaple || r.isUserPantryStaple;
  const need = formatNeedText(amt, unit, unit ? `${r.quantity} ${r.unit}` : amt).trim();
  const name = composePackName(r.displayName, pack.purchaseUnit ?? undefined, pack.purchaseDisplay ?? undefined, amt, unit, staple);
  return need ? `${name} (${need})` : name;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient();
  const index = await loadRelationIndex(prisma);
  const ings = await prisma.ingredient.findMany({
    select: {
      canonicalName: true, purchaseUnit: true, purchaseQuantity: true,
      purchaseDisplay: true, conversionRef: true,
      packYieldUnit: true, packYieldPerPack: true,
    },
  });
  const byName = new Map(ings.map((i) => [normalizeIngredientName(i.canonicalName), i]));

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  say("B1 WIRING SMOKE — the REAL production functions over the golden corpus.");
  say(`index: ${index.componentParents.length} component parents · ${index.selfYields.size} self-yields · ${index.clusters.length} clusters`);
  say(`self-yields: ${[...index.selfYields].map(([k, v]) => `${k}=${v.perOne}${v.unit}`).join(", ")}`);
  say(`component parents: ${index.componentParents.map((p) => `${p.parent}[${p.basisUnit}]`).join(", ")}`);
  say("");

  let changed = 0, unchanged = 0;
  for (const id of PLANS) {
    const j = JSON.parse(readFileSync(join(CORPUS, `live__${id}__r1.json`), "utf8"));
    // Re-hydrate: the corpus predates the columns. Catalog facts only — the
    // corpus's own quantities and units are untouched.
    const src: ConsolidatedItem[] = (j.consolidated as ConsolidatedItem[]).map((c) => {
      const row = byName.get(normalizeIngredientName(c.canonicalName));
      return {
        ...c,
        purchaseUnit: row?.purchaseUnit ?? c.purchaseUnit,
        purchaseQuantity: row?.purchaseQuantity ?? c.purchaseQuantity,
        purchaseDisplay: row?.purchaseDisplay ?? c.purchaseDisplay,
        packYieldUnit: row?.packYieldUnit ?? null,
        packYieldPerPack: row?.packYieldPerPack ?? null,
        packFloor: null,
      };
    });

    const before = (j.rendered as { line: string }[]).map((r) => r.line);
    INDEX = index;
    ALL = src;
    const pooled = poolComponentNeeds(src, index);
    const merged = mergeConvertibleGroups(pooled.items, index);
    for (const it of merged) it.quantity = roundNeedQuantity(it.quantity, it.unit);
    const after = merged.map((r) => render(r, packFor(r)));

    const b = new Set(before), a = new Set(after);
    const gone = before.filter((l) => !a.has(l));
    const New = after.filter((l) => !b.has(l));
    unchanged += before.filter((l) => a.has(l)).length;
    changed += gone.length + New.length;
    if (gone.length || New.length || pooled.declines.length) {
      say(`## ${id} — ${j.planTitle}  (${before.length} -> ${after.length} rows)`);
      for (const l of gone) say(`   -  ${l}`);
      for (const l of New) say(`   +  ${l}`);
      for (const f of pooled.folds) say(`   POOL ${f.parent}: raw ${f.rawPool.toFixed(3)} -> ${f.wholeParents} ${f.parentUnit}${f.ridesFree ? " (rides free — need untouched)" : ""} absorbed [${f.absorbed.map((x) => `${x.name} ${x.quantity} ${x.unit}`).join(" | ")}]`);
      for (const d of pooled.declines) say(`   DECLINE ${d.parent} <- ${d.child}: ${d.reason}`);
      say("");
    }
  }
  say(`TOTALS — rendered lines gone/new: ${changed} · identical: ${unchanged}`);
  writeFileSync(join(OUT, "smoke.txt"), lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exit(1); });
