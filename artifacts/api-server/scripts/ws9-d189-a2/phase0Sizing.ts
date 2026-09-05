// Phase 0 probe 5 — SIZING ONLY (not the §2 dry run). How many LIVE, persisted
// grocery-list rows sit in a synonym cluster with another row on the SAME list?
// Joins persisted items -> Ingredient by ingredientId. READ ONLY.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const syn = await prisma.ingredientRelation.findMany({
    where: { label: "synonym" },
    select: { fromIngredientId: true, toIngredientId: true, reviewedByHuman: true },
  });
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = parent.get(x) ?? x; if (r !== x) { r = find(r); parent.set(x, r);} return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of syn) {
    if (!parent.has(e.fromIngredientId)) parent.set(e.fromIngredientId, e.fromIngredientId);
    if (!parent.has(e.toIngredientId)) parent.set(e.toIngredientId, e.toIngredientId);
    union(e.fromIngredientId, e.toIngredientId);
  }

  const items = await prisma.groceryListItem.findMany({
    select: { groceryListId: true, ingredientId: true, displayName: true, unit: true, quantity: true, deletedAt: true },
  });
  const live = items.filter((i) => i.deletedAt == null);
  console.log(`persisted grocery items: ${items.length} (non-soft-deleted: ${live.length})`);
  console.log(`  with ingredientId: ${live.filter((i) => i.ingredientId).length}`);
  console.log(`  ingredientId NULL: ${live.filter((i) => !i.ingredientId).length}`);

  // per-list cluster occupancy
  const byList = new Map<string, typeof live>();
  for (const i of live) {
    if (!i.ingredientId) continue;
    if (!parent.has(i.ingredientId)) continue; // not in any synonym cluster
    if (!byList.has(i.groceryListId)) byList.set(i.groceryListId, [] as any);
    byList.get(i.groceryListId)!.push(i);
  }
  let collidingLists = 0;
  let collidingRows = 0;
  const examples: string[] = [];
  for (const [listId, rows] of byList) {
    const byCluster = new Map<string, typeof rows>();
    for (const r of rows) {
      const c = find(r.ingredientId!);
      if (!byCluster.has(c)) byCluster.set(c, [] as any);
      byCluster.get(c)!.push(r);
    }
    let listHas = false;
    for (const [, grp] of byCluster) {
      if (grp.length > 1) {
        listHas = true;
        collidingRows += grp.length;
        examples.push(`  list ${listId.slice(0, 8)}: ${grp.map((g) => `"${g.displayName}" ${g.quantity} ${g.unit}`).join("  +  ")}`);
      }
    }
    if (listHas) collidingLists++;
  }
  console.log(`\n=== live rows already co-occurring inside ONE synonym cluster on ONE list ===`);
  console.log(`  lists affected: ${collidingLists} / ${await prisma.groceryList.count()}`);
  console.log(`  rows involved: ${collidingRows}`);
  console.log(`  co-occurring groups: ${examples.length}`);
  for (const e of examples) console.log(e);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
