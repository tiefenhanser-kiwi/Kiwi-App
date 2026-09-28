// [grocery] B2 · Part A — probe 4. READ-ONLY.
//   M — every component child with more than one parent, through the REAL index.
//   N — the buy-name population: neutral-oil spellings, cut/size-bearing names,
//       and the parts still named as the buy.
import { PrismaClient } from "@prisma/client";
import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
const h = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!h.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const idx = await loadRelationIndex(prisma);
console.log(`index: ${idx.clusters.length} clusters · ${idx.componentParents.length} component parents · admitted syn ${idx.admittedSynonymCount} comp ${idx.admittedComponentCount}`);

// M — children claimed by more than one parent
const parentsByChild = new Map<string, { parent: string; childNames: string[] }[]>();
for (const p of idx.componentParents) {
  for (const s of p.slots) {
    let a = parentsByChild.get(s.child);
    if (!a) { a = []; parentsByChild.set(s.child, a); }
    a.push({ parent: p.parent, childNames: s.childNames });
  }
}
const multi = [...parentsByChild].filter(([, v]) => v.length > 1).sort();
console.log(`\n=== M — children with >1 admitted parent: ${multi.length} ===`);
for (const [child, ps] of multi) {
  // the rule: (1) already on the list — runtime; (2) most specific — the parent
  // the child's name contains most completely; (3) alphabetical.
  const scored = ps.map((p) => ({
    parent: p.parent,
    contained: child.includes(p.parent) ? p.parent.length : -1,
  })).sort((a, b) => b.contained - a.contained || a.parent.localeCompare(b.parent));
  console.log(`   ${child}`);
  for (const s of scored) console.log(`       parent ${s.parent}  (containment score ${s.contained})`);
  console.log(`       -> rule picks: ${scored[0].parent}`);
}

// N — names on the catalog
const ings = await prisma.ingredient.findMany({
  select: { id: true, canonicalName: true, displayName: true, category: true,
            purchaseUnit: true, purchaseDisplay: true },
});
const used = new Set((await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId));
const live = ings.filter((i) => used.has(i.id));
console.log(`\ncatalog rows: ${ings.length} · reachable from a dish: ${live.length}`);

console.log(`\n=== N.a — 'neutral' / 'oil' spellings ===`);
for (const i of live.filter((x) => /neutral/.test(x.canonicalName)).sort((a,b)=>a.canonicalName.localeCompare(b.canonicalName)))
  console.log(`   ${i.canonicalName}   [${i.category}]`);

const CUT_SPEC = /\b(bone-in|boneless|skin-on|skinless|\d+(\.\d+)?[- ]?inch|\d+\s?mm|\d+cm|\bcount\b|\d+\/\d+ count|thick|thin[- ]cut|center-cut|trimmed|frenched|tails on|peeled and deveined|shell-on)\b/i;
const hits = live.filter((i) => CUT_SPEC.test(i.canonicalName)).sort((a,b)=>a.canonicalName.localeCompare(b.canonicalName));
console.log(`\n=== N.b — cut/size/spec-bearing buy names: ${hits.length} ===`);
for (const i of hits) console.log(`   ${i.canonicalName}   [${i.category}]`);
await prisma.$disconnect();
