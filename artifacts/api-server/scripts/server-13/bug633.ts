// SERVER-13 E (BUG-633) — REBIND AN AMOUNTREF BOUND TO A SAME-NAMED SIBLING ROW. No AI.
//
// Classic Beef Lo Mein's step 0 "1 tablespoon soy sauce" was bound to its dark-soy row.
// This finds every ref of that shape in the catalog (bug633Refs.ts: the words name a
// sibling of the row's own family, and the rows' amounts confirm it) and moves it to
// the row its words name. Only the ref's ingredientId changes: its text span, number
// and unit stay. Dry by default; --apply writes, one update per step.
//
//   node --env-file=.env --import tsx scripts/server-13/bug633.ts             # dry run: every ref, before → after
//   node --env-file=.env --import tsx scripts/server-13/bug633.ts --apply
//   node --env-file=.env --import tsx scripts/server-13/bug633.ts --copies    # users' copies too (counted, not touched, without it)
//   node --env-file=.env --import tsx scripts/server-13/bug633.ts --out dry.txt
//
// Database: assertScriptDatabase — dev, or production only when KIWI_PRODUCTION_HOST
// names the DATABASE_URL host exactly (R3-0). Idempotent: a second run finds nothing.

import { writeFileSync } from "node:fs";
import { format } from "node:util";

import { Prisma, PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { dishMisbinds, rebind, type RefLike } from "./bug633Refs";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
if (outIdx >= 0) {
  const OUT = argv[outIdx + 1];
  if (!OUT || OUT.startsWith("--")) { console.error("--out: a file path"); process.exit(2); }
  const printed: string[] = [];
  const log = console.log.bind(console);
  console.log = (...a: unknown[]) => { printed.push(format(...a)); log(...a); };
  process.on("exit", () => writeFileSync(OUT, printed.join("\n") + "\n", "utf8"));
}
const APPLY = argv.includes("--apply");
const COPIES = argv.includes("--copies");

const { host, mode } = assertScriptDatabase("server-13/bug633");
console.log(`database: ${host} (${mode}) · ${APPLY ? "APPLY" : "DRY RUN — nothing is written"}${COPIES ? " · users' copies included" : ""}`);

const prisma = new PrismaClient();

async function scan(owned: boolean) {
  const dishes = await prisma.dish.findMany({
    where: owned ? { userId: { not: null } } : { userId: null },
    select: { id: true, title: true, dishIngredients: { select: { ingredientId: true, quantity: true, unit: true, ingredient: { select: { displayName: true } } } } },
    orderBy: { id: "asc" },
  });
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: dishes.map((d) => d.id) } },
    select: { id: true, ownerId: true, stepIndex: true, stepTextTranslated: true, amountRefs: true },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
  });
  const byDish = new Map<string, typeof steps>();
  for (const s of steps) byDish.set(s.ownerId, [...(byDish.get(s.ownerId) ?? []), s]);
  const found = [];
  for (const d of dishes) {
    const ds = byDish.get(d.id) ?? [];
    const rows = d.dishIngredients.map((x) => ({ ingredientId: x.ingredientId, name: x.ingredient.displayName, quantity: x.quantity, unit: x.unit }));
    const { confirmed, unconfirmed } = dishMisbinds(ds.map((s) => ({ stepIndex: s.stepIndex, text: s.stepTextTranslated, amountRefs: (s.amountRefs ?? null) as RefLike[] | null })), rows);
    if (confirmed.length || unconfirmed.length) found.push({ dish: d, steps: ds, confirmed, unconfirmed });
  }
  return { dishes: dishes.length, steps: steps.length, found };
}

const catalog = await scan(false);
const copies = await scan(true);
let written = 0;
for (const [label, run, write] of [["catalog", catalog, true], ["users' copies", copies, COPIES]] as const) {
  const refs = run.found.reduce((n, f) => n + f.confirmed.length, 0);
  console.log(`\n${label}: ${run.dishes} dishes, ${run.steps} steps · ${refs} misbound ref${refs === 1 ? "" : "s"} in ${run.found.filter((f) => f.confirmed.length).length} dish(es)${write ? "" : " — counted, not touched"}`);
  for (const f of run.found) {
    for (const m of f.confirmed) {
      const s = f.steps.find((x) => x.stepIndex === m.stepIndex)!;
      console.log(`  ${f.dish.title} (${f.dish.id.slice(0, 8)}) s${m.stepIndex}: "${s.stepTextTranslated.slice(m.ref.charStart, m.ref.charEnd)}" ${m.bound} → ${m.named}`);
    }
    for (const m of f.unconfirmed) console.log(`  (not this shape by the amounts, left) ${f.dish.title} s${m.stepIndex}: ${m.bound} / ${m.named}`);
    if (!APPLY || !write) continue;
    for (const stepIndex of new Set(f.confirmed.map((m) => m.stepIndex))) {
      const s = f.steps.find((x) => x.stepIndex === stepIndex)!;
      const next = rebind((s.amountRefs ?? []) as unknown as RefLike[], f.confirmed.filter((m) => m.stepIndex === stepIndex));
      await prisma.recipeInstructionStep.update({ where: { id: s.id }, data: { amountRefs: next as unknown as Prisma.InputJsonValue } });
      written++;
    }
  }
}
console.log(`\n${APPLY ? `wrote ${written} step(s)` : "dry run: nothing written"}`);
await prisma.$disconnect();
