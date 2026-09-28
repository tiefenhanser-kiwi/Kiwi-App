// [grocery] B1 · Part A — PROBE 4. Why does the shadow merge leave garlic alone?
//   node --env-file=.env --import tsx scripts/grocery-b1/probe4.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import {
  resolveConversion, canonicalUnitToken, isCountUnit, unitDimension, normalizeUnit,
} from "../../src/lib/ingredientConversions";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { PACK_YIELDS } from "./proposals";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "..", "grocery-census", "out");
const prisma = new PrismaClient();

async function main() {
  const index = await loadRelationIndex(prisma);
  const j = JSON.parse(readFileSync(join(CORPUS, "live__56b03a57__r1.json"), "utf8"));
  type Row = { canonicalName: string; quantity: number; unit: string; conversionRef?: unknown; sectionKey: string };
  const rows = (j.consolidated as Row[]).filter((r) => index.groupKey(r.canonicalName) === "garlic");
  console.log("group members:", rows.map((r) => `${r.canonicalName} ${r.quantity} ${r.unit} [${r.sectionKey}]`));
  const y = PACK_YIELDS.find((p) => p.ingredient === "garlic")!;
  console.log("yield:", y);
  const ing = await prisma.ingredient.findFirst({ where: { canonicalName: "garlic" }, select: { purchaseUnit: true, purchaseDisplay: true } });
  console.log("garlic pack:", ing);
  const l = { parent: normalizeUnit(ing!.purchaseUnit!), perParent: y.perPack, childUnit: normalizeUnit(y.unit) };
  console.log("ladder:", l);
  const units = rows.map((r) => r.unit);
  console.log("tokens:", [...new Set(units.map(canonicalUnitToken))]);
  console.log("dims:", units.map((u) => unitDimension(u)));
  for (const r of rows) {
    const conv = resolveConversion("garlic", rows.find((x) => x.canonicalName === "garlic")?.conversionRef);
    const from = canonicalUnitToken(r.unit);
    let q: number | null = null;
    if (from === canonicalUnitToken(l.parent)) q = r.quantity * l.perParent;
    else if (from === canonicalUnitToken(l.childUnit)) q = r.quantity;
    else if (isCountUnit(r.unit) && isCountUnit(l.childUnit)) q = r.quantity;
    console.log(`  ${r.canonicalName} ${r.quantity} ${r.unit}: token=${from} isCount=${isCountUnit(r.unit)} -> child ${q}`);
    void conv;
  }
  console.log("normalizeIngredientName keys:", rows.map((r) => normalizeIngredientName(r.canonicalName)));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
