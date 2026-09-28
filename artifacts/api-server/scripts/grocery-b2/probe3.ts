// [grocery] B2 · Part A — probe 3. READ-ONLY. Casing (BUG-323) across every table
// that stores a name, plus the romaine/lettuce question probe2 left open.
import { PrismaClient } from "@prisma/client";
const h = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!h.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const leadsCapital = (s: string) => /^[A-Z]/.test(s.trim());

const ings = await prisma.ingredient.findMany({
  select: { id: true, canonicalName: true, displayName: true, category: true },
});
console.log(`Ingredient rows: ${ings.length}`);
const capDisplay = ings.filter((i) => leadsCapital(i.displayName));
const capCanon = ings.filter((i) => leadsCapital(i.canonicalName));
console.log(`  displayName leading capital: ${capDisplay.length}`);
console.log(`  canonicalName leading capital: ${capCanon.length}`);

// every distinct capitalised TOKEN anywhere in displayName, for the exception list
const tokenCount = new Map<string, number>();
for (const i of ings) {
  for (const t of i.displayName.split(/[\s(),/]+/)) {
    if (/^[A-Z]/.test(t) && t.length > 0) tokenCount.set(t, (tokenCount.get(t) ?? 0) + 1);
  }
}
console.log(`\ndistinct capitalised tokens in Ingredient.displayName: ${tokenCount.size}`);
for (const [t, n] of [...tokenCount].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`   ${t}  ×${n}`);
}

console.log("\n--- the 183 (leading-capital displayName) ---");
for (const i of capDisplay.sort((a, b) => a.displayName.localeCompare(b.displayName))) {
  console.log(`   ${i.displayName}   [canonical: ${i.canonicalName}]`);
}

// GroceryListItem — user data, NOT to be touched; counted only.
const gli = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
  `SELECT COUNT(*)::bigint AS n FROM grocery_list_items WHERE "displayName" ~ '^[A-Z]'`,
);
console.log(`\nGroceryListItem rows with leading capital displayName (NOT touched): ${gli[0].n}`);

// romaine / lettuce
const rom = await prisma.ingredientRelation.findMany({
  where: { OR: [
    { from: { canonicalName: { contains: "romaine" } } },
    { to: { canonicalName: { contains: "romaine" } } },
  ] },
  select: { label: true, confidence: true, reviewedByHuman: true,
    from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
});
console.log(`\nromaine edges: ${rom.length}`);
for (const r of rom) console.log(`   ${r.label}  ${r.from.canonicalName} -> ${r.to.canonicalName}  (${r.confidence}${r.reviewedByHuman ? ", reviewed" : ""})`);
await prisma.$disconnect();
