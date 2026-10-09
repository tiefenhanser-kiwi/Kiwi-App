// [prepcook] B1 · F — D-WS9-297 ruling 4: the one K-R4 finding is dish CONTENT.
//
// The census found exactly ONE duplicated action in 3,068 cross-dish step pairs,
// and it is not a scheduler defect — it is a step whose whole content is a
// pointer at another dish's work:
//
//   Carne Asada #6 (hold, 3 min):
//     "While the steak rests, warm the corn tortillas (see Warm Corn Tortillas dish)."
//
// The Warm Corn Tortillas dish is already in the same meal and the scheduler
// already interleaves it, so the meal warms 12 tortillas twice — once for 8
// minutes at sequence 12, once again here.
//
// THE TEXT IS REWRITTEN, NOT THE ROW DELETED. The go-ahead says "fix the dish
// text", and the step earns its 3 minutes: it is the hold between the steak's
// rest and its slicing. What it must not do is re-issue an action another dish
// owns. Deleting it would also drop 3 minutes from a public catalog dish's
// derived time for no reason.
//
// 🔴 THERE ARE TWO TEXT COLUMNS AND THE FIRST RUN WROTE THE WRONG ONE.
// `RecipeInstructionStep` has `stepTextRaw` AND `stepTextTranslated`, and
// `toStepShape` (routes/meals.ts) renders stepTextTranslated — so the cook's
// screen was unchanged while a scan of stepTextRaw reported the fix as applied.
// Measured on dev: the two columns were IDENTICAL on all 30,718 rows until this
// script made 2 of them disagree, which is exactly how the mistake hid. Both
// columns are written now, and the match is on either.
//
// ⚠️ OTHER "(see … dish)" REFERENCES ARE LEGITIMATE AND ARE LEFT ALONE. Twelve
// rows contain "dish)"; the rest point at an INGREDIENT another dish makes (a
// tomato sauce, a consommé broth) rather than repeating an action. Only the
// duplicated-action shape is matched, by its exact text.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/fix-k-r4.ts --scan
//   node --env-file=.env --import tsx scripts/prep-cook-census/fix-k-r4.ts --apply
//   node --env-file=.env --import tsx scripts/prep-cook-census/fix-k-r4.ts --revert out/k-r4-<stamp>.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

const DB_HOST = assertScriptDatabase("prep-cook-census/fix-k-r4").host;
const prisma = new PrismaClient();
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const HAS = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const FROM = "While the steak rests, warm the corn tortillas (see Warm Corn Tortillas dish).";
const TO =
  "Leave the steak tented on the cutting board while the tortillas and toppings come together.";

async function main() {
  const revert = arg("revert");
  if (revert) {
    const rows = JSON.parse(readFileSync(revert, "utf8")).rows as {
      id: string; before: string; beforeTranslated?: string;
    }[];
    for (const r of rows) {
      await prisma.recipeInstructionStep.update({
        where: { id: r.id },
        data: { stepTextRaw: r.before, stepTextTranslated: r.beforeTranslated ?? r.before },
      });
    }
    console.log(`reverted ${rows.length} step(s)`);
    return;
  }

  const rows = await prisma.recipeInstructionStep.findMany({
    where: { OR: [{ stepTextRaw: FROM }, { stepTextTranslated: FROM }] },
    select: {
      id: true, ownerId: true, ownerType: true, stepIndex: true,
      stepTextRaw: true, stepTextTranslated: true,
    },
  });
  // Public-vs-private is worth printing: a public row is the catalog carve-out
  // (D-WS9-230) and needs the production runbook line; a private one does not.
  const dishes = await prisma.dish.findMany({
    where: { id: { in: rows.map((r) => r.ownerId) } },
    // Dish has NO isPublic — a catalog dish is userId === null (visibility lives
    // on the Meal, not the Dish).
    select: { id: true, title: true, userId: true },
  });
  const byId = new Map(dishes.map((d) => [d.id, d]));

  console.log(`${rows.length} step(s) match the duplicated-action text exactly`);
  for (const r of rows) {
    const d = byId.get(r.ownerId);
    console.log(
      `  ${r.id.slice(0, 8)}  ${r.ownerType} ${r.ownerId.slice(0, 8)} #${r.stepIndex}  ${d?.userId === null ? "CATALOG" : "user-owned"}  ${d?.title ?? "?"}`,
    );
  }
  console.log(`\n  from: "${FROM}"\n    to: "${TO}"`);

  if (!HAS("apply")) {
    console.log("\n--scan only; nothing written. Pass --apply to write.");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ledger = join(OUT, `k-r4-${stamp}.json`);
  writeFileSync(
    ledger,
    JSON.stringify({ stamp, host: DB_HOST, to: TO, rows: rows.map((r) => ({ id: r.id, before: r.stepTextRaw })) }, null, 2),
  );
  for (const r of rows) {
    await prisma.recipeInstructionStep.update({
      where: { id: r.id },
      data: { stepTextRaw: TO, stepTextTranslated: TO },
    });
  }
  console.log(`\nwrote ${rows.length} step(s). Ledger (revert with --revert): ${ledger}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
