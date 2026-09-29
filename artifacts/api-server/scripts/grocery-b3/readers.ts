// [grocery] B3 · Part B — WHO ELSE READS THE TABLE ENTRIES WE TOUCH. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b3/readers.ts -> out/readers.txt
//
// Ruling 3 asks for every OTHER reader of each entry added or changed. The
// entries are keys in INGREDIENT_CONVERSIONS; the readers that matter are the
// ones that can reach a key WITHOUT being handed it — i.e. the baseStapleName
// fallbacks in groceryMerge.ts:152 and groceryListAI.ts:417, which fire only for
// a row whose own conversionRef is null.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { lookupConversion, lookupPurchaseDefault } from "../../src/lib/ingredientConversions";
import { baseStapleName } from "../../src/lib/groceryStaples";
import { inferCategory } from "../../src/lib/ingredientResolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };

const TOUCHED = ["milk", "paper towels", "toilet paper", "pet treats", "coffee"];

async function main() {
  say(`# B3 Part B — table-entry blast radius, ${new Date().toISOString()}`);
  say("");
  say("## 1. does a catalog row carry the key itself?");
  for (const k of TOUCHED) {
    const row = await prisma.ingredient.findUnique({
      where: { canonicalName: k },
      select: { id: true, canonicalName: true, conversionRef: true, purchaseUnit: true },
    });
    say(`  "${k}": ${row ? `ROW EXISTS (conversionRef ${row.conversionRef ? "set" : "null"}, purchaseUnit ${row.purchaseUnit})` : "no catalog row"}`);
  }

  say("");
  say("## 2. which catalog rows FOLD to a touched key via baseStapleName,");
  say("##    and would therefore reach the new purchase fields through the");
  say("##    groceryMerge.ts:152 / groceryListAI.ts:417 fallback?");
  say("##    The fallback fires ONLY when the row's own conversionRef is null.");
  const all = await prisma.ingredient.findMany({
    select: { id: true, canonicalName: true, conversionRef: true, purchaseUnit: true, purchaseDisplay: true },
  });
  const touched = new Set(TOUCHED);
  let exposed = 0;
  for (const r of all) {
    const norm = normalizeIngredientName(r.canonicalName);
    const base = baseStapleName(norm);
    if (base === norm || !touched.has(base)) continue;
    const uses = await prisma.dishIngredient.count({ where: { ingredientId: r.id } });
    const guarded = r.conversionRef !== null;
    if (!guarded) exposed++;
    say(`  ${r.canonicalName}  -> base "${base}"  | own conversionRef ${guarded ? "SET (fallback never fires)" : "NULL  <-- EXPOSED"} | own pack ${JSON.stringify(r.purchaseDisplay)} | ${uses} recipe rows`);
  }
  say(`  exposed rows (conversionRef null AND folding to a touched key): ${exposed}`);

  say("");
  say("## 3. the create-time reader: ingredientResolve.resolveIngredients");
  say("##    seeds purchase fields from lookupPurchaseDefault on a NEW row only.");
  for (const k of TOUCHED) {
    say(`  "${k}": before ${JSON.stringify(lookupPurchaseDefault(k))} · conversion ${JSON.stringify(lookupConversion(k))}`);
  }

  say("");
  say("## 4. ruling 5 — the Household rule sweep over every catalog name");
  say("##    (inferCategory at HEAD; re-run after the change and diff)");
  const byCat: Record<string, number> = {};
  const rows: { name: string; cat: string }[] = [];
  for (const r of all) {
    const c = inferCategory(r.canonicalName);
    byCat[c] = (byCat[c] ?? 0) + 1;
    rows.push({ name: r.canonicalName, cat: c });
  }
  say(`  catalog rows: ${all.length}   inferCategory distribution: ${JSON.stringify(byCat)}`);
  writeFileSync(join(OUT, "infercategory_before.json"), JSON.stringify(rows, null, 0));
  say(`  -> out/infercategory_before.json  (${rows.length} rows, for the after-diff)`);

  // the five food negatives the ruling names, plus the four new phrases
  say("");
  say("## 5. ruling 5's negatives and positives, at HEAD");
  for (const n of ["hot dogs", "hot dog buns", "catfish", "petite diced tomatoes", "trumpet mushrooms",
                   "pet treats", "dog food", "dog treats", "cat food", "cat litter", "paper towels", "toilet paper"]) {
    say(`  inferCategory(${JSON.stringify(n)}) = ${inferCategory(n)}`);
  }

  writeFileSync(join(OUT, "readers.txt"), L.join("\n") + "\n");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
