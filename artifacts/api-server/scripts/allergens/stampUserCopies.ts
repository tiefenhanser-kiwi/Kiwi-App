// BUG-407 — stamp the user-owned meals that were born without an allergen stamp.
//
// cloneMealInto (src/lib/mealFork.ts) used to copy a meal's whole graph but not
// its stamp, so every user copy started `allergensStampedAt: null` — "never
// evaluated" — and the conservative allergen rule (store/allergenFilter.ts)
// hid it from every allergic user's Playlist shelf. The fork carries the stamp
// now; this script repairs the rows made before that.
//
// Run from artifacts/api-server. A bare run is a DRY RUN: it prints the
// database hostname, the count, a sample with the tokens each row WOULD get,
// and the production commands, and writes nothing. Only `--apply` writes.
//
//   # dev (the DATABASE_URL host contains ep-broad-haze)
//   node --env-file=.env --import tsx scripts/allergens/stampUserCopies.ts
//   node --env-file=.env --import tsx scripts/allergens/stampUserCopies.ts --apply
//
//   # PRODUCTION — exactly as the R3-0 runbook scripts run
//   # (scripts/grocery-release/README.md §1): the production DATABASE_URL in a
//   # separate env file, and KIWI_PRODUCTION_HOST typed into the shell for the
//   # run — the EXACT production hostname. Never in .env; unset it afterwards.
//   $env:KIWI_PRODUCTION_HOST = "<the production hostname>"
//   node --env-file=<prod-env> --import tsx scripts/allergens/stampUserCopies.ts --dry-run
//   node --env-file=<prod-env> --import tsx scripts/allergens/stampUserCopies.ts --apply
//   node --env-file=<prod-env> --import tsx scripts/allergens/stampUserCopies.ts --dry-run
//   Remove-Item Env:KIWI_PRODUCTION_HOST
//
// A production run prints "PRODUCTION host … (KIWI_PRODUCTION_HOST matched)"
// to stderr first; without that line you are not on production.
//
// WHAT IT TOUCHES. Meals with an owner (`userId` not null), private
// (`isPublic: false`), never stamped (`allergensStampedAt: null`). A catalog
// row is public or owner-less and is excluded by the predicate itself. Copies
// (`sourceStoreMealId` set) are the bulk; a user-built meal that was never
// stamped is the same exclusion on the same shelf, so it is stamped too and
// counted separately.
//
// WHAT IT WRITES: the stamp and nothing else — `allergens`, `allergenSources`,
// `allergensStampedAt`, through stampAllergens (src/lib/allergens.ts), which
// derives them from the meal's own persisted ingredient graph.
//
// ⚠️ WHAT IT REFUSES TO STAMP: a meal with a PARTIAL graph (no dish, or a dish
// with zero ingredient rows). stampAllergens would write `allergens: []` with
// a date, which the filter reads as "evaluated and clean" — admitting a meal
// nobody could evaluate to every allergic user. Those rows stay unstamped
// (excluded, the safe reading) and are listed.
//
// IDEMPOTENT: a stamped row leaves the predicate, so a second dry run after an
// apply reports zero (plus any partial-graph rows, unchanged by design).

import { PrismaClient, type Prisma } from "@prisma/client";

import { deriveAllergensForMeal, stampAllergens } from "../../src/lib/allergens";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

const BATCH = 100;
const SAMPLE = 10;

const say = (s = "") => console.log(s);

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--apply" && a !== "--dry-run");
if (unknown.length > 0 || (args.includes("--apply") && args.includes("--dry-run"))) {
  console.error(`usage: stampUserCopies.ts [--dry-run | --apply]   (got: ${args.join(" ")})`);
  process.exit(2);
}
const APPLY = args.includes("--apply");

const { host, mode } = assertScriptDatabase("stampUserCopies");
const prisma = new PrismaClient();

const TARGET: Prisma.MealWhereInput = {
  userId: { not: null },
  isPublic: false,
  allergensStampedAt: null,
};

