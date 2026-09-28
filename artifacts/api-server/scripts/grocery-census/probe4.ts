// Grocery census — Part A probe 4. READ-ONLY. Loose ends.
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");

async function main() {
  if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
    throw new Error("REFUSING: not the dev branch");
  }

  // 1. BUG-326 — characterise the 3,502 value mismatches.
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { amountRefs: { not: null } },
    select: { stepTextRaw: true, amountRefs: true },
    take: 4000,
  });
  const shapes = new Map<string, number>();
  const samples: string[] = [];
  for (const s of steps) {
    const refs = s.amountRefs as unknown;
    if (!Array.isArray(refs)) continue;
    for (const r of refs as { charStart: number; charEnd: number; quantity: number; unit: string }[]) {
      if (r.charStart < 0 || r.charEnd > s.stepTextRaw.length || r.charStart >= r.charEnd) continue;
      const span = s.stepTextRaw.slice(r.charStart, r.charEnd);
      const m = /[\d.]+/.exec(span);
      const n = m ? parseFloat(m[0]) : NaN;
      if (!Number.isFinite(n) || Math.abs(n - r.quantity) <= 0.01) continue;
      // Why does it differ?
      let shape: string;
      const hasFrac = /[¼½¾⅓⅔⅛⅜⅝⅞]/.test(span);
      const ratio = r.quantity === 0 ? Infinity : n / r.quantity;
      if (hasFrac) shape = "span carries a unicode fraction the numeric scan misses";
      else if (Math.abs(ratio - 0.5) < 0.01 || Math.abs(ratio - 2) < 0.01) shape = "exact 2× / ½× (a servings scale)";
      else if (/\d+\s*-\s*\d+/.test(span)) shape = "span states a RANGE";
      else if (/\bto\b/.test(span)) shape = "span states 'x to y'";
      else shape = "other numeric disagreement";
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      if (samples.length < 12) samples.push(`span="${span}"  ref=${r.quantity} ${r.unit}  |  ${s.stepTextRaw.slice(0, 80)}`);
    }
  }
  console.log("=== BUG-326: shape of the value mismatches ===");
  for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  for (const s of samples) console.log("   ", s);

  // 2. D7 — does any generated row carry BOTH a recurring flag and plan sources?
  console.log("\n=== recurring rows with plan sources, across the live corpus ===");
  let recWithSrc = 0, recTotal = 0;
  const recNames = new Map<string, number>();
  for (const f of readdirSync(OUT).filter((x) => x.startsWith("live__") && x.endsWith(".json"))) {
    const r = JSON.parse(readFileSync(join(OUT, f), "utf8"));
    for (const c of r.consolidated as { canonicalName: string; isRecurringItem: boolean; sources: unknown[] }[]) {
      if (!c.isRecurringItem) continue;
      recTotal++;
      recNames.set(c.canonicalName, (recNames.get(c.canonicalName) ?? 0) + 1);
      if ((c.sources?.length ?? 0) > 0) {
        recWithSrc++;
        console.log(`   ${f}  ${c.canonicalName}  ${c.quantity} ${c.unit}  sources=${c.sources.length}`);
      }
    }
  }
  console.log(`   recurring rows total=${recTotal}, of which carrying plan sources=${recWithSrc}`);
  console.log("   recurring canonicals seen:", JSON.stringify([...recNames.entries()].sort((a, b) => b[1] - a[1])));

  // 3. Chipotle — does any ONE list still carry two spellings?
  console.log("\n=== chipotle spellings per list ===");
  for (const f of readdirSync(OUT).filter((x) => x.startsWith("live__") && x.endsWith(".json"))) {
    const r = JSON.parse(readFileSync(join(OUT, f), "utf8"));
    const hits = (r.final as { canonicalName: string }[]).filter((i) => /chipotle/i.test(i.canonicalName));
    if (hits.length > 1) console.log(`   ${f}: ${hits.map((h) => h.canonicalName).join(" | ")}`);
  }

  // 4. BUG-323 — where do Ingredient names actually render? Count the live
  //    grocery rows whose displayName leads with a capital, split by fixability.
  const gli = await prisma.groceryListItem.findMany({ select: { displayName: true } });
  const lead = (s: string) => /^[A-Z]/.test(s);
  const interior = (s: string) => /[A-Z]/.test(s.slice(1));
  console.log("\n=== BUG-323 on LIVE grocery rows ===");
  console.log(`  rows=${gli.length}  leadingCap=${gli.filter((g) => lead(g.displayName)).length}` +
    `  leadCap-only=${gli.filter((g) => lead(g.displayName) && !interior(g.displayName)).length}` +
    `  leadCap+interior=${gli.filter((g) => lead(g.displayName) && interior(g.displayName)).length}`);

  // 5. DishIngredient names — the other render surface.
  const di = await prisma.dishIngredient.findMany({
    select: { ingredient: { select: { displayName: true } } },
    take: 50000,
  });
  const dn = di.map((d) => d.ingredient?.displayName ?? "").filter(Boolean);
  console.log(`  DishIngredient refs=${dn.length}  leadingCap=${dn.filter(lead).length}` +
    `  leadCap-only=${dn.filter((s) => lead(s) && !interior(s)).length}`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
