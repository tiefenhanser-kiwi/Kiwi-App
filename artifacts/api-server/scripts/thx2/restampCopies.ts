// SERVER-6 BUG-536 — RE-STAMP THE USERS' FEAST COPIES AT THEIR OWN SERVINGS.
//
// A feast copy took its source's card time (Meal.estimatedTimeMinutes), stamped at
// the SOURCE's servings, but a feast's time follows its dishes' servings (the oven
// racks, ovenRacks.ts). New Twist's copies at household 4 said 223 while Cook Mode
// said 180. Forks now stamp themselves (mealFork feastCopyNeedsStamp); this brings
// the copies made before that up to date. No AI. Dry by default; --apply writes.
//
//   node --env-file=.env --import tsx scripts/thx2/restampCopies.ts                  # dry run: every change, before → after
//   node --env-file=.env --import tsx scripts/thx2/restampCopies.ts --apply          # write it
//   node --env-file=.env --import tsx scripts/thx2/restampCopies.ts --out dry.txt    # the printed lines to a UTF-8 file too
//   node --env-file=.env --import tsx scripts/thx2/restampCopies.ts --all            # copies at their authored servings too
//
// Scope: by default only copies whose dishes' servings moved from the authored ones
// (BUG-536). A copy at its authored servings can still differ from a fresh stamp,
// because it was stamped by older code and patch.ts never touches users' copies;
// --all re-stamps those as well, so every card agrees with Cook Mode.
//
// Database: assertScriptDatabase — dev, or production only when KIWI_PRODUCTION_HOST
// names the DATABASE_URL host exactly (R3-0). Idempotent: a second run reports nothing.
//
// What it stamps: every USER-OWNED meal tagged thanksgiving-feast, with the code that
// stamps a fork (stampMealTiming). The dry run runs that same code against a client
// whose meal.update / dish.update are recorded and not sent, so dry and apply cannot
// disagree. A copy whose plan item carries a turkey weight is stamped at that weight,
// as the weight save stamps it (THX-4); a copy under two items with different weights
// is SKIPPED and printed (one stamp cannot say both). The catalog feasts (userId
// null) are patch.ts's and are never touched here.

import { writeFileSync } from "node:fs";
import { format } from "node:util";

import { Prisma, PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { stampMealTiming } from "../../src/lib/mealTiming";
import { FEAST_MEAL_TAG } from "../../src/lib/prepWeekAggregation";

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
const ALL = argv.includes("--all");

const { host, mode } = assertScriptDatabase("thx2/restampCopies");
const prisma = new PrismaClient();

interface Write { model: "meal" | "dish"; id: string; data: Record<string, unknown> }

/** A transaction client whose meal/dish updates are recorded and, in a dry run, not sent. */
function recording(tx: Prisma.TransactionClient, send: boolean): { client: Prisma.TransactionClient; writes: Write[] } {
  const writes: Write[] = [];
  const wrap = <M extends "meal" | "dish">(model: M) =>
    new Proxy(tx[model], {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver);
        return async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          writes.push({ model, id: args.where.id, data: args.data });
          return send ? (target as unknown as { update: (a: unknown) => Promise<unknown> }).update(args) : {};
        };
      },
    });
  const client = new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "meal" || prop === "dish") return wrap(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client, writes };
}

async function main() {
  console.log(`thx2/restampCopies — ${mode} (${host}) — ${APPLY ? "APPLY" : "dry run"}`);
  const copies = await prisma.meal.findMany({
    where: { userId: { not: null }, tags: { has: FEAST_MEAL_TAG } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, userId: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true,
      dishLinks: { orderBy: { positionIndex: "asc" }, select: { dishId: true, dish: { select: { title: true, servingsDefault: true, authoredServingsDefault: true, estimatedTimeMinutes: true } } } },
      planItems: { select: { id: true, birdWeightLb: true } },
    },
  });

  let changed = 0;
  let skipped = 0;
  let asAuthored = 0;
  for (const m of copies) {
    const weights = [...new Set(m.planItems.map((i) => (i.birdWeightLb === null ? null : Number(i.birdWeightLb))))];
    const moved = m.dishLinks.some((l) => l.dish.authoredServingsDefault !== null && l.dish.authoredServingsDefault !== l.dish.servingsDefault);
    const head = `${m.id} · ${m.title} · servings ${[...new Set(m.dishLinks.map((l) => l.dish.servingsDefault))].join("/")} (${moved ? "moved from " + [...new Set(m.dishLinks.map((l) => l.dish.authoredServingsDefault))].join("/") : "as authored"})`;
    if (!moved && !ALL) {
      asAuthored += 1;
      continue;
    }
    if (weights.filter((w) => w !== null).length > 0 && weights.length > 1) {
      console.log(`SKIPPED ${head} — items carry different turkey weights (${weights.map((w) => w ?? "none").join(", ")})`);
      skipped += 1;
      continue;
    }
    const birdWeightLb = weights.length === 1 && weights[0] !== null ? weights[0] : undefined;
    const dishIds = m.dishLinks.map((l) => l.dishId);
    const writes = await prisma.$transaction(async (tx) => {
      const rec = recording(tx, APPLY);
      await stampMealTiming(rec.client, m.id, dishIds, birdWeightLb === undefined ? {} : { birdWeightLb });
      return rec.writes;
    }, { timeout: 60_000 });

    const lines: string[] = [];
    for (const w of writes) {
      if (w.model === "meal") {
        const total = w.data.estimatedTimeMinutes as number | null;
        const active = w.data.activeTimeMinutes as number | null;
        if (total !== m.estimatedTimeMinutes) lines.push(`  meal total ${m.estimatedTimeMinutes} → ${total}`);
        if (active !== m.activeTimeMinutes) lines.push(`  meal hands-on ${m.activeTimeMinutes} → ${active}`);
      } else {
        const link = m.dishLinks.find((l) => l.dishId === w.id);
        const total = w.data.estimatedTimeMinutes as number | null;
        if (link && total !== link.dish.estimatedTimeMinutes) lines.push(`  dish ${link.dish.title}: ${link.dish.estimatedTimeMinutes} → ${total}`);
      }
    }
    if (lines.length === 0) continue;
    changed += 1;
    console.log(`${head}${birdWeightLb !== undefined ? ` · turkey ${birdWeightLb} lb` : ""}`);
    for (const l of lines) console.log(l);
  }
  console.log(`\n${APPLY ? "re-stamped" : "would re-stamp"} ${changed} of ${copies.length} feast cop${copies.length === 1 ? "y" : "ies"}${skipped ? `, ${skipped} skipped` : ""}${asAuthored ? `; ${asAuthored} at their authored servings left alone (--all includes them)` : ""}${APPLY ? "" : " — re-run with --apply"}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
