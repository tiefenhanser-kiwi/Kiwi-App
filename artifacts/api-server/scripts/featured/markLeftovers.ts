// THX-2S Part F (D-WS9-311) — flag Thursday's leftovers on the Thanksgiving
// Friday meals, so grocery generation skips them (DishIngredient.fromLeftovers;
// lib/groceryList.ts) and the list carries one note instead.
//
// Run from artifacts/api-server. A bare run is a DRY RUN: it prints the
// database hostname, every Friday meal it found, and every line it would flag,
// and writes nothing. Only `--apply` writes (one transaction).
//
//   # dev (the DATABASE_URL host contains ep-broad-haze)
//   node --env-file=.env --import tsx scripts/featured/markLeftovers.ts
//   node --env-file=.env --import tsx scripts/featured/markLeftovers.ts --apply
//
//   # PRODUCTION — exactly as the R3-0 runbook scripts run: the production
//   # DATABASE_URL in a separate env file, KIWI_PRODUCTION_HOST typed into the
//   # shell for the run (the EXACT hostname), never in .env; unset afterwards.
//   $env:KIWI_PRODUCTION_HOST = "<the production hostname>"
//   node --env-file=<prod-env> --import tsx scripts/featured/markLeftovers.ts
//   node --env-file=<prod-env> --import tsx scripts/featured/markLeftovers.ts --apply
//   Remove-Item Env:KIWI_PRODUCTION_HOST
//
// Which meals: the `friday` targets of THX-2G's scripts/thx2/targets.json,
// found the way THX-2G records them — Meal.dishFamilyKey = the target key on a
// `batch_generated` row (read-only import; scripts/thx2/ is not edited). Plus
// any user FORK of those meals (Meal.sourceStoreMealId), so a run after people
// have adopted a plan still covers their copies.
//
// Which lines: an ingredient whose canonical name begins "leftover" or
// "cooked leftover" (the Classic's turkey, cranberry sauce and stuffing; the
// soups', pot pie's and enchiladas' turkey). Nothing is ever un-flagged.
//
// IDEMPOTENT: a second dry run after an apply reports zero changes.
// Undo (by hand): UPDATE dish_ingredients SET "fromLeftovers" = false WHERE id IN (…the ids printed…).

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { loadTargets } from "../thx2/thx2Core";

const APPLY = process.argv.includes("--apply");
const say = (s = "") => console.log(s);

/** "leftover stuffing", "cooked leftover turkey" — not "leftover-free rice". */
export const LEFTOVER_LINE = /^(?:cooked\s+)?leftover\s/i;

const { host, mode } = assertScriptDatabase("markLeftovers");
say(`database: ${host} (${mode})`);
say(APPLY ? "mode: APPLY" : "mode: dry run (pass --apply to write)");

const fridayKeys = loadTargets()
  .targets.filter((t) => t.kind === "friday")
  .map((t) => t.key);
say(`friday targets: ${fridayKeys.join(", ")}`);

const prisma = new PrismaClient();
const MEAL_INCLUDE = {
  dishLinks: {
    orderBy: { positionIndex: "asc" as const },
    select: {
      dish: {
        select: {
          id: true,
          title: true,
          dishIngredients: {
            orderBy: { positionIndex: "asc" as const },
            select: {
              id: true,
              quantity: true,
              unit: true,
              fromLeftovers: true,
              ingredient: { select: { canonicalName: true } },
            },
          },
        },
      },
    },
  },
};

try {
  const catalog = await prisma.meal.findMany({
    where: { sourceType: "batch_generated", dishFamilyKey: { in: fridayKeys } },
    select: { id: true, title: true, dishFamilyKey: true, isPublic: true, userId: true, ...MEAL_INCLUDE },
    orderBy: { dishFamilyKey: "asc" },
  });
  const forks = catalog.length
    ? await prisma.meal.findMany({
        where: { sourceStoreMealId: { in: catalog.map((m) => m.id) } },
        select: { id: true, title: true, sourceStoreMealId: true, userId: true, ...MEAL_INCLUDE },
      })
    : [];

  const missing = fridayKeys.filter((k) => !catalog.some((m) => m.dishFamilyKey === k));
  say(`found: ${catalog.length} catalog Friday meal(s), ${forks.length} fork(s)`);
  if (missing.length) say(`not on this database (not generated yet): ${missing.join(", ")}`);

  const toFlag: string[] = [];
  let already = 0;
  const report = (label: string, meal: (typeof catalog)[number] | (typeof forks)[number]) => {
    say();
    say(label);
    let any = false;
    for (const { dish } of meal.dishLinks) {
      for (const di of dish.dishIngredients) {
        if (!LEFTOVER_LINE.test(di.ingredient.canonicalName)) continue;
        any = true;
        const line = `    ${di.quantity} ${di.unit} ${di.ingredient.canonicalName}  (${dish.title} · ${di.id})`;
        if (di.fromLeftovers) {
          already += 1;
          say(`${line}  — already flagged`);
        } else {
          toFlag.push(di.id);
          say(`${line}  → FLAG`);
        }
      }
    }
    if (!any) say("    (no leftover lines — nothing to flag)");
  };
  for (const m of catalog) report(`${m.dishFamilyKey}  ${m.id}  "${m.title}"  public=${m.isPublic}`, m);
  for (const f of forks) report(`fork of ${f.sourceStoreMealId}  ${f.id}  "${f.title}"  owner=${f.userId}`, f);

  say();
  say(`changes: ${toFlag.length} line(s) to flag · ${already} already flagged`);
  if (!APPLY || toFlag.length === 0) {
    say(toFlag.length === 0 ? "ZERO CHANGES." : "dry run — nothing written.");
  } else {
    const n = await prisma.$transaction(async (tx) => {
      const r = await tx.dishIngredient.updateMany({
        where: { id: { in: toFlag }, fromLeftovers: false },
        data: { fromLeftovers: true },
      });
      if (r.count !== toFlag.length) {
        throw new Error(`expected ${toFlag.length} rows, updated ${r.count} — rolled back`);
      }
      return r.count;
    });
    say(`APPLIED: ${n} line(s) flagged in one transaction.`);
  }
} finally {
  await prisma.$disconnect();
}