const CANDIDATE_SELECT = {
  id: true,
  title: true,
  userId: true,
  sourceStoreMealId: true,
  dishLinks: { select: { dish: { select: { _count: { select: { dishIngredients: true } } } } } },
} satisfies Prisma.MealSelect;

type Candidate = Prisma.MealGetPayload<{ select: typeof CANDIDATE_SELECT }>;

function isComplete(m: Candidate): boolean {
  return m.dishLinks.length > 0 && m.dishLinks.every((l) => l.dish._count.dishIngredients > 0);
}

async function* candidates(): AsyncGenerator<Candidate[]> {
  let after: string | undefined;
  for (;;) {
    const page = await prisma.meal.findMany({
      where: { ...TARGET, ...(after ? { id: { gt: after } } : {}) },
      select: CANDIDATE_SELECT,
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (page.length === 0) return;
    yield page;
    after = page[page.length - 1].id;
  }
}

function productionCommands(): void {
  const h = mode === "production" ? host : "<the production hostname>";
  say("Production (Hans, after the audit), from artifacts/api-server:");
  say(`  $env:KIWI_PRODUCTION_HOST = "${h}"`);
  say("  node --env-file=<prod-env> --import tsx scripts/allergens/stampUserCopies.ts --dry-run");
  say("  node --env-file=<prod-env> --import tsx scripts/allergens/stampUserCopies.ts --apply");
  say("  node --env-file=<prod-env> --import tsx scripts/allergens/stampUserCopies.ts --dry-run");
  say("  Remove-Item Env:KIWI_PRODUCTION_HOST");
}

async function main(): Promise<void> {
  say(`host: ${host} (${mode})`);
  say(`mode: ${APPLY ? "APPLY — writes the stamp" : "DRY RUN — writes nothing"}`);

  let copies = 0;
  let userBuilt = 0;
  const partial: Candidate[] = [];
  const stampable: Candidate[] = [];
  for await (const page of candidates()) {
    for (const m of page) {
      if (m.sourceStoreMealId) copies += 1;
      else userBuilt += 1;
      (isComplete(m) ? stampable : partial).push(m);
    }
  }

  say();
  say(`unstamped user-owned private meals: ${copies + userBuilt}`);
  say(`  copies (sourceStoreMealId set): ${copies}`);
  say(`  user-built (no source):         ${userBuilt}`);
  say(`  stampable (complete graph):     ${stampable.length}`);
  say(`  REFUSED (partial graph):        ${partial.length}`);
  for (const m of partial) {
    say(`    ${m.id}  "${m.title}"  links=${m.dishLinks.length}  empty dishes=${m.dishLinks.filter((l) => l.dish._count.dishIngredients === 0).length}`);
  }

  if (stampable.length > 0) {
    say();
    say(`sample (${Math.min(SAMPLE, stampable.length)} of ${stampable.length}) — the tokens each would get:`);
    for (const m of stampable.slice(0, SAMPLE)) {
      const d = await deriveAllergensForMeal(prisma, m.id);
      say(`  ${m.id}  "${m.title}"  source=${m.sourceStoreMealId ?? "-"}  → [${d?.tokens.join(", ") ?? "?"}]`);
    }
  }

  if (APPLY && stampable.length > 0) {
    say();
    let done = 0;
    for (let i = 0; i < stampable.length; i += BATCH) {
      const batch = stampable.slice(i, i + BATCH);
      // One meal per call: stampAllergens reads the graph and writes one row.
      // Sequential within a batch keeps the pool to one connection's worth.
      for (const m of batch) {
        await stampAllergens(prisma, m.id);
        done += 1;
      }
      say(`  stamped ${done} / ${stampable.length}`);
    }
    const left = await prisma.meal.count({ where: TARGET });
    say(`remaining unstamped user-owned private meals: ${left} (partial-graph refusals: ${partial.length})`);
  }

  say();
  productionCommands();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
