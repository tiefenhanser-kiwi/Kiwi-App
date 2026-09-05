// Phase 0 probe 3 — shape of the synonym graph and the component edges,
// and the preconditions a reader would need. READ ONLY.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const all = await prisma.ingredientRelation.findMany({
    include: {
      from: { select: { id: true, canonicalName: true } },
      to: { select: { id: true, canonicalName: true } },
    },
  });
  const syn = all.filter((r) => r.label === "synonym");
  const comp = all.filter((r) => r.label === "component");
  const dist = all.filter((r) => r.label === "distinct");
  const subs = all.filter((r) => r.label === "subsumes");
  console.log(`edges: synonym ${syn.length} component ${comp.length} distinct ${dist.length} subsumes ${subs.length}`);

  // ── synonym connected components (transitive closure) ──
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    if (r !== x) { r = find(r); parent.set(x, r); }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const names = new Map<string, string>();
  for (const e of syn) {
    names.set(e.from.id, e.from.canonicalName);
    names.set(e.to.id, e.to.canonicalName);
    if (!parent.has(e.from.id)) parent.set(e.from.id, e.from.id);
    if (!parent.has(e.to.id)) parent.set(e.to.id, e.to.id);
    union(e.from.id, e.to.id);
  }
  const clusters = new Map<string, string[]>();
  for (const id of names.keys()) {
    const r = find(id);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(id);
  }
  const sizes = new Map<number, number>();
  for (const c of clusters.values()) sizes.set(c.length, (sizes.get(c.length) ?? 0) + 1);
  console.log(`\n=== synonym transitive clusters ===`);
  console.log(`  distinct catalog rows touched by a synonym edge: ${names.size}`);
  console.log(`  clusters: ${clusters.size}`);
  for (const [sz, n] of [...sizes].sort((a, b) => a[0] - b[0])) {
    console.log(`    size ${String(sz).padStart(2)}: ${n} cluster(s)   (${sz * n} rows)`);
  }
  const big = [...clusters.values()].filter((c) => c.length >= 4);
  console.log(`  clusters of size >= 4: ${big.length}`);
  for (const c of big.sort((a, b) => b.length - a.length)) {
    console.log(`    [${c.length}] ${c.map((i) => names.get(i)).sort().join(" | ")}`);
  }

  // ── CONTRADICTION: does a synonym cluster contain a pair authored `distinct`? ──
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const distSet = new Set(dist.map((e) => key(e.from.id, e.to.id)));
  let clash = 0;
  const clashes: string[] = [];
  for (const c of clusters.values()) {
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        if (distSet.has(key(c[i], c[j]))) {
          clash++;
          clashes.push(`${names.get(c[i])}  <->  ${names.get(c[j])}`);
        }
      }
    }
  }
  console.log(`\n=== transitive-closure contradictions (pair inside one synonym cluster carries an authored \`distinct\`) ===`);
  console.log(`  count: ${clash}`);
  for (const c of clashes) console.log(`    ${c}`);

  // Same check for DIRECT synonym edges vs distinct (should be 0 by A1 design)
  const synSet = new Set(syn.map((e) => key(e.from.id, e.to.id)));
  const direct = [...synSet].filter((k) => distSet.has(k));
  console.log(`  direct synonym+distinct on the same pair: ${direct.length}`);

  // ── component edges ──
  console.log(`\n=== component edges: ${comp.length} ===`);
  const noYield = comp.filter((e) => e.yieldQuantity == null || e.yieldUnit == null);
  const noCo = comp.filter((e) => e.coHarvestable == null);
  console.log(`  missing yieldQuantity/yieldUnit: ${noYield.length}`);
  console.log(`  missing coHarvestable: ${noCo.length}`);
  console.log(`  coHarvestable=true: ${comp.filter((e) => e.coHarvestable === true).length}`);
  console.log(`  coHarvestable=false: ${comp.filter((e) => e.coHarvestable === false).length}`);
  console.log(`  reviewedByHuman: ${comp.filter((e) => e.reviewedByHuman).length}`);
  const yieldUnits = new Map<string, number>();
  for (const e of comp) yieldUnits.set(e.yieldUnit ?? "(null)", (yieldUnits.get(e.yieldUnit ?? "(null)") ?? 0) + 1);
  console.log(`  yieldUnit histogram: ${[...yieldUnits].sort((a,b)=>b[1]-a[1]).map(([u,n])=>`${u}=${n}`).join("  ")}`);

  // parents with >1 component edge — where the max/sum pooling actually matters
  const byParent = new Map<string, typeof comp>();
  for (const e of comp) {
    if (!byParent.has(e.from.id)) byParent.set(e.from.id, [] as any);
    byParent.get(e.from.id)!.push(e);
  }
  const multi = [...byParent.entries()].filter(([, v]) => v.length > 1);
  console.log(`  distinct parents: ${byParent.size};  parents with >1 child edge: ${multi.length}`);
  for (const [, v] of multi.sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${v[0].from.canonicalName}:`);
    for (const e of v) console.log(`        -> ${e.to.canonicalName}  [${e.yieldQuantity} ${e.yieldUnit}, coHarvestable=${e.coHarvestable}]${e.reviewedByHuman ? " HUMAN" : ""}`);
  }

  // Is a component `to` ever also a component `from`? (chain depth)
  const fromIds = new Set(comp.map((e) => e.from.id));
  const chains = comp.filter((e) => fromIds.has(e.to.id));
  console.log(`  component edges whose \`to\` is itself a component parent (chains): ${chains.length}`);
  for (const e of chains) console.log(`    ${e.from.canonicalName} -> ${e.to.canonicalName} (which is itself a parent)`);

  // Does a component endpoint also sit in a synonym cluster? (reader interaction)
  const compIds = new Set([...comp.map(e=>e.from.id), ...comp.map(e=>e.to.id)]);
  const overlap = [...compIds].filter((i) => names.has(i));
  console.log(`  component endpoints that also carry a synonym edge: ${overlap.length}`);
  for (const i of overlap) console.log(`    ${names.get(i)}`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
