// ws9-d214-allergen-backfill.ts — stamp EVERY Meal row: tokens, provenance,
// and the stamp timestamp.
//
// WHY THIS IS A SECOND SCRIPT AND NOT AN EDIT TO ws9-allergen-restamp.ts.
// That one is a historical record: it carries a frozen copy of the pre-D-WS9-211
// vocabulary so its output could attribute each removed token to the ingredient
// that used to trigger it, and its header documents the five defects it existed
// to fix. Rewriting it would destroy that record and make the earlier run
// unreproducible. This is a new pass with a different scope and a different
// output contract.
//
// WHAT CHANGED SINCE THAT RUN
//
//   1. SCOPE IS EVERY MEAL, not the public pool. Hans's ruling: "if this is all
//      server work and it's not costing AI calls, let's just have all the meals
//      have all the data." Measured 2026-09-04: 386 non-pool rows, ALL
//      user-owned, ALL unstamped, of which 351 would gain a non-empty stamp —
//      and the population is live, newest row three days old.
//
//      ⚠️ HONEST FRAMING: this half is CORRECTNESS-FOR-LATER, NOT A LIVE FIX.
//      Nothing allergen-filtered reads a user-owned meal today. The only hard
//      filter (store/allergenFilter.ts) runs only inside buildStoreShortlist,
//      whose pool predicate is isPublic:true, so a private meal is excluded
//      before the allergen clause is evaluated at all. It is done now because it
//      is free and because the day a cookbook or swap surface starts filtering,
//      the backfill would otherwise be discovered late. The POOL half below is
//      the live fix.
//
//   2. THE VOCABULARY GREW AGAIN (D-WS9-214). Processed products whose name
//      contains no allergen word: mayonnaise (egg, 136 meals — larger than every
//      defect the previous two rounds fixed combined), pizza dough (wheat, and
//      TWO PIZZAS WERE ON A LIVE GLUTEN-FREE SHELF), brioche (egg AND dairy),
//      beer (gluten), condensed cream soups, hummus, dashi, pesto, teriyaki,
//      hoisin, roti.
//
//   3. TWO NEW COLUMNS. allergenSources (token -> causing ingredient names) and
//      allergensStampedAt. See the migration for why the timestamp beats a
//      sentinel value.
//
// ⚠️ NO TEST DATABASE EXISTS (D-WS9-181). --apply writes to live data. The
// default is --dry-run and it must stay that way.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx scripts/ws9-d214-allergen-backfill.ts
//   pnpm --filter @workspace/api-server exec tsx scripts/ws9-d214-allergen-backfill.ts --apply

import { PrismaClient } from "@prisma/client";

import {
  ALLERGEN_TOKENS,
  deriveAllergensWithSources,
  explainAllergenMatches,
} from "../src/lib/allergens";
import { allergenTokensForUser } from "../src/lib/store/allergenFilter";

// The 11 fixed-list chips, mirroring kiwi/lib/domain.ts ALLERGIES_AND_AVOIDANCES.
// Labels only — every NUMBER derived from them below is computed, never typed.
const CHIPS = [
  "Dairy-free", "Gluten-free", "Nut-free", "Peanut-free", "Tree-nut-free",
  "Shellfish-free", "Egg-free", "Soy-free", "Wheat-free", "Sesame-free", "Fish-free",
] as const;

const prisma = new PrismaClient();

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

interface Row {
  id: string;
  title: string;
  sourceType: string;
  inPool: boolean;
  names: string[];
  before: string[];
  after: string[];
  sources: Record<string, string[]>;
  removed: string[];
  added: string[];
  wasStamped: boolean;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(
    `\nws9-d214-allergen-backfill — ${apply ? "APPLY (writes live data)" : "DRY-RUN (no writes)"}\n${"=".repeat(78)}`,
  );

