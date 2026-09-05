// WS9 D-WS9-189 A2 Phase 1b — READ-ONLY evidence for the two open questions.
// Builds nothing, writes nothing, ships nothing.
//   §1 garlic: catalog rows, edges, the two factors, live head+clove evidence,
//              and whether the parent name survives the representative rule.
//   §2 all 53 admitted component edges as a review table with live pool counts
//      and the actual before/after shopper line text.

import { PrismaClient } from "@prisma/client";

import { consolidatePlanIngredients } from "../../src/lib/groceryList";
import {
  buildRelationIndex,
  poolComponentNeedsUngated,
  type RelationRow,
} from "../../src/lib/ingredientRelations";
import {
  resolveConversion,
  scalePurchaseForSubUnit,
  canonicalUnitToken,
} from "../../src/lib/ingredientConversions";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
// The client formatter resolves as CJS from here, so the named exports are not
// reachable as ESM bindings. Reached through the default object instead — this
// is the REAL renderer the grocery row uses, not a re-implementation.
import groceryFormat from "../../../kiwi/lib/format/grocery";
const { composeGroceryLine, formatNeedText } = groceryFormat as unknown as {
  composeGroceryLine: (
    name: string,
    purchaseUnit: string | null | undefined,
    purchaseDisplay: string | null | undefined,
    needText: string,
    needAmount?: string | number | null,
    needUnit?: string | null,
    isPantryStaple?: boolean,
  ) => string;
  formatNeedText: (
    quantityAmount: string | undefined,
    quantityUnit: string | undefined,
    fallback: string,
  ) => string;
};

const prisma = new PrismaClient();

function bar(t: string) {
  console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
}

// ── YIELD-MAGNITUDE CONFIDENCE ─────────────────────────────────────────────
//
// A2's basis gate checked whether "one unit of the parent" is a well-defined
// PURCHASE. It never checked whether the NUMBER is true. These are the edges
// whose magnitude I would not personally defend, with the reason. A wrong yield
// UNDER-BUYS silently and nothing downstream catches it.
const YIELD_DOUBTS: Record<string, string> = {
  "fresh thyme|fresh thyme sprigs":
    "20 sprigs per bunch: supermarket thyme bunches run 15-40 sprigs and vary by more than 2x. Under-buys at the low end.",
  "fresh cilantro|fresh cilantro sprigs":
    "20 sprigs per bunch: same variance as thyme; a supermarket cilantro bunch is commonly 30+ sprigs.",
  "butter lettuce|butter lettuce leaves":
    "10 leaves per head: a butter lettuce head is usually 20-30 usable leaves. Likely a 2-3x under-buy.",
  "rotisserie chicken|shredded rotisserie chicken":
    "3.5 cup per bird: plausible for breast+thigh meat, but varies with bird size and whether skin/wings count. Under-buys a large recipe.",
  "pepperoncini|pepperoncini brine":
    "1 cup of brine per ONE pepperoncini is not credible - a whole jar carries about that much. Reads like a per-JAR yield filed against a per-EACH basis.",
  "fresh corn|fresh corn kernels":
    "0.75 cup per ear is defensible (a medium ear is ~0.75 cup) but runs low for large ears.",
  "leeks|leeks, white and light green parts only":
    "0.5 each: this is a DISCARD-prep yield, not a count - half a leek by length, not half a leek by number. The unit is doing two jobs.",
  "cilantro|fresh cilantro stems":
    "0.5 cup stems per bunch alongside 1 cup leaves: the two are co-harvestable, so this only matters if a recipe wants stems alone.",
};

async function loadRows(): Promise<RelationRow[]> {
  const rows = await prisma.ingredientRelation.findMany({
    include: {
      from: { select: { canonicalName: true, defaultUnit: true } },
      to: { select: { canonicalName: true } },
    },
  });
  return rows.map((r) => ({
    label: r.label as RelationRow["label"],
    fromCanonicalName: r.from.canonicalName,
    toCanonicalName: r.to.canonicalName,
    yieldQuantity: r.yieldQuantity,
    yieldUnit: r.yieldUnit,
    coHarvestable: r.coHarvestable,
    confidence: r.confidence as RelationRow["confidence"],
    reviewedByHuman: r.reviewedByHuman,
    fromDefaultUnit: r.from.defaultUnit,
  }));
}

