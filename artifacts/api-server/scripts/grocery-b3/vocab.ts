// [grocery] B3 · Part A — THE RECURRING VOCABULARY DIGEST. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b3/vocab.ts  -> out/vocab.txt
//
// Every distinct `UserPreferences.recurringGroceryItems` text on dev, with the
// catalog row the EXISTING resolver would pick — `lookupIngredientByName`
// (canonical, then the IngredientAlias synonym index), the read half of
// ingredientResolve. NOTHING is created: the upsert in resolveIngredients is
// deliberately not on this path (it would mint "paper towels" as a catalog row).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { lookupIngredientByName } from "../../src/lib/ingredientLookup";
import { lookupPurchaseDefault } from "../../src/lib/ingredientConversions";
import { inferCategory } from "../../src/lib/ingredientResolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };

async function main() {
  const prefs = await prisma.userPreferences.findMany({
    select: { userId: true, recurringGroceryItems: true },
  });

  // distinct text -> users
  const byText = new Map<string, Set<string>>();
  let totalEntries = 0;
  for (const p of prefs) {
    for (const raw of p.recurringGroceryItems ?? []) {
      totalEntries++;
      let s = byText.get(raw);
      if (!s) { s = new Set(); byText.set(raw, s); }
      s.add(p.userId);
    }
  }

  say(`# recurring vocabulary — dev, ${new Date().toISOString()}`);
  say(`users with preferences rows: ${prefs.length}`);
  say(`users with >=1 recurring item: ${prefs.filter((p) => (p.recurringGroceryItems ?? []).length > 0).length}`);
  say(`total recurring entries: ${totalEntries}`);
  say(`distinct texts: ${byText.size}`);
  say("");

  const rows = [...byText.entries()].sort((a, b) =>
    b[1].size - a[1].size || a[0].localeCompare(b[0]),
  );

  let n = 0;
  const resolved: string[] = [];
  const household: string[] = [];
  for (const [raw, users] of rows) {
    n++;
    const norm = normalizeIngredientName(raw);
    const hit = await lookupIngredientByName(prisma, norm, raw);
    let extra = "";
    if (hit) {
      const row = await prisma.ingredient.findUnique({
        where: { id: hit.id },
        select: {
          displayName: true, category: true, defaultUnit: true,
          purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
          packYieldUnit: true, packYieldPerPack: true,
        },
      });
      extra = ` [via ${hit.matchedVia}; display "${row?.displayName}"; cat ${row?.category}; pack ${row?.purchaseQuantity ?? "-"} ${row?.purchaseUnit ?? "-"} "${row?.purchaseDisplay ?? "-"}"; yield ${row?.packYieldPerPack ?? "-"} ${row?.packYieldUnit ?? "-"}]`;
      resolved.push(raw);
      say(`${String(n).padStart(3, "0")}. "${raw}" -> ${hit.canonicalName}${extra} · users: ${users.size}`);
    } else {
      const def = lookupPurchaseDefault(norm);
      const cat = inferCategory(norm);
      household.push(raw);
      say(`${String(n).padStart(3, "0")}. "${raw}" -> NONE [inferCategory ${cat}; purchaseDefault ${def ? `${def.purchaseQuantity} ${def.purchaseUnit} "${def.purchaseDisplay}"` : "-"}] · users: ${users.size}`);
    }
  }

  say("");
  say(`resolved: ${resolved.length}   unresolved: ${household.length}`);

  // ── near misses: what a singular/plural or grade-aware step WOULD find ──
  say("");
  say("## unresolved texts — candidate catalog rows containing the token");
  for (const raw of household) {
    const norm = normalizeIngredientName(raw);
    const stem = norm.replace(/(ie)?s$/, "").replace(/e$/, "");
    const cands = await prisma.ingredient.findMany({
      where: { canonicalName: { contains: stem, mode: "insensitive" } },
      select: { canonicalName: true, displayName: true, category: true },
      take: 20,
      orderBy: { canonicalName: "asc" },
    });
    say(`  "${raw}" (stem "${stem}"): ${cands.length === 0 ? "(no catalog row contains the stem)" : ""}`);
    for (const c of cands) say(`      - ${c.canonicalName}  [${c.category}]`);
  }

  // ── aliases already present for the resolved ones, for the record ──
  say("");
  say("## alias rows touching the vocabulary");
  for (const [raw] of rows) {
    const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
    const a = await prisma.ingredientAlias.findUnique({
      where: { aliasKey: key },
      select: { aliasKey: true, ingredient: { select: { canonicalName: true } } },
    });
    if (a) say(`  "${a.aliasKey}" -> ${a.ingredient.canonicalName}`);
  }

  writeFileSync(join(OUT, "vocab.txt"), L.join("\n") + "\n");
}

main().finally(() => prisma.$disconnect());
