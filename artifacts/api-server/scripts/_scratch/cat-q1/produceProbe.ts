// CAT-Q1 follow-up B item 4 — READ-ONLY. What the grocery consolidator's
// component pass (ingredientRelations.poolComponentNeeds, live in production
// since D-WS9-189 A3) does with a meal's zest/juice lines next to a whole
// "lemon" line: the citrus parents and their slots, then the meal's own lines
// run through the pass with and without the added lemon.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q1/produceProbe.ts [mealId]
import { PrismaClient } from "@prisma/client";

import { poolComponentNeeds } from "../../../src/lib/ingredientRelations";
import { loadRelationIndex } from "../../../src/lib/relationIndexLoader";
import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";

const { host, mode } = assertScriptDatabase("cat-q1/produceProbe");
const MEAL = process.argv[2] ?? "e251f17b-752a-4704-8b13-25ae0acae31b";
const prisma = new PrismaClient();
const index = await loadRelationIndex(prisma);
console.log(`${host} (${mode}) · component parents ${index.componentParents.length}`);
for (const cp of index.componentParents.filter((c) => /^(lemon|lime|orange)s?$/.test(c.parent))) {
  console.log(`  ${cp.parent} (basis ${cp.basisUnit}): ${cp.slots.map((s) => `${s.child} ${s.yieldQuantity} ${s.yieldUnit}${s.coHarvestable ? " co" : " exclusive"}`).join(" · ")}`);
}
const lines = await prisma.dishIngredient.findMany({
  where: { dish: { mealLinks: { some: { mealId: MEAL } } } },
  select: { quantity: true, unit: true, ingredient: { select: { id: true, canonicalName: true, displayName: true, conversionRef: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true } } },
});
const lemon = await prisma.ingredient.findFirst({ where: { canonicalName: "lemon" }, select: { id: true, canonicalName: true, displayName: true, conversionRef: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true } });
await prisma.$disconnect();
const item = (q: number, u: string, i: NonNullable<typeof lemon>) => ({ canonicalName: i.canonicalName, displayName: i.displayName, quantity: q, unit: u, conversionRef: i.conversionRef, ingredientId: i.id, purchaseUnit: i.purchaseUnit, purchaseQuantity: i.purchaseQuantity, purchaseDisplay: i.purchaseDisplay });
const citrus = lines.filter((l) => /lemon|lime|orange/i.test(l.ingredient.canonicalName)).map((l) => item(l.quantity, l.unit, l.ingredient));
const show = (label: string, xs: typeof citrus) => {
  // the pass tops up an existing parent row IN PLACE: print the input first, from copies
  const before = xs.map((x) => `${x.quantity} ${x.unit} ${x.canonicalName}`).join(" · ");
  const r = poolComponentNeeds(xs.map((x) => ({ ...x })), index);
  console.log(`\n${label}\n  in : ${before}\n  out:${r.items.map((x) => `${x.quantity} ${x.unit} ${x.canonicalName}`).join(" · ")}${r.declines.length ? `\n  declines: ${r.declines.map((d) => d.reason).join(" | ")}` : ""}`);
};
show(`${MEAL} as stored (citrus lines only)`, citrus);
if (lemon) {
  show(`+ the editor's "1 each lemon" line, zest and juice lines kept`, [...citrus, item(1, "each", lemon)]);
  show(`+ "1 each lemon", zest and juice lines folded into it (removed)`, [...citrus.filter((x) => x.canonicalName === "lemon"), item(1, "each", lemon)]);
}
