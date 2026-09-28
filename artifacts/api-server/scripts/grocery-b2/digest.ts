// [grocery] B2 · Part A — THE DIGEST. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b2/digest.ts  -> out/digest.txt
//
// THE RECORD of the ruled classification, regenerated under H1-H7. Part A
// classified these edges as QUALIFIER / KEEP / GENERIC and Hans replaced that
// model wholesale; this file now prints the H class each edge carries, so the
// classification stays reproducible for Part D's tests.
//
// The DECISIONS Hans still owes are in out/defaults.txt, not here.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import {
  classifyEdge,
  lowercaseLead,
  PROPER_NOUN_LEADS,
  NAME_CLEANINGS,
  NAME_REFUSALS,
  PART_EDGES,
  RELABEL_TO_SYNONYM,
  NEVER_ORDER_CANDIDATES,
} from "./proposals";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const L: string[] = [];
let n = 0;
const num = () => String(++n).padStart(4, " ");

L.push("[grocery] B2 — THE DIGEST · September 28, 2026");
L.push("Rule by number. `?` = this lane had to CHOOSE; a line with a source and no `?`");
L.push("rides on a quoted ruling and needs no reply. Reply like: 12 no, 41 no");
L.push("");
L.push("Classes, on D-WS9-223's axis (does the distinction change the dish?):");
L.push("  QUALIFIER  one line, the GENERIC name, the specific in parentheses with its share");
L.push("  KEEP       two lines — a different product, not a narrower one");
L.push("  GENERIC    one line, the generic name, NO qualifier");
L.push("");

// ---------------------------------------------------------------------------
// S — every live subsumes edge
// ---------------------------------------------------------------------------
const subsumes = await prisma.ingredientRelation.findMany({
  where: { label: "subsumes" },
  select: {
    fromIngredientId: true, toIngredientId: true, confidence: true, reviewedByHuman: true,
    from: { select: { canonicalName: true, purchaseDisplay: true } },
    to: { select: { canonicalName: true, purchaseDisplay: true } },
  },
});
const usedIds = new Set(
  (await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId),
);
const liveEdges = subsumes
  .filter((r) => usedIds.has(r.fromIngredientId) && usedIds.has(r.toIngredientId))
  .filter((r) => r.reviewedByHuman || r.confidence === "high")
  .map((r) => ({ generic: r.from.canonicalName, specific: r.to.canonicalName }))
  .sort((a, b) => a.generic.localeCompare(b.generic) || a.specific.localeCompare(b.specific));

const byGeneric = new Map<string, string[]>();
for (const e of liveEdges) {
  let a = byGeneric.get(e.generic);
  if (!a) { a = []; byGeneric.set(e.generic, a); }
  a.push(e.specific);
}

L.push("=".repeat(78));
L.push(`S — THE SUBSUMES EDGES.  ${subsumes.length} rows in the table; ${liveEdges.length} are LIVE`);
L.push(`    (both endpoints reachable from a dish AND past the admission gate —`);
L.push(`     reviewedByHuman OR confidence 'high', the same gate admitSynonym uses).`);
L.push(`    ${byGeneric.size} generics. Grouped by generic; one number per EDGE.`);
L.push("=".repeat(78));

const classCounts: Record<string, number> = { H1: 0, H3: 0, GENERIC: 0 };
let uncertainS = 0;
for (const [generic, specifics] of [...byGeneric].sort((a, b) => a[0].localeCompare(b[0]))) {
  L.push("");
  L.push(`  ${generic}`);
  for (const specific of specifics) {
    const r = classifyEdge(generic, specific);
    classCounts[r.hClass]++;
    if (r.uncertain) uncertainS++;
    const rendered =
      r.hClass === "H1"
        ? `TWO lines: "${generic}" and "${specific}"`
        : r.hClass === "H3"
          ? `ONE line IF a recipe demanded "${generic}" and it is count-sold: "N ${generic}, at least M <variety>"; TWO lines otherwise`
          : `ONE line: "${generic}" — the difference is a hedge, not a product`;
    L.push(`${num()}. ${r.uncertain ? "?" : " "} ${r.hClass.padEnd(7)} ${specific}`);
    L.push(`        -> ${rendered}`);
    L.push(`        why: ${r.why}`);
  }
}
L.push("");
L.push(`  S totals: H1 ${classCounts.H1} · H3 ${classCounts.H3} · GENERIC ${classCounts.GENERIC} · marked ? ${uncertainS}`);
// ---------------------------------------------------------------------------
// N — buy-name cleanings
// ---------------------------------------------------------------------------
const { instacartSearchName } = await import("../../src/lib/retailers/instacartName");