  const meals = await prisma.meal.findMany({
    // NO where clause. Every Meal row, public or not, archived or not.
    select: {
      id: true,
      title: true,
      allergens: true,
      allergensStampedAt: true,
      sourceType: true,
      isPublic: true,
      isArchived: true,
      dishLinks: {
        select: {
          dish: {
            select: {
              dishIngredients: {
                select: { ingredient: { select: { displayName: true } } },
              },
            },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });

  const rows: Row[] = meals.map((m) => {
    const names = [
      ...new Set(
        m.dishLinks.flatMap((l) =>
          (l.dish?.dishIngredients ?? [])
            .map((d) => d.ingredient?.displayName)
            .filter((n): n is string => typeof n === "string"),
        ),
      ),
    ];
    const before = [...m.allergens].sort();
    const { tokens, sources } = deriveAllergensWithSources(names);
    return {
      id: m.id,
      title: m.title,
      sourceType: m.sourceType,
      inPool: m.isPublic && !m.isArchived,
      names,
      before,
      after: tokens,
      sources,
      removed: before.filter((t) => !tokens.includes(t)),
      added: tokens.filter((t) => !before.includes(t)),
      wasStamped: m.allergensStampedAt != null,
    };
  });

  const pool = rows.filter((r) => r.inPool);
  const nonPool = rows.filter((r) => !r.inPool);
  const tokenChanged = rows.filter((r) => !sameSet(r.before, r.after));
  const removals = tokenChanged.filter((r) => r.removed.length > 0);
  const additionsOnly = tokenChanged.filter(
    (r) => r.removed.length === 0 && r.added.length > 0,
  );
  const newlyStamped = tokenChanged.filter(
    (r) => r.before.length === 0 && r.after.length > 0,
  );
  const nowEmpty = tokenChanged.filter(
    (r) => r.after.length === 0 && r.before.length > 0,
  );
  // Every row is written: --apply force-stamps so allergensStampedAt means
  // "last evaluated against the vocabulary", not "last changed". See the note
  // on StampAllergensOptions.force in lib/allergens.ts.
  const metadataOnly = rows.filter(
    (r) => sameSet(r.before, r.after) && !r.wasStamped,
  );

  console.log(`\nscope: ALL Meal rows = ${rows.length}`);
  console.log(`  in pool (public, non-archived) : ${pool.length}`);
  console.log(`  not in pool                    : ${nonPool.length}`);
  console.log(
    `  carrying a stamp timestamp     : ${rows.filter((r) => r.wasStamped).length}`,
  );
  console.log(`  unstamped tokens before        : ${rows.filter((r) => !r.before.length).length}`);
  console.log(`  unstamped tokens after         : ${rows.filter((r) => !r.after.length).length}`);

  // ── per-token, split pool vs non-pool ──────────────────────────────────────
  // Split because the two halves mean different things: a pool delta is a
  // change to what real users are served TODAY; a non-pool delta is first-time
  // stamping of rows nothing filtered reads yet.
  const count = (set: Row[], t: string, which: "before" | "after") =>
    set.filter((r) => r[which].includes(t)).length;
  console.log(`\n── PER-TOKEN ──`);
  console.table(
    ALLERGEN_TOKENS.map((t) => ({
      token: t,
      "pool before": count(pool, t, "before"),
      "pool after": count(pool, t, "after"),
      "pool Δ": count(pool, t, "after") - count(pool, t, "before"),
      "other before": count(nonPool, t, "before"),
      "other after": count(nonPool, t, "after"),
      "other Δ": count(nonPool, t, "after") - count(nonPool, t, "before"),
    })),
  );

  console.log(`\n── BY DIRECTION ──`);
  console.log(`  token sets changed             : ${tokenChanged.length}`);
  console.log(`  REMOVALS (token taken away)    : ${removals.length}   <-- the dangerous direction`);
  console.log(`  additions only                 : ${additionsOnly.length}`);
  console.log(`  newly stamped (were empty)     : ${newlyStamped.length}`);
  console.log(`  became empty (were stamped)    : ${nowEmpty.length}`);
  // ⚠️ TWO DIFFERENT "metadata-only" POPULATIONS. They are not the same number
  // and conflating them in a report is how the reader concludes one is wrong.
  //   (a) previously-UNSTAMPED rows whose token set is still empty — they gain a
  //       stampedAt and become VISIBLE to allergic users for the first time.
  //   (b) EVERY row whose token set does not change — includes (a) plus the
  //       already-correct rows that are only being force-rewritten to refresh
  //       the timestamp. This is the one that matters for write volume.
  const unchangedTokens = rows.length - tokenChanged.length;
  console.log(`  (a) newly-visible, still token-empty : ${metadataOnly.length}  (were unstamped; gain stampedAt so the filter admits them)`);
  console.log(`  (b) ALL rows with unchanged tokens   : ${unchangedTokens}  (= ${rows.length} - ${tokenChanged.length}; includes (a) + force-refresh)`);

  const addByToken: Record<string, number> = {};
  for (const r of tokenChanged) for (const t of r.added) addByToken[t] = (addByToken[t] ?? 0) + 1;
  console.log(`  additions by token             : ${JSON.stringify(addByToken)}`);
  const remByToken: Record<string, number> = {};
  for (const r of removals) for (const t of r.removed) remByToken[t] = (remByToken[t] ?? 0) + 1;
  console.log(`  removals by token              : ${JSON.stringify(remByToken)}`);

  // ── the review gate ────────────────────────────────────────────────────────
  // ⚠️ REMOVALS SHOULD BE NEAR ZERO IN THIS PASS. D-WS9-214 added terms and
  // added no disqualifier that can fire on the existing catalog (the two new
  // ones guard `vegan mayo/brioche` and `root/ginger beer`, none of which exist
  // as ingredient names today). A LARGE REMOVAL COUNT IS A STOP, NOT A SURPRISE:
  // it would mean a term was dropped or a disqualifier over-matched, and the
  // right response is to fix the vocabulary, not to approve the run.
  console.log(`\n── FULL REMOVAL LIST (${removals.length}) — the review gate ──`);
  if (removals.length === 0) {
    console.log(`  (none — expected for this pass: additive vocabulary change)`);
  }
  removals.forEach((r, i) => {
    const why = explainAllergenMatches(r.names);
    console.log(`${String(i + 1).padStart(3)}. [${r.sourceType}${r.inPool ? "/pool" : ""}] ${r.title}`);
    console.log(`     ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
    for (const t of r.removed) {
      const e = why[t];
      const cause = e
        ? `matched: ${e.matched.join(" / ") || "(nothing)"}  |  disqualified: ${e.disqualified.join(" / ") || "(nothing)"}`
        : "no ingredient name matches this token's terms at all — the term was REMOVED from the vocabulary";
      console.log(`     removed ${t}: ${cause}`);
    }
    if (r.added.length) console.log(`     added:   ${JSON.stringify(r.added)}`);
  });

  if (nowEmpty.length) {
    console.log(`\n⚠️  BECAME EMPTY (${nowEmpty.length}) — was stamped, now derives to nothing:`);
    nowEmpty.forEach((r) => console.log(`     [${r.inPool ? "pool" : "other"}] ${r.title}  was ${JSON.stringify(r.before)}`));
  }

  // A sample of first-time stamps, so the addition side is inspectable too and
  // not just a number.
  console.log(`\n── SAMPLE OF NEW STAMPS (first 15 of ${newlyStamped.length}) ──`);
  newlyStamped.slice(0, 15).forEach((r) => {
    const causes = r.after.map((t) => `${t}<-${r.sources[t].join(",")}`).join("  |  ");
    console.log(`  [${r.inPool ? "pool" : "other"}] ${r.title}`);
    console.log(`     ${causes}`);
  });

  // ── SHELF REACH, per allergy chip ──────────────────────────────────────────
  //
  // ⚠️ EVERY NUMBER IN THIS TABLE IS COMPUTED HERE AND PRINTED. Do not retype it
  // into a report, do not re-group it, do not collapse it into prose. A summary
  // table typed by hand beside a computed one is a second source of truth, and
  // this block has already produced three tables that disagreed with their own
  // data — every time the data was right and the retyping was wrong.
  //
  // MEASURED (counted directly, by meal id):
  //   before  — admitted under TODAY's live rule: a stamp timestamp exists AND
  //             the stored tokens do not intersect the chip's tokens.
  //   after   — admitted after this backfill: the freshly DERIVED tokens do not
  //             intersect. No timestamp test: the backfill stamps every row.
  //   gained  — in `after` and not in `before`.
  //   lost    — in `before` and not in `after`.
  // DERIVED (printed only as an arithmetic self-check):
  //   check   — before + gained - lost. Must equal `after`; "MISMATCH" if not.
  //
  // ⚠️ MATCHED BY MEAL ID, NOT BY TITLE. The catalog contains duplicate titles
  // across sourceTypes (the same dish generated by the batch harness and again
  // by a live write-back), so a title-keyed set collapses distinct rows and
  // silently under-counts. That is exactly what produced the off-by-one in the
  // first version of this table.
  const poolRows = rows.filter((r) => r.inPool);
  console.log(`\n── SHELF REACH BY CHIP (pool rows only, n=${poolRows.length}) ──`);
  console.table(
    CHIPS.map((chip) => {
      const tok = allergenTokensForUser([chip]);
      const before = new Set(
        poolRows.filter((r) => r.wasStamped && !r.before.some((a) => tok.includes(a))).map((r) => r.id),
      );
      const after = new Set(
        poolRows.filter((r) => !r.after.some((a) => tok.includes(a))).map((r) => r.id),
      );
      const gained = [...after].filter((id) => !before.has(id)).length;
      const lost = [...before].filter((id) => !after.has(id)).length;
      const check = before.size + gained - lost;
      return {
        chip,
        "eligible before": before.size,
        "eligible after": after.size,
        "newly reachable": gained,
        "newly excluded": lost,
        check: check === after.size ? "ok" : `MISMATCH ${check}`,
      };
    }),
  );

  // Why `newly reachable` is near-identical across chips: it is dominated by the
  // previously-unstamped pool rows, which were excluded from EVERY chip at once.
  // Printed rather than asserted in prose.
  const darkPool = poolRows.filter((r) => !r.wasStamped);
  console.log(`\n  previously-unstamped pool rows (excluded from every chip): ${darkPool.length}`);
  console.log(`    of those, still token-empty after : ${darkPool.filter((r) => !r.after.length).length}`);
  const darkGain: Record<string, number> = {};
  for (const r of darkPool) for (const t of r.after) darkGain[t] = (darkGain[t] ?? 0) + 1;
  console.log(`    of those, tokens GAINED by token  : ${JSON.stringify(darkGain)}`);

  // The chips whose reach falls. Named, with the causing ingredient, because a
  // reach loss on a safety filter is the fix landing and should be legible.
  console.log(`\n── LARGEST REACH LOSS, itemised ──`);
  for (const chip of CHIPS) {
    const tok = allergenTokensForUser([chip]);
    const lost = poolRows.filter(
      (r) => r.wasStamped && !r.before.some((a) => tok.includes(a)) && r.after.some((a) => tok.includes(a)),
    );
    if (lost.length === 0) continue;
    const causes: Record<string, number> = {};
    for (const r of lost) {
      for (const t of r.after.filter((a) => tok.includes(a))) {
        for (const name of r.sources[t] ?? []) causes[name] = (causes[name] ?? 0) + 1;
      }
    }
    const top = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  ${chip.padEnd(16)} -${String(lost.length).padStart(4)}   top causes: ${top.map(([n, c]) => `${n} (${c})`).join(", ")}`);
  }

  if (!apply) {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`DRY-RUN — nothing written.`);
    console.log(`  ${tokenChanged.length} rows would change TOKENS.`);
    console.log(`  ${rows.length} rows would be written in total (every row gains sources + stampedAt).`);
    console.log(`Re-run with --apply to write.`);
    return;
  }

  console.log(`\n${"=".repeat(78)}\nAPPLYING to ${rows.length} rows...`);
  let written = 0;
  const stampedAt = new Date();
  for (const r of rows) {
    await prisma.meal.update({
      where: { id: r.id },
      data: {
        allergens: r.after,
        allergenSources: r.sources,
        // One timestamp for the whole pass, not per-row now(): the pass is the
        // unit of "stamped under vocabulary X", and a range of timestamps across
        // a single run makes the "everything older than the pizza-dough fix"
        // query need a window instead of a comparison.
        allergensStampedAt: stampedAt,
      },
    });
    written++;
    if (written % 200 === 0) console.log(`  ...${written}/${rows.length}`);
  }
  console.log(`APPLIED. ${written} rows updated.`);
  console.log(`Re-run WITHOUT --apply to confirm: expect "0 rows would change TOKENS".`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