/** The line the shopper actually reads, rendered by the CLIENT formatter. */
function shopperLine(it: {
  displayName: string;
  quantity: number;
  unit: string;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
  canonicalName: string;
  conversionRef: unknown;
  isUniversalStaple?: boolean;
  isUserPantryStaple?: boolean;
}): string {
  // Mirror resolvePurchaseFields: the pack is head-scaled when a subUnit applies.
  const conv = resolveConversion(it.canonicalName, it.conversionRef);
  const scaled = scalePurchaseForSubUnit(conv, it.quantity, it.unit);
  const pUnit = scaled && conv?.subUnit ? conv.subUnit.parent : it.purchaseUnit;
  const pDisp = scaled && conv?.subUnit ? scaled.purchaseDisplay : it.purchaseDisplay;
  const needText = formatNeedText(
    String(it.quantity),
    it.unit,
    `${it.quantity} ${it.unit}`,
  );
  try {
    return composeGroceryLine(
      it.displayName,
      pUnit,
      pDisp,
      needText,
      it.quantity,
      it.unit,
      Boolean(it.isUniversalStaple || it.isUserPantryStaple),
    );
  } catch {
    return `${it.displayName} (${it.quantity} ${it.unit})`;
  }
}

async function main() {
  const rows = await loadRows();
  const index = buildRelationIndex(rows);

  // ─────────────────────────────────────────────────────────────────────────
  bar("§1.1 — every GARLIC catalog row, and every relation edge among them");
  const garlicRows = await prisma.ingredient.findMany({
    where: { canonicalName: { contains: "garlic" } },
    select: { id: true, canonicalName: true, defaultUnit: true, conversionRef: true,
              purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true },
    orderBy: { canonicalName: "asc" },
  });
  console.log(`garlic catalog rows: ${garlicRows.length}`);
  for (const g of garlicRows) {
    const conv = resolveConversion(g.canonicalName, g.conversionRef);
    const su = conv?.subUnit
      ? `subUnit ${conv.subUnit.perParent} ${conv.subUnit.child} per ${conv.subUnit.parent}`
      : "no subUnit";
    console.log(
      `  ${g.canonicalName.padEnd(34)} defaultUnit=${(g.defaultUnit ?? "").padEnd(8)} pack=${String(g.purchaseDisplay ?? "-").padEnd(16)} ${su}`,
    );
  }

  const gIds = new Set(garlicRows.map((g) => g.id));
  const edges = await prisma.ingredientRelation.findMany({
    where: { OR: [{ fromIngredientId: { in: [...gIds] } }, { toIngredientId: { in: [...gIds] } }] },
    include: { from: { select: { canonicalName: true, defaultUnit: true } }, to: { select: { canonicalName: true } } },
    orderBy: [{ label: "asc" }],
  });
  console.log(`\nrelation edges touching a garlic row: ${edges.length}`);
  for (const e of edges) {
    const yieldTxt = e.yieldQuantity != null ? ` [${e.yieldQuantity} ${e.yieldUnit}, co=${e.coHarvestable}]` : "";
    const admitted =
      e.label === "component"
        ? index.componentParents.some((p) =>
            p.parent === index.groupKey(e.from.canonicalName) &&
            p.slots.some((s) => s.child === index.groupKey(e.to.canonicalName)),
          )
        : e.label === "synonym"
          ? index.synonymFold(normalizeIngredientName(e.from.canonicalName)) ===
            index.synonymFold(normalizeIngredientName(e.to.canonicalName))
          : false;
    console.log(
      `  [${e.label.padEnd(9)}] ${e.from.canonicalName} (defaultUnit ${e.from.defaultUnit}) -> ${e.to.canonicalName}${yieldTxt}  ${admitted ? "ADMITTED" : "not admitted"}`,
    );
  }

  bar("§1.3 — the TWO factors, quoted from both sources");
  const headConv = resolveConversion("garlic head", null) ?? resolveConversion("garlic", null);
  console.log(`ingredientConversions.subUnit for garlic: ${JSON.stringify(headConv?.subUnit ?? null)}`);
  const headEdges = edges.filter((e) => e.label === "component" && e.to.canonicalName === "garlic");
  for (const e of headEdges) {
    console.log(`relation edge ${e.from.canonicalName} -> ${e.to.canonicalName}: yieldQuantity=${e.yieldQuantity} yieldUnit=${e.yieldUnit}`);
  }
  console.log(
    `\nAGREE? subUnit.perParent=${headConv?.subUnit?.perParent} vs edge yieldQuantity=${headEdges[0]?.yieldQuantity} -> ${headConv?.subUnit?.perParent === headEdges[0]?.yieldQuantity ? "YES, both 10" : "NO - THEY DISAGREE"}`,
  );

  bar("§1.4 — does the PARENT name survive the shortest-name representative rule?");
  const garlicParents = index.componentParents.filter((p) => p.parent.includes("garlic"));
  for (const p of garlicParents) {
    console.log(`  component parent key: "${p.parent}"  basis 1 ${p.basisUnit}`);
    for (const s of p.slots) console.log(`      -> slot "${s.child}"  spellings: ${s.childNames.join(" | ")}`);
  }
  const gcluster = index.clusters.filter((c) => c.members.some((m) => m.includes("garlic")));
  console.log(`\ngarlic synonym clusters: ${gcluster.length}`);
  // " | " not ", " — several members carry commas of their own.
  for (const c of gcluster) console.log(`  {${c.members.join(" | ")}} -> representative "${c.representative}"`);
  console.log(
    `\ngroupKey("garlic head")=${index.groupKey("garlic head")}   groupKey("garlic")=${index.groupKey("garlic")}   groupKey("head of garlic")=${index.groupKey("head of garlic")}`,
  );
  console.log(
    `Are "garlic head" and "garlic" in ONE fold? ${index.groupKey("garlic head") === index.groupKey("garlic") ? "YES - the pool would emit the wrong name" : "NO - they stay distinct, so the pool keeps the PARENT"}`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  bar("§1.2 — LIVE evidence: a list carrying BOTH a head demand and a clove demand");
  const lists = await prisma.groceryList.findMany({
    where: { status: { not: "archived" } },
    select: { id: true, userId: true, mealPlanInstanceId: true },
  });
  interface EdgeStat { pools: number; example: string | null }
  const stats = new Map<string, EdgeStat>();
  const headAndClove: string[] = [];
  let listsWithCloveOnly = 0;
  let listsWithHeadOnly = 0;
  let listsWithBoth = 0;

  for (const l of lists) {
    if (!l.mealPlanInstanceId) continue;
    let before;
    try {
      before = await consolidatePlanIngredients({ prisma, planId: l.mealPlanInstanceId, userId: l.userId });
    } catch { continue; }

    // garlic head/clove census on the PRE-pool rows
    const headRows = before.filter(
      (b) => ["garlic head", "head of garlic", "whole garlic head"].includes(normalizeIngredientName(b.canonicalName)),
    );
    const cloveRows = before.filter(
      (b) => normalizeIngredientName(b.canonicalName) === "garlic" && canonicalUnitToken(b.unit) === "clove",
    );
    if (headRows.length && cloveRows.length) {
      listsWithBoth++;
      // The pool ALONE is not the answer — mergeConvertibleGroups runs after it.
      // Read the FULL pipeline output, which is what the shopper gets.
      const pooled = poolComponentNeedsUngated(before.map((b) => ({ ...b })), index);
      const full = await consolidatePlanIngredients({
        prisma,
        planId: l.mealPlanInstanceId,
        userId: l.userId,
        relations: index,
      });
      const isGarlicBuy = (n: string) =>
        ["garlic head", "head of garlic", "whole garlic head"].includes(normalizeIngredientName(n)) ||
        normalizeIngredientName(n) === "garlic";
      const cloveTotal = cloveRows.reduce((s, r) => s + r.quantity, 0);
      const headTotal = headRows.reduce((s, r) => s + r.quantity, 0);
      const hansCloves = headTotal * 10 + cloveTotal;
      const hansHeads = Math.ceil(hansCloves / 10 - 1e-9);
      const finalGarlic = full.filter((i) => isGarlicBuy(i.canonicalName));
      const finalHeads = finalGarlic
        .filter((i) => canonicalUnitToken(i.unit) === canonicalUnitToken("each") || canonicalUnitToken(i.unit) === canonicalUnitToken("head"))
        .reduce((s, i) => s + i.quantity, 0);
      headAndClove.push(
        `  [${l.id.slice(0, 8)}] BEFORE: ${headRows.map((r) => `"${r.canonicalName}" ${r.quantity} ${r.unit}`).join(" + ")}  +  ${cloveRows.map((r) => `"${r.canonicalName}" ${r.quantity} ${r.unit}`).join(" + ")}\n` +
        `             HANS'S RULE : ${headTotal} head x10 + ${cloveTotal} clove = ${hansCloves} cloves -> ceil(${(hansCloves / 10).toFixed(2)}) = ${hansHeads} heads, ONE line\n` +
        `             after POOL  : ${pooled.items.filter((i) => isGarlicBuy(i.canonicalName)).map((i) => `"${i.canonicalName}" ${i.quantity} ${i.unit}`).join("  +  ")}\n` +
        `             after MERGE : ${finalGarlic.map((i) => `"${i.canonicalName}" ${i.quantity} ${i.unit}`).join("  +  ")}\n` +
        `             SHOPPER SEES: ${finalGarlic.map((i) => shopperLine(i as any)).join("   |   ")}\n` +
        `             VERDICT     : ${finalGarlic.length} garlic line(s), ${finalHeads} head-equivalents vs Hans's ${hansHeads} -> ${finalGarlic.length === 1 && finalHeads === hansHeads ? "MATCHES SPEC" : finalGarlic.length > 1 ? "TWO LINES = BUG-200 STILL OPEN" : "QUANTITY DIVERGES"}`,
      );
    } else if (headRows.length) listsWithHeadOnly++;
    else if (cloveRows.length) listsWithCloveOnly++;

    // §2 live pool census + example lines
    const pooled = poolComponentNeedsUngated(before.map((b) => ({ ...b })), index);
    for (const f of pooled.folds) {
      for (const s of f.slots) {
        const k = `${f.parent}|${s.child}`;
        let st = stats.get(k);
        if (!st) { st = { pools: 0, example: null }; stats.set(k, st); }
        st.pools++;
        if (!st.example) {
          const absorbedRows = before.filter((b) => index.groupKey(b.canonicalName) === s.child);
          const beforeText = absorbedRows.map((r) => shopperLine(r as any)).join("   |   ");
          const survivor = pooled.items.find((i) => index.groupKey(i.canonicalName) === f.parent);
          const afterText = survivor ? shopperLine(survivor as any) : "(none)";
          st.example = `BEFORE  ${beforeText}\n                    AFTER   ${afterText}`;
        }
      }
    }
  }

  console.log(`non-archived plan-backed lists scanned: ${lists.filter((l) => l.mealPlanInstanceId).length}`);
  console.log(`  lists with a HEAD demand only : ${listsWithHeadOnly}`);
  console.log(`  lists with a CLOVE demand only: ${listsWithCloveOnly}`);
  console.log(`  lists with BOTH               : ${listsWithBoth}`);
  if (headAndClove.length === 0) {
    console.log(`\n>>> NO LIVE LIST EXHIBITS BOTH. The head+clove case Hans specified does not`);
    console.log(`    occur in the current catalog+plan corpus, so BUG-200's double-line cannot`);
    console.log(`    be reproduced from live data today. Fixture-only.`);
  } else {
    for (const h of headAndClove) console.log(h);
  }

  // ─────────────────────────────────────────────────────────────────────────
  bar("§2 — ALL ADMITTED COMPONENT EDGES, sorted by live pools descending");
  interface Row {
    parent: string; child: string; yieldTxt: string; basis: string; co: string;
    pools: number; example: string | null; doubt: string | null;
  }
  const table: Row[] = [];
  for (const p of index.componentParents) {
    for (const s of p.slots) {
      const k = `${p.parent}|${s.child}`;
      table.push({
        parent: p.parent,
        child: s.child,
        yieldTxt: `${s.yieldQuantity} ${s.yieldUnit}`,
        basis: `1 ${p.basisUnit}`,
        co: s.coHarvestable ? "true (max)" : "false (sum)",
        pools: stats.get(k)?.pools ?? 0,
        example: stats.get(k)?.example ?? null,
        doubt: YIELD_DOUBTS[k] ?? null,
      });
    }
  }
  table.sort((a, b) => b.pools - a.pools || a.parent.localeCompare(b.parent));
  console.log(`admitted component slots: ${table.length}   (edges collapsed into slots by the synonym fold)`);
  console.log(`slots that fired on live data: ${table.filter((r) => r.pools > 0).length}`);
  console.log(`slots that never fired:        ${table.filter((r) => r.pools === 0).length}`);
  console.log(`total live pools:              ${table.reduce((s, r) => s + r.pools, 0)}`);
  console.log(`slots with a yield I would NOT defend: ${table.filter((r) => r.doubt).length}`);
  console.log();
  console.log(
    "parent".padEnd(26) + "child".padEnd(36) + "yield".padEnd(12) + "basis".padEnd(9) + "coHarvest".padEnd(13) + "pools".padEnd(7) + "yield?",
  );
  console.log("-".repeat(120));
  for (const r of table) {
    console.log(
      r.parent.padEnd(26) + r.child.padEnd(36) + r.yieldTxt.padEnd(12) + r.basis.padEnd(9) +
        r.co.padEnd(13) + String(r.pools).padEnd(7) + (r.doubt ? "DOUBTED" : "ok"),
    );
  }

  bar("§2b — the shopper line, before and after, for every slot that fires");
  for (const r of table.filter((x) => x.pools > 0)) {
    console.log(`\n  ${r.parent}  <-  ${r.child}   [${r.yieldTxt} per ${r.basis}, coHarvestable ${r.co}]   ${r.pools} live pools`);
    console.log(`                    ${r.example}`);
  }

  bar("§2c — yields I would NOT personally defend, with the reason");
  for (const r of table.filter((x) => x.doubt)) {
    console.log(`\n  ${r.parent} -> ${r.child}  [${r.yieldTxt} per ${r.basis}]  (${r.pools} live pools)`);
    console.log(`      ${r.doubt}`);
  }

  bar("§2d — would relabelling `egg <-> hard-boiled eggs` as a COMPONENT work?");
  const eggParent = index.componentParents.find((p) => p.parent === "egg");
  console.log(`"egg" is an admitted component parent: ${Boolean(eggParent)}`);
  if (eggParent) {
    console.log(`  basis: 1 ${eggParent.basisUnit}   existing slots: ${eggParent.slots.map((s) => `${s.child} [${s.yieldQuantity} ${s.yieldUnit}, co=${s.coHarvestable}]`).join(" | ")}`);
  }
  const hypothetical: RelationRow[] = [
    ...rows,
    {
      label: "component",
      fromCanonicalName: "egg",
      toCanonicalName: "hard-boiled eggs",
      yieldQuantity: 1,
      yieldUnit: "each",
      coHarvestable: false,
      confidence: "high",
      reviewedByHuman: false,
      fromDefaultUnit: "each",
    },
  ];
  const hIdx = buildRelationIndex(hypothetical);
  const probe = poolComponentNeedsUngated(
    [
      { canonicalName: "hard-boiled eggs", displayName: "hard-boiled eggs", quantity: 4, unit: "each" },
    ],
    hIdx,
  );
  console.log(`\n  PROBE (not shipped): "hard-boiled eggs 4 each" with the relabelled edge ->`);
  for (const i of probe.items) console.log(`      "${i.canonicalName}" ${i.quantity} ${i.unit}`);
  console.log(`  folds: ${probe.folds.length}  declines: ${probe.declines.length}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