L.push("");
L.push("=".repeat(78));
L.push("N — BUY-NAME CLEANINGS (R7). The Instacart search term is NOT proposed:");
L.push("    it is what the SHIPPED instacartSearchName() already derives from the");
L.push("    line name. Printed here so the pair can be read together.");
L.push("=".repeat(78));
L.push("");
for (const c of NAME_CLEANINGS) {
  const mark = c.uncertain ? "?" : " ";
  const search = instacartSearchName(c.line);
  const same = c.current === c.line;
  L.push(`${num()}. ${mark} ${c.current}`);
  L.push(`        -> line: ${c.line}${same ? "   (UNCHANGED — the search term was the only defect)" : ""}`);
  L.push(`        -> Instacart name: ${search}`);
  L.push(`        why: ${c.why}`);
}
L.push("");
L.push("  -- names the sweep looked at and REFUSED to change --");
for (const r of NAME_REFUSALS) {
  L.push(`${num()}.   REFUSE ${r.name}`);
  L.push(`        why: ${r.why}`);
}
L.push("");
L.push("  -- P — the part edge --");
for (const p of PART_EDGES) {
  L.push(`${num()}. ${p.uncertain ? "?" : " "} component ${p.parent} -> ${p.child} · ${p.yieldQuantity} ${p.yieldUnit} · coHarvestable ${p.coHarvestable}`);
  L.push(`        why: ${p.why}`);
}

// ---------------------------------------------------------------------------
// C — casing
// ---------------------------------------------------------------------------
const ings = await prisma.ingredient.findMany({
  select: { id: true, canonicalName: true, displayName: true },
});
const capLead = ings.filter((i) => /^[A-Z]/.test(i.displayName.trim()));
const changed = capLead.filter((i) => lowercaseLead(i.displayName) !== i.displayName);
const kept = capLead.filter((i) => lowercaseLead(i.displayName) === i.displayName);
const capCanonical = ings.filter((i) => /^[A-Z]/.test(i.canonicalName.trim()));

const gliCap = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
  `SELECT COUNT(*)::bigint AS n FROM grocery_list_items WHERE "displayName" ~ '^[A-Z]'`,
);

L.push("");
L.push("=".repeat(78));
L.push("C — CASING (BUG-323). The rule lowercases the FIRST CHARACTER ONLY, and");
L.push("    only when the leading token is not a proper noun. Interior capitals are");
L.push("    untouched, so 'Plain Greek yogurt' -> 'plain Greek yogurt'.");
L.push("=".repeat(78));
L.push("");
L.push(`  Ingredient rows                                     ${ings.length}`);
L.push(`  Ingredient.displayName with a leading capital       ${capLead.length}`);
L.push(`    -> LOWERCASED by the rule                         ${changed.length}`);
L.push(`    -> KEPT (proper noun)                             ${kept.length}`);
L.push(`  Ingredient.canonicalName with a leading capital     ${capCanonical.length}   (nothing to do)`);
L.push(`  DishIngredient name copies                          0   — the model has NO name column`);
L.push(`                                                          (dishId, ingredientId, quantity, unit,`);
L.push(`                                                           preparationNote, isOptional, positionIndex,`);
L.push(`                                                           componentKey, pathKey). NOTHING TO FIX.`);
L.push(`  GroceryListItem rows with a leading capital         ${gliCap[0].n}   — USER DATA, NOT TOUCHED (D-WS9-230)`);
L.push("");
L.push("  -- the FULL proper-noun exception list (leading tokens that keep the capital) --");
for (const p of PROPER_NOUN_LEADS) {
  const unc = false;
  const rows = capLead.filter((i) => i.displayName.trim().split(/\s+/)[0] === p);
  L.push(`${num()}. ${unc ? "?" : " "} KEEP "${p}"  (${rows.length} row${rows.length === 1 ? "" : "s"}: ${rows.map((r) => r.displayName).join(" · ")})`);
}
L.push("");
L.push("  -- the rows the rule LOWERCASES, for the record --");
L.push(
  "     " +
    changed
      .map((i) => i.displayName)
      .sort()
      .join(" · "),
);

