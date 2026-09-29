// [grocery] B3 · Part A — WHAT THE RESOLUTION WOULD MEET. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b3/overlap.ts -> out/overlap.txt
//
// For each of the 20 census plans: the user's recurring texts, the catalog row
// the EXISTING resolver picks, and whether THIS PLAN already demands that row —
// read off the B2 corpus's own `consolidated` stage, so the BEFORE is the
// shipped pipeline's and not a re-derivation.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { lookupIngredientByName } from "../../src/lib/ingredientLookup";
import { loadRelationIndex } from "../../src/lib/relationIndexLoader";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };

interface Cons {
  ingredientId: string | null; canonicalName: string; displayName: string;
  quantity: number; unit: string; isRecurringItem: boolean;
  purchaseUnit: string | null; purchaseQuantity: number | null; purchaseDisplay: string | null;
  sources: unknown[];
}
interface Rec { planId: string; userId: string; consolidated: Cons[]; final: { canonicalName: string; unit: string; quantity: number; isRecurringItem: boolean; displayName: string; purchaseDisplay: string | null }[] }

async function main() {
  const relations = await loadRelationIndex(prisma);
  const files = readdirSync(CORPUS).filter((f) => f.startsWith("b2__") && f.endsWith(".json")).sort();

  let totalRecurringRows = 0, wouldMeet = 0, wouldStaySynthetic = 0, wouldResolveNoMeet = 0;
  const sameUnit: string[] = [];
  const diffUnit: string[] = [];
  const noMeet: string[] = [];
  const household: string[] = [];

  for (const f of files) {
    const j = JSON.parse(readFileSync(join(CORPUS, f), "utf8")) as Rec;
    const prefs = await prisma.userPreferences.findUnique({
      where: { userId: j.userId },
      select: { recurringGroceryItems: true },
    });
    const recurringRaw = prefs?.recurringGroceryItems ?? [];
    if (recurringRaw.length === 0) continue;

    say(`## ${j.planId.slice(0, 8)}  user ${j.userId.slice(0, 8)}  — ${recurringRaw.length} recurring`);

    // plan rows, by ingredientId and by group key, from the SHIPPED consolidate
    const planRows = j.consolidated.filter((c) => !c.isRecurringItem);
    const byIngId = new Map<string, Cons[]>();
    const byGroupKey = new Map<string, Cons[]>();
    for (const c of planRows) {
      if (c.ingredientId) {
        const a = byIngId.get(c.ingredientId) ?? []; a.push(c); byIngId.set(c.ingredientId, a);
      }
      const k = relations.groupKey(c.canonicalName);
      const b = byGroupKey.get(k) ?? []; b.push(c); byGroupKey.set(k, b);
    }

    for (const raw of recurringRaw) {
      totalRecurringRows++;
      const norm = normalizeIngredientName(raw);
      const hit = await lookupIngredientByName(prisma, norm, raw);
      // the synthetic row the pipeline PRODUCED for this text, for the BEFORE
      const before = j.final.find((x) => x.isRecurringItem && normalizeIngredientName(x.displayName).startsWith(norm.slice(0, 4)));
      const beforeTxt = before ? `${before.purchaseDisplay} ${before.displayName} (${before.quantity} ${before.unit})` : "(not on the final list)";

      if (!hit) {
        wouldStaySynthetic++;
        household.push(`[${j.planId.slice(0, 8)}] "${raw}" -> NONE — stays synthetic. BEFORE: ${beforeTxt}`);
        say(`   "${raw}" -> NONE (synthetic) | BEFORE ${beforeTxt}`);
        continue;
      }
      const matches = byIngId.get(hit.id) ?? [];
      // also: a row whose GROUP KEY equals the resolved row's group key
      const gk = relations.groupKey(hit.canonicalName);
      const gkMatches = (byGroupKey.get(gk) ?? []).filter((c) => !matches.includes(c));
      if (matches.length === 0 && gkMatches.length === 0) {
        wouldResolveNoMeet++;
        noMeet.push(`[${j.planId.slice(0, 8)}] "${raw}" -> ${hit.canonicalName} (${hit.matchedVia}) — resolved, but this plan demands none. BEFORE: ${beforeTxt}`);
        say(`   "${raw}" -> ${hit.canonicalName} [${hit.matchedVia}] | plan demands NONE | BEFORE ${beforeTxt}`);
        continue;
      }
      wouldMeet++;
      const all = [...matches, ...gkMatches];
      for (const m of all) {
        const line = `[${j.planId.slice(0, 8)}] "${raw}" -> ${hit.canonicalName} MEETS plan row "${m.displayName}" ${m.quantity} ${m.unit} (pack ${m.purchaseDisplay}) ${gkMatches.includes(m) ? "[via groupKey]" : "[via ingredientId]"}. BEFORE: ${beforeTxt}`;
        say(`   ${line.slice(line.indexOf('"'))}`);
        // R3 branch: SAME UNIT TOKEN or not
        // the recurring's own unit is the synthetic's (purchase default) unit
        (m.unit === "each" || m.unit === "" ? sameUnit : diffUnit).push(line);
      }
    }
    say("");
  }

  say("=".repeat(78));
  say(`recurring entries across the 20 census plans: ${totalRecurringRows}`);
  say(`  would MEET a plan row:              ${wouldMeet}`);
  say(`  resolve, but this plan demands none:${wouldResolveNoMeet}`);
  say(`  resolve to NO catalog row (synthetic/household): ${wouldStaySynthetic}`);
  say("");
  say("## the MEETS, by R3 branch (crude: unit token identical vs not)");
  say(`-- count-ish unit (${sameUnit.length}) --`);
  for (const s of sameUnit) say("  " + s);
  say(`-- measured / different unit (${diffUnit.length}) --`);
  for (const s of diffUnit) say("  " + s);
  say("");
  say(`## resolved-but-not-demanded (${noMeet.length})`);
  for (const s of noMeet) say("  " + s);
  say("");
  say(`## synthetic / household (${household.length})`);
  for (const s of household) say("  " + s);

  writeFileSync(join(OUT, "overlap.txt"), L.join("\n") + "\n");
}

main().finally(() => prisma.$disconnect());