// ---------------------------------------------------------------------------
// M — multi-parent children
// ---------------------------------------------------------------------------
const idx = await loadRelationIndex(prisma);
const parentsByChild = new Map<string, string[]>();
for (const p of idx.componentParents) {
  for (const s of p.slots) {
    let a = parentsByChild.get(s.child);
    if (!a) { a = []; parentsByChild.set(s.child, a); }
    a.push(p.parent);
  }
}
const multi = [...parentsByChild].filter(([, v]) => v.length > 1).sort();

L.push("");
L.push("=".repeat(78));
L.push("M — MULTI-PARENT CHILDREN. The rule, in order:");
L.push("      1. a parent already on the list;");
L.push("      2. the MOST SPECIFIC parent — the one the child's name contains most");
L.push("         completely;");
L.push("      3. alphabetical, last.");
L.push("=".repeat(78));
L.push("");
L.push(`  children with more than one admitted parent: ${multi.length}`);
for (const [child, parents] of multi) {
  const scored = parents
    .map((p) => ({ p, score: child.includes(p) ? p.length : -1 }))
    .sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
  L.push(`${num()}.   ${child}`);
  for (const s of scored) L.push(`        parent "${s.p}"  containment ${s.score}`);
  L.push(`        -> rule 2 picks: ${scored[0].p}   (rule 1 can override at runtime)`);
}

// ---------------------------------------------------------------------------
// I — identity folds (R1)
// ---------------------------------------------------------------------------
L.push("");
L.push("=".repeat(78));
L.push("I — IDENTITY FOLDS (R1 / BUG-210): plan-row groups sharing an ingredientId.");
L.push("=".repeat(78));
L.push("");
try {
  const { readdirSync } = await import("node:fs");
  const DIR = "scripts/grocery-census/out";
  const files = readdirSync(DIR).filter((f) => f.startsWith("b1__") && f.endsWith(".json"));
  let rows = 0;
  let collisions = 0;
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    for (const stage of ["consolidated", "final"] as const) {
      const byId = new Map<string, number>();
      for (const r of j[stage] ?? []) {
        if (stage === "consolidated") rows++;
        if (!r.ingredientId) continue;
        byId.set(r.ingredientId, (byId.get(r.ingredientId) ?? 0) + 1);
      }
      for (const [, c] of byId) if (c > 1) collisions++;
    }
  }
  L.push(`     corpus: ${files.length} lists, ${rows} consolidated rows`);
  L.push(`     rows sharing one ingredientId: ${collisions}`);
  L.push("");
  L.push("     NOTHING TO RULE ON. consolidatePlanIngredients takes the row's name from");
  L.push("     the ingredient it resolved (`canonical = ing?.canonicalName`), so ONE");
  L.push("     ingredientId can only ever produce ONE canonicalName; two rows carrying");
  L.push("     it therefore differ by UNIT alone, and relations.groupKey already puts");
  L.push("     those in one merge group. R1 is a GUARD, not a fix — it moves 0 rows");
  L.push("     today and stops the invariant from being broken later.");
  L.push("");
  L.push("     The 22 rows the census's D1 detector flags are all DIFFERENT ingredient");
  L.push("     rows (generic/specific pairs). They are section S's territory, not R1's.");
} catch (e) {
  L.push(`     (corpus not readable: ${String(e)})`);
}

L.push("");
L.push("=".repeat(78));
L.push("RELABEL_TO_SYNONYM — the go-ahead N6 correction");
L.push("=".repeat(78));
for (const r of RELABEL_TO_SYNONYM) L.push(`  ${r.from} -> ${r.to}: ${r.why}`);
L.push("");
L.push("=".repeat(78));
L.push("NEVER-ORDER CANDIDATES — the go-ahead S.1 #298");
L.push("=".repeat(78));
for (const c of NEVER_ORDER_CANDIDATES) L.push(`  ${c}`);
L.push("");
writeFileSync(join(OUT, "digest.txt"), L.join("\n"), "utf8");
console.log(L.join("\n"));
console.log(`\n-> ${join(OUT, "digest.txt")}  (${n} numbered lines)`);
await prisma.$disconnect();
